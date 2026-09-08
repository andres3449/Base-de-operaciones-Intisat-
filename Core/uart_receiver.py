# -*- coding: utf-8 -*-
"""
INTISAT Ground Station — UART Receiver for MCU (main_receiver.c protocol).

Parses the binary 0x8A protocol from the STM32 main_receiver firmware.
Emits decoded packets via Qt signals for routing to the existing
ImageAssembler and TelemetryAssembler.

Binary protocol (PC ← MCU):
  Data packet:   [0x8A] [0x08] [pkt_type] [len] [data...] [crc8]
  Telem packet:  [0x8A] [0xEE] [pkt_type] [len] [data...] [crc8]
  Status message: [0x8A] [0xDB] [len] [message...]   (no CRC)

Binary protocol (PC → MCU):
  Single-byte commands: 0xC0-0xCB
  Commands with payload: [cmd_byte] [payload_bytes...]
"""

import serial
from serial.tools import list_ports
from PyQt5.QtCore import QObject, QTimer, pyqtSignal


# ── Protocol constants ────────────────────────────────────────────────────────
_SYNC_BYTE   = 0x8A
_CMD_DATA    = 0x08   # RF data packet (image, stats, etc.)
_CMD_TELEM   = 0xEE   # Telemetry packet (legacy or sub-packets)
_CMD_STATUS  = 0xDB   # Status message (text, no CRC)

_READ_INTERVAL = 20   # ms between serial reads


def _crc8(data: bytes) -> int:
    """CRC-8: poly=0x07, init=0x00 — matches calculateCRC8 in main_receiver.c."""
    crc = 0x00
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ 0x07) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc


class UartReceiver(QObject):
    """
    COM port receiver for main_receiver.c binary protocol.

    Signals
    -------
    packet_received(int, bytes)  — (pkt_type, data) for routing to assemblers
    status_message(str)          — text status from MCU (e.g. "SATELLITE_LINKED")
    log_message(str)             — log line for console display
    connected(str)               — port name on successful open
    disconnected()               — port closed / error
    """

    packet_received = pyqtSignal(int, bytes)
    status_message  = pyqtSignal(str)
    log_message     = pyqtSignal(str)
    connected       = pyqtSignal(str)
    disconnected    = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._port: serial.Serial | None = None
        self._buffer = bytearray()

        self._timer = QTimer(self)
        self._timer.setInterval(_READ_INTERVAL)
        self._timer.timeout.connect(self._read)

    # ── Public API ────────────────────────────────────────────────────────────

    @staticmethod
    def available_ports() -> list[str]:
        """Return list of available serial port device names."""
        return [p.device for p in list_ports.comports()]

    def connect(self, port: str, baudrate: int):
        """Open serial port and start reading timer."""
        try:
            self._port = serial.Serial(port, baudrate, timeout=0)
            self._buffer.clear()
            self._timer.start()
            self.connected.emit(port)
            self.log_message.emit(f"[MCU] Connected to {port} @ {baudrate} baud")
        except serial.SerialException as e:
            self.log_message.emit(f"[MCU ERROR] Cannot open {port}: {e}")

    def disconnect(self):
        """Stop reading timer and close the serial port."""
        self._timer.stop()
        if self._port and self._port.is_open:
            self._port.close()
        self._port = None
        self._buffer.clear()
        self.disconnected.emit()
        self.log_message.emit("[MCU] Disconnected")

    def is_connected(self) -> bool:
        return self._port is not None and self._port.is_open

    def send_command(self, cmd_byte: int):
        """Send a single-byte command to the MCU (0xC0-0xCB)."""
        if not self._port or not self._port.is_open:
            self.log_message.emit("[MCU ERROR] Not connected")
            return
        try:
            self._port.write(bytes([cmd_byte]))
            self._port.flush()
        except Exception as e:
            self.log_message.emit(f"[MCU ERROR] Send failed: {e}")
            self.disconnect()

    def send_command_with_payload(self, cmd_byte: int, payload: bytes):
        """Send a command byte followed by payload (for SEND_FILE, DELETE_FILE)."""
        if not self._port or not self._port.is_open:
            self.log_message.emit("[MCU ERROR] Not connected")
            return
        try:
            self._port.write(bytes([cmd_byte]) + payload)
            self._port.flush()
        except Exception as e:
            self.log_message.emit(f"[MCU ERROR] Send failed: {e}")
            self.disconnect()

    # ── Internal read / parse loop ────────────────────────────────────────────

    def _read(self):
        try:
            waiting = self._port.in_waiting
            if waiting:
                self._buffer += self._port.read(waiting)
            self._parse()
        except (serial.SerialException, OSError) as e:
            self.log_message.emit(f"[MCU ERROR] Read failed: {e}")
            self.disconnect()

    def _parse(self):
        """Parse all complete packets from the buffer."""
        while True:
            # Find next sync byte
            try:
                idx = self._buffer.index(_SYNC_BYTE)
            except ValueError:
                # No sync byte — discard everything
                self._buffer.clear()
                return

            # Discard bytes before sync
            if idx > 0:
                self._buffer = self._buffer[idx:]

            # Need at least: sync(1) + cmd(1) + ...
            if len(self._buffer) < 3:
                return

            cmd_id = self._buffer[1]

            if cmd_id == _CMD_STATUS:
                # Status message: [0x8A] [0xDB] [len] [message...]
                msg_len = self._buffer[2]
                total = 3 + msg_len
                if len(self._buffer) < total:
                    return  # incomplete — wait for more
                message = self._buffer[3:3 + msg_len].decode('ascii', errors='replace')
                self._buffer = self._buffer[total:]
                self.status_message.emit(message)
                self.log_message.emit(f"[MCU STATUS] {message}")

            elif cmd_id in (_CMD_DATA, _CMD_TELEM):
                # Data/Telem: [0x8A] [cmd] [pkt_type] [len] [data...] [crc8]
                if len(self._buffer) < 5:
                    return  # need at least header + 1 byte
                pkt_type = self._buffer[2]
                data_len = self._buffer[3]
                total = 4 + data_len + 1  # header(4) + data + crc(1)
                if len(self._buffer) < total:
                    return  # incomplete

                data = bytes(self._buffer[4:4 + data_len])
                crc_recv = self._buffer[4 + data_len]
                crc_calc = _crc8(data)

                self._buffer = self._buffer[total:]

                if crc_recv != crc_calc:
                    self.log_message.emit(
                        f"[MCU WARN] CRC8 mismatch on 0x{cmd_id:02X}/0x{pkt_type:02X}: "
                        f"recv=0x{crc_recv:02X} calc=0x{crc_calc:02X}")
                    continue  # discard bad packet

                label = "DATA" if cmd_id == _CMD_DATA else "TELEM"
                self.log_message.emit(
                    f"[MCU {label}] pkt=0x{pkt_type:02X} len={data_len}")
                self.packet_received.emit(pkt_type, data)

            else:
                # Unknown cmd_id after sync — might be a false sync.
                # Skip this sync byte and try next.
                self._buffer = self._buffer[1:]
