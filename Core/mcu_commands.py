# -*- coding: utf-8 -*-
"""
INTISAT — MCU/UART command dispatcher.

Extracted from GUI/main_window.py::_handle_mcu_command (the UART/MCU branch
only — RF/LimeSDR commands stay in GUI/pages/comms.py, out of scope here)
so the exact same command syntax and framing can be reused from a process
with no GUI (headless_receiver.py's scheduler) without duplicating the
parsing logic. Behavior is unchanged from the console: same command names,
same argument parsing, same byte/frame construction.

Callbacks are injected so this has no dependency on Qt widgets or a running
GUI — only Core.uart_receiver.UartReceiver.send_command /
send_command_with_payload are required on the caller's side.
"""

import datetime
from typing import Callable, Optional

from Core.ops_protocol import OPS_PACKET_TYPE, build_ops_frame

# Single-byte command mapping (text → 0xCx byte) — matches main_window.py's
# _MCU_CMD_TABLE exactly.
_MCU_CMD_TABLE = {
    "LINK":         (0xC0, "Starting link sequence"),
    "PHOTO":        (0xC1, "Requesting photo capture"),
    "STATUS":       (0xC2, "Requesting status"),
    "TELEM":        (0xC9, "Requesting single telemetry frame"),
    "TELEM_STREAM": (0xCA, "Starting telemetry stream"),
    "STOP":         (0xCB, "Stopping telemetry stream"),
    "SAVE":         (0xC4, "Capture & save to SD"),
    "LIST":         (0xC5, "Listing last 5 files"),
    "LIST ALL":     (0xC6, "Listing all files"),
    "BURST":        (0x70, "Requesting burst photo capture"),
}

# OBC Telecommands — built as OPS v1.0 frames (AX.25 type 0xA5) — matches
# main_window.py's _TC_MAP exactly.
_TC_MAP = {
    "FULL_TLM":        (0x42, b"",  "TC_REQ_FULL_TLM"),
    "OBC_BEACON":      (0x43, b"",  "TC_REQ_BEACON"),
    "FORCE_SAFE":      (0x44, b"",  "TC_FORCE_SAFE"),
    "RESET_FAULTS":    (0x45, b"",  "TC_RESET_FAULT_CNTRS"),
    "EPS_ANOMALY":     (0x47, b"",  "TC_EPS_REQ_ANOMALY"),
    "HEALTH_DEFAULTS": (0x4B, b"",  "TC_RESTORE_HEALTH_DEFAULTS"),
    "PAYLOAD ON":      (0x60, b"",  "TC_PAYLOAD_ENABLE(ON)"),
    "PAYLOAD OFF":     (0x60, b"",  "TC_PAYLOAD_ENABLE(OFF)"),
}

# Documental — para que la web arme un menu/ayuda. No reemplaza la
# validacion real, que sigue viviendo en McuCommandDispatcher.dispatch_text.
COMMAND_REFERENCE = (
    [{"name": name, "syntax": name, "description": desc}
     for name, (_, desc) in _MCU_CMD_TABLE.items()]
    + [{"name": name, "syntax": name, "description": desc}
       for name, (_, _, desc) in _TC_MAP.items()]
    + [
        {"name": "GET", "syntax": "GET <archivo>", "description": "Descargar archivo del MCU"},
        {"name": "DEL", "syntax": "DEL <archivo>", "description": "Borrar archivo del MCU"},
        {"name": "SET_HEALTH", "syntax": "SET_HEALTH <param_id> <valor>", "description": "TC_UPDATE_HEALTH_PARAM"},
        {"name": "TIME_SYNC", "syntax": "TIME_SYNC [dist_km]", "description": "Sincronizar hora del OBC"},
        {"name": "READEPS", "syntax": "READEPS <param_id>", "description": "Leer parametro EPS"},
        {"name": "WRITEEPS", "syntax": "WRITEEPS <param_id> <valor>", "description": "Escribir parametro EPS"},
        {"name": "BER_TEST", "syntax": "BER_TEST [n_paquetes] [RS]", "description": "Test de tasa de error de bit"},
        {"name": "SET_POWER", "syntax": "SET_POWER <nivel 0-127>", "description": "TC_SET_POWER (via OBC)"},
        {"name": "OVERRIDE_POWER", "syntax": "OVERRIDE_POWER <nivel 0-127>", "description": "TC_OVERRIDE_POWER (directo a UHF)"},
        {"name": "READ_UHF", "syntax": "READ_UHF <id 0-18>", "description": "TC_READ_UHF"},
        {"name": "CMD", "syntax": "CMD:<hex>", "description": "Comando RAW de 1 byte"},
    ]
)


