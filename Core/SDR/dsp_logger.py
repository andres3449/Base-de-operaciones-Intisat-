# -*- coding: utf-8 -*-
"""
DspLogger — per-session DSP/RF diagnostic log.

Writes to logs/dsp_YYYY-MM-DD_HH-MM-SS.log capturing:
  - All C backend stdout: phase selection, sync hamming distances,
    burst state transitions, M&M clock recovery events
  - Every decoded packet: RSSI, freq_error_hz, power_ema, sync bit errors, len
  - Application-level events: session start/stop, burst begin/end

How to read the log:
  [C] [dsp] Burst ended: 688 bits, hamming=1
    → A burst was received but dropped because the sync word had 1 bit error.
      If this is consistent, SYNC_MAX_BIT_ERRORS=0 is too strict.
  [C] [CORR] bits=96 shift_reg=0xBDE62A7E hamming=2
    → Correlator snapshot: 2 bits wrong in sync window mid-burst.
  PKT #  42 | rssi=+xx.xdB  freq_err=  +3200Hz  pwr_ema=1.23e-04  sync_err=0  len=64B
    → Successfully decoded packet with RF quality metrics.
"""

import datetime
import os


class DspLogger:
    def __init__(self, log_dir: str):
        os.makedirs(log_dir, exist_ok=True)
        now = datetime.datetime.now()
        ts = now.strftime("%Y-%m-%d_%H-%M-%S")
        self._path = os.path.join(log_dir, f"dsp_{ts}.log")
        self._file = open(self._path, "w", encoding="utf-8", buffering=1)
        self._pkt_count = 0
        self._start = now
        self._file.write(
            f"=== INTISAT DSP diagnostics started {now.strftime('%Y-%m-%d %H:%M:%S')} ===\n"
            f"  Cada linea tiene prefijo [HH:MM:SS.mmm]\n"
            f"  [C] = salida directa del backend C (DSP pipeline)\n"
            f"  PKT = paquete decodificado con metricas RF\n"
            f"  [EVT] = evento de sesion (burst start/end, etc.)\n"
            f"=========================================================\n"
        )
        self._file.flush()

    def _ts(self) -> str:
        return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]

    def log_c(self, line: str) -> None:
        """Log one line from the C backend stdout as-is."""
        self._file.write(f"[{self._ts()}] [C] {line}\n")
        self._file.flush()

    def log_packet(self, pkt) -> None:
        """Log a decoded packet with all RF quality fields.

        pkt must have: rssi_estimate_db, freq_error_hz, power_ema,
                       bit_errors, raw_bytes
        """
        self._pkt_count += 1
        freq_err = getattr(pkt, "freq_error_hz", 0.0)
        raw = pkt.raw_bytes
        # Show first 4 bytes as hex — enough to identify packet type
        hdr = raw[:4].hex().upper() if len(raw) >= 4 else raw.hex().upper()
        self._file.write(
            f"[{self._ts()}] PKT #{self._pkt_count:5d}"
            f"  rssi={pkt.rssi_estimate_db:+6.1f}dB"
            f"  freq_err={freq_err:+8.0f}Hz"
            f"  pwr={pkt.power_ema:.2e}"
            f"  serr={pkt.bit_errors}"
            f"  len={len(raw):3d}B"
            f"  hdr={hdr}\n"
        )
        self._file.flush()

    def log_event(self, msg: str) -> None:
        """Log an application-level event."""
        ts = self._ts()
        for line in msg.splitlines():
            self._file.write(f"[{ts}] [EVT] {line}\n")
        self._file.flush()

    @property
    def path(self) -> str:
        return self._path

    def close(self) -> None:
        elapsed = (datetime.datetime.now() - self._start).total_seconds()
        self._file.write(
            f"=========================================================\n"
            f"=== DSP session ended — {self._pkt_count} pkts decoded in {elapsed:.0f}s ===\n"
        )
        self._file.close()
