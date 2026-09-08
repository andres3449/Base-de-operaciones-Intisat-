# -*- coding: utf-8 -*-
"""
INTISAT — Burst Mode Image Assembler

Handles the ground-station side of the burst selective-repeat ARQ protocol
(pktTypes 0x71..0x74) and emits the correct responses (0x72, 0x75, 0x76, 0x77).

Reliability:
  - NACK_INITIAL_DELAY_MS: satellite needs ~100 ms after BURST_END to enter RX.
    GS delays this long before sending the first NACK so it lands in the RX window.
  - NACK_RETRIES × NACK_RETRY_MS: retry the same NACK inside the satellite's
    BURST_NACK_TIMEOUT_MS = 8000 ms window.
  - MAX_NACK_ROUNDS = 7: matches satellite BURST_MAX_ROUNDS = 7.
  - Satellite sends each missing packet BURST_RETX_COUNT = 2 times per round.
  - BURST_FALLBACK_THRESHOLD = 30: when ≤30 packets remain, satellite switches to
    handshake mode (burst_handshakeRetransmit): sends each missing packet one by one
    and waits for BURST_DATA_ACK (0x77) with the matching seq_num before proceeding.
    GS must ACK each packet individually; completion is detected in-band (no 0x76 sent).
  - image_ready is ONLY emitted when all packets are received (100 %).
  - RS FEC: RS(96,88) over GF(2^8), poly 0x11D, alpha=2, roots alpha^0..alpha^7.
    When BURST_START flags bit0=1, each BURST_DATA carries 88 data bytes + 8 RS parity
    bytes. Up to 4 byte-errors per packet are corrected locally before NACKing.
"""

import math
import struct
import time as _time

from PyQt5.QtCore import QObject, pyqtSignal, QTimer


# ─── RS(96, 88) decoder ──────────────────────────────────────────────────────
# Primitive poly: x^8 + x^4 + x^3 + x^2 + 1 = 0x11D, alpha=2, roots alpha^0..alpha^7.
# Systematic format: [data[88] | parity[8]], parity[0] = coeff of x^7 of remainder.

_GF_POLY_RS = 0x11D
_RS_N, _RS_K, _RS_T, _RS_NSYM = 96, 88, 4, 8


def _build_gf_rs():
    exp = bytearray(512)
    log = bytearray(256)
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x = (x << 1) ^ (_GF_POLY_RS if x & 0x80 else 0)
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log


_RS_EXP, _RS_LOG = _build_gf_rs()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _RS_EXP[_RS_LOG[a] + _RS_LOG[b]]


def _gf_inv(a: int) -> int:
    return _RS_EXP[255 - _RS_LOG[a]]


def _poly_eval_ld(poly_ld: list, x: int) -> int:
    """Evaluate polynomial (low-degree-first) at x in GF(2^8)."""
    result = 0
    xi = 1
    for c in poly_ld:
        result ^= _gf_mul(c, xi)
        xi = _gf_mul(xi, x)
    return result


def _rs_syndromes(codeword: bytearray) -> list:
    """S_i = c(alpha^i) for i=0..7. codeword is high-degree-first (96 bytes)."""
    result = []
    for i in range(_RS_NSYM):
        ai = _RS_EXP[i]
        s = 0
        for b in codeword:
            s = _gf_mul(s, ai) ^ b  # Horner
        result.append(s)
    return result


def _rs_berlekamp_massey(syndromes: list) -> list:
    """Returns error locator polynomial, low-degree-first, sigma[0]=1."""
    C = [1]
    B = [1]
    L = 0
    m = 1
    b = 1
    for n in range(_RS_NSYM):
        d = syndromes[n]
        for i in range(1, L + 1):
            if i < len(C):
                d ^= _gf_mul(C[i], syndromes[n - i])
        if d == 0:
            m += 1
        elif 2 * L <= n:
            T = C[:]
            factor = _gf_mul(d, _gf_inv(b))
            xmB = [0] * m + [_gf_mul(factor, c) for c in B]
            while len(C) < len(xmB):
                C.append(0)
            for i in range(len(xmB)):
                C[i] ^= xmB[i]
            L, B, b, m = n + 1 - L, T, d, 1
        else:
            factor = _gf_mul(d, _gf_inv(b))
            xmB = [0] * m + [_gf_mul(factor, c) for c in B]
            while len(C) < len(xmB):
                C.append(0)
            for i in range(len(xmB)):
                C[i] ^= xmB[i]
            m += 1
    return C