def _crc8(data: bytes) -> int:
    """CRC-8 (poly=0x07, init=0x00) — matches STM32 UHF firmware."""
    crc = 0x00
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


class McuCommandDispatcher:
    """Parses and sends the same MCU/UART console commands as the PyQt5 GUI.

    Parameters
    ----------
    send_byte : (int) -> None
        Sends a single command byte (maps to UartReceiver.send_command).
    send_payload : (int, bytes) -> None
        Sends a command byte + payload (maps to
        UartReceiver.send_command_with_payload).
    log : (str) -> None
        Receives human-readable status/error lines (maps to console/print).
    on_ber_mode : (bool) -> None, optional
        Called when a BER_TEST toggles Reed-Solomon mode — in the GUI this
        updates a display flag on the comms page; no-op by default since
        headless mode has no display.
    """

    def __init__(
        self,
        send_byte: Callable[[int], None],
        send_payload: Callable[[int, bytes], None],
        log: Callable[[str], None],
        on_ber_mode: Optional[Callable[[bool], None]] = None,
    ):
        self._send_byte = send_byte
        self._send_payload = send_payload
        self._log = log
        self._on_ber_mode = on_ber_mode or (lambda rs_mode: None)
        self._tc_session_id = 0

    # ── Public API ───────────────────────────────────────────────────────

    def dispatch_text(self, cmd: str) -> None:
        """Parse and send one console-style command string."""
        cmd_upper = cmd.strip().upper()

        if cmd_upper in _MCU_CMD_TABLE:
            cmd_byte, desc = _MCU_CMD_TABLE[cmd_upper]
            self._log(f"[MCU TX] {desc} (0x{cmd_byte:02X})")
            self._send_byte(cmd_byte)

        elif cmd_upper in _TC_MAP:
            opcode, tc_payload, desc = _TC_MAP[cmd_upper]
            self._send_tc(opcode, tc_payload, desc)

        elif cmd_upper.startswith("GET "):
            filename = cmd[4:].strip().encode("ascii", errors="replace")
            self._log(f"[MCU TX] Requesting file: {filename.decode()}")
            self._send_payload(0xC7, filename)

        elif cmd_upper.startswith("DEL "):
            filename = cmd[4:].strip().encode("ascii", errors="replace")
            self._log(f"[MCU TX] Deleting file: {filename.decode()}")
            self._send_payload(0xC8, filename)

        elif cmd_upper.startswith("SET_HEALTH "):
            parts = cmd_upper[11:].split()
            if len(parts) == 2:
                try:
                    param_id = int(parts[0])
                    value = int(parts[1])
                    tc_payload = bytes([param_id & 0xFF]) + value.to_bytes(4, "big")
                    self._send_tc(
                        0x4A, tc_payload,
                        f"TC_UPDATE_HEALTH_PARAM(id={param_id},val={value})"
                    )
                except (ValueError, OverflowError):
                    self._log("[ERROR] SET_HEALTH: valor fuera de rango")
            else:
                self._log("[ERROR] Uso: SET_HEALTH <param_id> <valor>  (ej: SET_HEALTH 5 3300)")

        elif cmd_upper.startswith("TIME_SYNC"):
            parts = cmd_upper.split()
            dist_km = 0
            if len(parts) == 2 and parts[1].isdigit():
                dist_km = int(parts[1])
            self._send_time_sync(dist_km)

        elif cmd_upper.startswith("READEPS "):
            parts = cmd_upper[8:].split()
            try:
                pid = int(parts[0], 0)
                self._send_tc(0x48, bytes([pid & 0xFF]), f"EPS_RD_PARAM(id={pid})")
            except (ValueError, IndexError):
                self._log("[ERROR] Uso: READEPS <param_id>   ej: READEPS 14")

        elif cmd_upper.startswith("WRITEEPS "):
            parts = cmd_upper[9:].split()
            try:
                pid = int(parts[0], 0)
                val = int(parts[1], 0)
                payload = bytes([
                    pid & 0xFF,
                    (val >> 24) & 0xFF, (val >> 16) & 0xFF,
                    (val >>  8) & 0xFF,  val        & 0xFF,
                ])
                self._send_tc(0x49, payload, f"EPS_WR_PARAM(id={pid},val={val})")
            except (ValueError, IndexError):
                self._log("[ERROR] Uso: WRITEEPS <param_id> <valor>  ej: WRITEEPS 14 1")

        elif cmd_upper.startswith("BER_TEST") or cmd_upper.startswith("BER TEST"):
            parts = cmd.strip().split()
            n_pkts = 100
            rs_mode = "RS" in [p.upper() for p in parts[1:]]
            for p in parts[1:]:
                try:
                    n_pkts = max(1, min(500, int(p)))
                    break
                except ValueError:
                    pass
            flags = 0x01 if rs_mode else 0x00
            payload = bytes([(n_pkts >> 8) & 0xFF, n_pkts & 0xFF, flags])
            rs_label = " +RS(96,88)" if rs_mode else ""
            self._log(f"[MCU TX] BER test: {n_pkts} paquetes patron 0xAA{rs_label} (0x80)")
            self._on_ber_mode(rs_mode)
            self._send_payload(0x80, payload)

        elif cmd_upper.startswith("SET_POWER "):
            parts = cmd_upper[10:].split()
            try:
                level = int(parts[0])
                if 0 <= level <= 127:
                    self._send_tc(0x61, bytes([level & 0xFF]),
                                  f"TC_SET_POWER(level={level}) → OBC autoriza → UHF aplica")
                else:
                    self._log("[ERROR] SET_POWER: nivel debe ser 0-127")
            except (ValueError, IndexError):
                self._log("[ERROR] Uso: SET_POWER <nivel>   ej: SET_POWER 50")

        elif cmd_upper.startswith("OVERRIDE_POWER "):
            parts = cmd_upper[15:].split()
            try:
                level = int(parts[0])
                if 0 <= level <= 127:
                    self._send_tc(0x62, bytes([level & 0xFF]),
                                  f"TC_OVERRIDE_POWER(level={level}) → UHF aplica directo, notifica OBC")
                else:
                    self._log("[ERROR] OVERRIDE_POWER: nivel debe ser 0-127")
            except (ValueError, IndexError):
                self._log("[ERROR] Uso: OVERRIDE_POWER <nivel>   ej: OVERRIDE_POWER 50")

        elif cmd_upper.startswith("READ_UHF "):
            parts = cmd_upper[9:].split()
            try:
                pid = int(parts[0])
                if 0 <= pid <= 18:
                    self._send_tc(0x63, bytes([pid & 0xFF]),
                                  f"TC_READ_UHF(param_id={pid}) → UHF responde directamente por RF")
                else:
                    self._log("[ERROR] READ_UHF: id debe ser 0-18")
            except (ValueError, IndexError):
                self._log("[ERROR] Uso: READ_UHF <id>   ej: READ_UHF 17")

        elif cmd_upper.startswith("CMD:"):
            cmd_hex = cmd[4:].strip()
            try:
                cmd_byte = int(cmd_hex, 16)
                if 0 <= cmd_byte <= 255:
                    self._log(f"[MCU TX] RAW command: 0x{cmd_byte:02X}")
                    self._send_byte(cmd_byte)
                else:
                    self._log(f"[ERROR] Invalid RAW command: {cmd_hex}")
            except ValueError:
                self._log("[ERROR] Bad format. Use: CMD:C0 or CMD:0xC0")

        else:
            self._log(f"[MCU] Unknown command: '{cmd}'. Type HELP for list.")

    # ── Internal ─────────────────────────────────────────────────────────

    def _send_tc(self, opcode: int, payload: bytes = b"", desc: str = "") -> None:
        """Build a 64-byte OPS v1.0 frame and send it as AX.25 type 0xA5."""
        sid = self._tc_session_id
        self._tc_session_id = (self._tc_session_id + 1) & 0x0F
        frame = build_ops_frame(opcode, sid, payload)
        name = desc or f"TC_0x{opcode:02X}"
        self._log(f"[TC] {name}  opcode=0x{opcode:02X}  sess_id={sid}  frame={len(frame)}B")
        self._send_payload(OPS_PACKET_TYPE, frame)

    def _send_time_sync(self, distance_km: int = 0) -> None:
        """Build and transmit TC 0x90 TIME_SYNC.

        AX.25 pkt_type=0x90, DATA = epoch_ms(8B BE) + dist_km(2B BE) + CRC8(1B).
        """
        import struct

        epoch_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
        raw = struct.pack(">QH", epoch_ms, distance_km & 0xFFFF)
        payload = raw + bytes([_crc8(raw)])
        dt_str = datetime.datetime.fromtimestamp(
            epoch_ms / 1000, tz=datetime.timezone.utc
        ).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        self._log(
            f"[TIME_SYNC] epoch_ms={epoch_ms}  ({dt_str} UTC)  "
            f"dist_km={distance_km}  CRC8=0x{payload[-1]:02X}  "
            f"frame=0x90 AX25 {len(payload)}B"
        )
        self._send_payload(0x90, payload)