def rs_decode(data88: bytes, parity8: bytes):
    """
    RS(96,88) decode.

    Returns (corrected_data: bytes, nerr: int) where nerr is the number of
    byte-errors corrected (0 = clean packet, no errors).
    Returns (None, nerr) if the packet has more than 4 byte-errors and cannot
    be corrected.
    """
    cw = bytearray(data88) + bytearray(parity8)
    syn = _rs_syndromes(cw)

    if all(s == 0 for s in syn):
        return bytes(data88), 0

    sigma_ld = _rs_berlekamp_massey(syn)
    nerr = len(sigma_ld) - 1
    if nerr > _RS_T:
        return None, nerr

    # Chien search — evaluate sigma at alpha^(-j) for j=0..n-1.
    # Root at j → error at array index n-1-j, locator value X_k = alpha^j.
    err_pos = []
    for j in range(_RS_N):
        # _RS_EXP[255] == _RS_EXP[0] == 1 = alpha^(-0), so no special case needed.
        if _poly_eval_ld(sigma_ld, _RS_EXP[255 - j]) == 0:
            err_pos.append((_RS_N - 1 - j, j))

    if len(err_pos) != nerr:
        return None, nerr

    # Error evaluator: Omega = sigma * S mod x^8 (low-degree-first)
    omega_ld = [0] * _RS_NSYM
    for i in range(_RS_NSYM):
        for jj in range(min(i + 1, len(sigma_ld))):
            omega_ld[i] ^= _gf_mul(sigma_ld[jj], syn[i - jj])

    # Formal derivative of sigma in GF(2): odd-degree terms only
    sigma_prime_ld = [0] * max(1, len(sigma_ld) - 1)
    for j in range(len(sigma_prime_ld)):
        if j % 2 == 0 and j + 1 < len(sigma_ld):
            sigma_prime_ld[j] = sigma_ld[j + 1]

    # Forney: e_k = X_k * Omega(X_k^-1) / sigma'(X_k^-1)
    result = bytearray(cw)
    for pos, j_k in err_pos:
        x_k_inv = _RS_EXP[255 - j_k]
        omega_val = _poly_eval_ld(omega_ld, x_k_inv)
        sigma_p_val = _poly_eval_ld(sigma_prime_ld, x_k_inv)
        if sigma_p_val == 0:
            return None, nerr
        result[pos] ^= _gf_mul(_RS_EXP[j_k], _gf_mul(omega_val, _gf_inv(sigma_p_val)))

    if any(s != 0 for s in _rs_syndromes(result)):
        return None, nerr

    return bytes(result[:_RS_K]), nerr


# ─── Assembler ────────────────────────────────────────────────────────────────

class BurstImageAssembler(QObject):

    image_ready       = pyqtSignal(bytes)        # 100 % complete only
    image_partial     = pyqtSignal(bytes, int)   # progressive preview
    image_progress    = pyqtSignal(int, int)     # (received_bytes, total_bytes)
    image_error       = pyqtSignal(str)          # failure shown in UI
    log_message       = pyqtSignal(str)          # debug → GUI console
    command_requested = pyqtSignal(int, bytes)   # (pkt_type, payload)
    burst_started     = pyqtSignal()             # new burst — clear previous image

    TIMEOUT_MS            = 60000
    PARTIAL_INTERVAL_MS   = 250
    MAX_NACK_ROUNDS       = 7
    MAX_BURST_END_TOTAL   = 21

    NACK_INITIAL_DELAY_MS    = 200
    NACK_RETRIES             = 3
    NACK_RETRY_MS            = 1500
    # Total NACK window: 200 + 2×1500 = 3200 ms < BURST_NACK_TIMEOUT_MS = 8000 ms
    BURST_FALLBACK_THRESHOLD = 10   # must match BURST_FALLBACK_THRESHOLD in burst_tx.h

    def __init__(self, parent=None):
        super().__init__(parent)
        self._expected_size      = 0
        self._total_pkts         = 0
        self._payload_size       = 88
        self._rs_enabled         = False
        self._rs_parity_size     = 0
        self._rs_corrected_count = 0
        self._rs_failed_count    = 0
        self._received_pkts      = set()
        self._buffer             = bytearray(60000)
        self._active             = False
        self._last_partial_time  = 0.0
        self._start_time         = 0.0

        self._nack_rounds        = 0
        self._burst_end_count    = 0
        self._round_start_count  = 0
        self._round_stats: list  = []

        self._pending_nack: bytes = b""
        self._nack_retries_left   = 0
        self._handshake_mode      = False

        self._timeout = QTimer(self)
        self._timeout.setSingleShot(True)
        self._timeout.setInterval(self.TIMEOUT_MS)
        self._timeout.timeout.connect(self._on_timeout)

        self._nack_retry_timer = QTimer(self)
        self._nack_retry_timer.setSingleShot(False)
        self._nack_retry_timer.setInterval(self.NACK_RETRY_MS)
        self._nack_retry_timer.timeout.connect(self._retry_nack)

        self._nack_delay_timer = QTimer(self)
        self._nack_delay_timer.setSingleShot(True)
        self._nack_delay_timer.setInterval(self.NACK_INITIAL_DELAY_MS)
        self._nack_delay_timer.timeout.connect(self._send_nack_first)

    @property
    def is_active(self) -> bool:
        return self._active

    def reset(self):
        self._active             = False
        self._expected_size      = 0
        self._total_pkts         = 0
        self._received_pkts.clear()
        self._nack_rounds        = 0
        self._burst_end_count    = 0
        self._round_start_count  = 0
        self._round_stats.clear()
        self._pending_nack       = b""
        self._nack_retries_left  = 0
        self._handshake_mode     = False
        self._rs_enabled         = False
        self._rs_parity_size     = 0
        self._rs_corrected_count = 0
        self._rs_failed_count    = 0
        self._timeout.stop()
        self._nack_retry_timer.stop()
        self._nack_delay_timer.stop()

    # ── packet router ─────────────────────────────────────────────────────────

    def process_packet(self, pkt_type: int, data: bytes):
        if pkt_type == 0x71:
            self._handle_start(data)
        elif pkt_type == 0x73:
            self._handle_data(data)
        elif pkt_type == 0x74:
            self._handle_end(data)

    # ── handlers ──────────────────────────────────────────────────────────────

    def _handle_start(self, data: bytes):
        if len(data) < 8:
            return
        self._expected_size = struct.unpack(">I", data[0:4])[0]
        self._total_pkts    = struct.unpack(">H", data[4:6])[0]

        if len(data) >= 9:
            # New 9-byte format: flags(1) + payloadSize(1) + rs_parity_size(1)
            flags                = data[6]
            self._rs_enabled     = bool(flags & 0x01)
            self._payload_size   = data[7]
            self._rs_parity_size = data[8]
        else:
            # Old 8-byte format (backward compat): payloadSize as uint16, no RS
            self._rs_enabled     = False
            self._rs_parity_size = 0
            self._payload_size   = struct.unpack(">H", data[6:8])[0]

        self._rs_corrected_count = 0
        self._rs_failed_count    = 0
        self._buffer             = bytearray(max(60000, self._expected_size))
        self._received_pkts.clear()
        self._active             = True
        self._last_partial_time  = 0.0
        self._nack_rounds        = 0
        self._burst_end_count    = 0
        self._round_start_count  = 0
        self._round_stats.clear()
        self._pending_nack       = b""
        self._nack_retries_left  = 0
        self._handshake_mode     = False
        self._start_time         = _time.perf_counter()
        self._nack_retry_timer.stop()
        self._nack_delay_timer.stop()

        self.burst_started.emit()
        rs_tag = " +RS(96,88)" if self._rs_enabled else ""
        self.log_message.emit(
            f"[Burst] START — {self._total_pkts} pkts × {self._payload_size}B{rs_tag} "
            f"= {self._expected_size / 1024:.1f} KB imagen"
        )
        self._timeout.start()
        self.image_progress.emit(0, self._expected_size)
        self.command_requested.emit(0x72, b"")

    def _handle_data(self, data: bytes):
        if not self._active or len(data) < 2:
            return

        self._nack_retry_timer.stop()

        seq_num = struct.unpack(">H", data[0:2])[0]

        if self._rs_enabled:
            min_len = 2 + _RS_K + self._rs_parity_size
            if len(data) < min_len:
                return
            data88  = data[2:2 + _RS_K]
            parity8 = data[2 + _RS_K:2 + _RS_K + self._rs_parity_size]
            decoded, nerr = rs_decode(data88, parity8)
            if decoded is None:
                self._rs_failed_count += 1
                self.log_message.emit(
                    f"[Burst] RS #{seq_num}: >{_RS_T} errores — NACK"
                )
                self._timeout.start()
                return
            if nerr > 0:
                self._rs_corrected_count += 1
                self.log_message.emit(
                    f"[Burst] RS #{seq_num}: {nerr} byte-error(s) corregido(s)"
                )
            img_data = decoded
        else:
            img_data = data[2:]

        offset = seq_num * self._payload_size
        dlen   = len(img_data)
        if offset + dlen <= len(self._buffer):
            self._buffer[offset:offset + dlen] = img_data
            self._received_pkts.add(seq_num)

        if self._handshake_mode:
            self.command_requested.emit(0x77, struct.pack(">H", seq_num))
            if len(self._received_pkts) == self._total_pkts:
                self._finish_ok(send_complete=False)
                return

        self._timeout.start()

        received_bytes = min(len(self._received_pkts) * self._payload_size,
                             self._expected_size)
        self.image_progress.emit(received_bytes, self._expected_size)

        now = _time.perf_counter()
        if (now - self._last_partial_time) * 1000 >= self.PARTIAL_INTERVAL_MS:
            self._last_partial_time = now
            highest = max(self._received_pkts) if self._received_pkts else 0
            end_idx = min((highest + 1) * self._payload_size, self._expected_size)
            self.image_partial.emit(bytes(self._buffer[:end_idx]), self._expected_size)

    def _handle_end(self, data: bytes):
        if not self._active or len(data) < 2:
            return

        self._nack_retry_timer.stop()
        self._nack_delay_timer.stop()

        received_now  = len(self._received_pkts)
        missing_after = self._total_pkts - received_now

        expected_this = (self._total_pkts if self._nack_rounds == 0
                         else self._total_pkts - self._round_start_count)
        received_this = received_now - self._round_start_count
        failed_this   = expected_this - received_this

        self._round_stats.append(
            f"  Ronda {self._nack_rounds}: "
            f"sat envió {expected_this}  |  "
            f"GS recibió {received_this}  |  "
            f"fallaron {failed_this}  |  "
            f"total {received_now}/{self._total_pkts}"
        )
        self._round_start_count = received_now

        if missing_after == 0:
            self._finish_ok()
        else:
            self._burst_end_count += 1

            if received_this > 0:
                self._nack_rounds += 1

            too_many_ends = self._burst_end_count > self.MAX_BURST_END_TOTAL
            too_many_real = self._nack_rounds > self.MAX_NACK_ROUNDS
            if too_many_ends or too_many_real:
                reason = (f"se agotaron {self.MAX_BURST_END_TOTAL} intentos sin respuesta"
                          if too_many_ends else
                          f"se agotaron {self.MAX_NACK_ROUNDS} rondas con retransmisión")
                self._finish_fail(f"{reason}, faltan {missing_after} pkts irrecuperables")
            else:
                self._handshake_mode = missing_after <= self.BURST_FALLBACK_THRESHOLD
                if self._handshake_mode:
                    self.log_message.emit(
                        f"[Burst] END#{self._burst_end_count} ronda {self._nack_rounds}/{self.MAX_NACK_ROUNDS}: "
                        f"faltan {missing_after} pkts — HANDSHAKE (ACK por paquete) "
                        f"en {self.NACK_INITIAL_DELAY_MS}ms..."
                    )
                    self._nack_retries_left = 0
                else:
                    extra = 2 if received_this == 0 else 0
                    retries = self.NACK_RETRIES - 1 + extra
                    warn = "  ⚠ reintento sat" if received_this == 0 else ""
                    self.log_message.emit(
                        f"[Burst] END#{self._burst_end_count} ronda {self._nack_rounds}/{self.MAX_NACK_ROUNDS}: "
                        f"faltan {missing_after} pkts — NACK en {self.NACK_INITIAL_DELAY_MS}ms "
                        f"(×{retries + 1}){warn}"
                    )
                    self._nack_retries_left = retries
                self._pending_nack = self._build_nack_payload()
                self._nack_delay_timer.start()
                self._timeout.start()

    # ── NACK send / retry ─────────────────────────────────────────────────────

    def _send_nack_first(self):
        """Called NACK_INITIAL_DELAY_MS after BURST_END — satellite is now in RX."""
        if not self._active:
            return
        self.command_requested.emit(0x75, self._pending_nack)
        if self._nack_retries_left > 0:
            self._nack_retry_timer.start()

    def _retry_nack(self):
        if not self._active or self._nack_retries_left <= 0:
            self._nack_retry_timer.stop()
            return
        self._nack_retries_left -= 1
        self.command_requested.emit(0x75, self._pending_nack)
        if self._nack_retries_left <= 0:
            self._nack_retry_timer.stop()

    # ── finish paths ──────────────────────────────────────────────────────────

    def _finish_ok(self, send_complete: bool = True):
        elapsed = _time.perf_counter() - self._start_time
        self._round_stats.append(
            f"  FINAL: {self._total_pkts}/{self._total_pkts} — "
            f"COMPLETO en {elapsed:.1f}s"
        )
        self._emit_summary("COMPLETO ✓")
        self._timeout.stop()
        self._nack_retry_timer.stop()
        self._nack_delay_timer.stop()
        self._active = False
        if send_complete:
            self.command_requested.emit(0x76, b"")
        self.image_ready.emit(bytes(self._buffer[:self._expected_size]))

    def _finish_fail(self, reason: str):
        elapsed = _time.perf_counter() - self._start_time
        n = len(self._received_pkts)
        self._round_stats.append(
            f"  FINAL: {n}/{self._total_pkts} — FALLIDO en {elapsed:.1f}s"
        )
        self._emit_summary(f"FALLIDO — {reason}")
        self.command_requested.emit(0x76, b"")
        self.image_error.emit(
            f"Burst fallido tras {self.MAX_NACK_ROUNDS} rondas — "
            f"imagen descartada ({n}/{self._total_pkts} pkts)"
        )
        self.reset()

    # ── helpers ───────────────────────────────────────────────────────────────

    def _emit_summary(self, result: str):
        n       = len(self._received_pkts)
        pct     = n * 100.0 / self._total_pkts if self._total_pkts else 0
        size    = self._expected_size / 1024
        elapsed = _time.perf_counter() - self._start_time
        lines = [
            "[Burst] ══════ RESUMEN BURST ══════",
            f"  Resultado : {result}",
            f"  Archivo   : {size:.1f} KB  ({self._expected_size} bytes)",
            f"  Duración  : {elapsed:.1f}s",
            f"  Total     : {self._total_pkts} paquetes esperados",
        ]
        if self._rs_enabled:
            lines.append(
                f"  RS FEC    : {self._rs_corrected_count} pkts corregidos, "
                f"{self._rs_failed_count} pkts fallidos (NACKed)"
            )
        lines += self._round_stats + [
            f"  TASA      : {n}/{self._total_pkts}  ({pct:.1f}%)",
            "[Burst] ════════════════════════════",
        ]
        for line in lines:
            self.log_message.emit(line)

    def _build_nack_payload(self) -> bytes:
        missing = [i for i in range(self._total_pkts) if i not in self._received_pkts]
        if len(missing) <= self.BURST_FALLBACK_THRESHOLD:
            # Seq-list: header = (count | 0x8000), then 2B per seq number.
            payload = struct.pack(">H", len(missing) | 0x8000)
            for seq in missing:
                payload += struct.pack(">H", seq)
            return payload
        else:
            bitmap_len = math.ceil(self._total_pkts / 8)
            bitmap = bytearray(bitmap_len)
            for seq in missing:
                bitmap[seq // 8] |= (1 << (seq % 8))
            return struct.pack(">H", self._total_pkts) + bytes(bitmap)

    def _on_timeout(self):
        if not self._active:
            return
        n = len(self._received_pkts)
        self._nack_retry_timer.stop()
        self._nack_delay_timer.stop()
        self._round_stats.append(
            f"  Ronda {self._nack_rounds}: TIMEOUT — "
            f"sat dejó de responder con {n}/{self._total_pkts} recibidos"
        )
        elapsed = _time.perf_counter() - self._start_time
        self._round_stats.append(
            f"  FINAL: {n}/{self._total_pkts} — TIMEOUT en {elapsed:.1f}s"
        )
        self._emit_summary(f"TIMEOUT ({n}/{self._total_pkts} paquetes)")
        self.image_error.emit(
            f"Burst: timeout — imagen descartada ({n}/{self._total_pkts} pkts)"
        )
        self.reset()
