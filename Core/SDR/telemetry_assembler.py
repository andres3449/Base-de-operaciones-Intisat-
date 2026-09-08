# -*- coding: utf-8 -*-
"""
INTISAT — Telemetry Sub-Packet Assembler.

Collects 7 AX.25 sub-packets (pkt_type 0x40-0x46) from the SDR backend,
decodes compressed int16 values back to floats, and emits a complete
85-float tuple compatible with the GUI telemetry pipeline.
"""

import struct
import time

from PyQt5.QtCore import QObject, pyqtSignal, QTimer


# Sub-packet type → (subsystem_id, packet_index)
_PKT_MAP = {
    0x40: ("OBC",       0),
    0x41: ("EPS_PWR",   1),
    0x42: ("EPS_SOL",   2),
    0x43: ("ADCS_SENS", 3),
    0x44: ("ADCS_CTRL", 4),
    0x45: ("THERMAL",   5),
    0x46: ("COMMS",     6),
}

TOTAL_SUB_PACKETS = 7
ASSEMBLY_TIMEOUT_MS = 3000  # emit partial frame after 3 s


def _u16(data, off):
    """Read big-endian uint16."""
    return (data[off] << 8) | data[off + 1]


def _i16(data, off):
    """Read big-endian int16."""
    val = (data[off] << 8) | data[off + 1]
    return val - 0x10000 if val >= 0x8000 else val


def _f32(data, off):
    """Read big-endian float32."""
    return struct.unpack(">f", bytes(data[off:off + 4]))[0]


class TelemetryAssembler(QObject):
    """Assembles 7 sub-packets into an 85-float telemetry tuple."""

    telemetry_ready = pyqtSignal(tuple)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._values = [0.0] * 85
        self._received = set()
        self._last_rx_time = 0.0

        # Timeout timer — emit partial frames if not all 7 arrive
        self._timeout = QTimer(self)
        self._timeout.setSingleShot(True)
        self._timeout.setInterval(ASSEMBLY_TIMEOUT_MS)
        self._timeout.timeout.connect(self._on_timeout)

    # ------------------------------------------------------------------
    #  Public API
    # ------------------------------------------------------------------

    def process_packet(self, pkt_type: int, data: bytes):
        """Decode a sub-packet and update internal values.

        Parameters
        ----------
        pkt_type : int
            AX.25 packet type (0x40-0x46).
        data : bytes
            Raw data payload (after AX.25 header, before CRC).
        """
        if pkt_type not in _PKT_MAP:
            return

        name, idx = _PKT_MAP[pkt_type]

        # First sub-packet of a new frame? Reset tracking.
        if not self._received:
            self._timeout.start()

        self._received.add(idx)
        self._last_rx_time = time.monotonic()

        # Dispatch to specific decoder (data starts after subsystem_id + seq)
        try:
            _DECODERS[pkt_type](self._values, data, 2)
        except Exception as e:
            print(f"[TelemetryAssembler] decode error {name}: {e}")

        # All 7 received → emit immediately
        if len(self._received) >= TOTAL_SUB_PACKETS:
            self._emit()

    # ------------------------------------------------------------------
    #  Internal
    # ------------------------------------------------------------------

    def _on_timeout(self):
        """Emit whatever we have after timeout."""
        if self._received:
            self._emit()

    def _emit(self):
        self._timeout.stop()
        self.telemetry_ready.emit(tuple(self._values))
        self._received.clear()


# ======================================================================
#  Decoders — one per sub-packet type
# ======================================================================

def _decode_obc(v, d, o):
    """OBC: v[1-6], 14 bytes payload."""
    v[1] = _u16(d, o) / 100.0;     o += 2   # cpu_load
    v[2] = _u16(d, o) / 100.0;     o += 2   # ram_usage
    v[3] = _i16(d, o) / 100.0;     o += 2   # obc_temp
    v[4] = _u16(d, o) / 100.0;     o += 2   # fs_usage
    v[5] = float(_u16(d, o));       o += 2   # uptime
    v[6] = _u16(d, o) / 100.0;     o += 2   # obc_status


def _decode_eps_pwr(v, d, o):
    """EPS Power: v[7-16], 22 bytes payload."""
    v[7]  = _u16(d, o) / 1000.0;   o += 2   # batt_voltage
    v[8]  = _i16(d, o) / 1000.0;   o += 2   # batt_current
    v[9]  = _i16(d, o) / 100.0;    o += 2   # batt_temp
    v[10] = _u16(d, o) / 100.0;    o += 2   # batt_soc
    v[11] = _u16(d, o) / 1000.0;   o += 2   # bus_voltage
    v[12] = _i16(d, o) / 1000.0;   o += 2   # bus_current
    v[13] = _u16(d, o) / 100.0;    o += 2   # pwr_obc
    v[14] = _u16(d, o) / 100.0;    o += 2   # pwr_comms
    v[15] = _u16(d, o) / 100.0;    o += 2   # pwr_adcs
    v[16] = _u16(d, o) / 100.0;    o += 2   # pwr_tcs


def _decode_eps_sol(v, d, o):
    """EPS Solar: v[17-29], 28 bytes payload."""
    for i in range(6):
        v[17 + i] = _u16(d, o) / 1000.0;  o += 2  # solar_voltage[i]
    for i in range(6):
        v[23 + i] = _i16(d, o) / 1000.0;  o += 2  # solar_current[i]
    v[29] = _u16(d, o) / 100.0;            o += 2  # solar_total_power


def _decode_adcs_sens(v, d, o):
    """ADCS Sensors: v[30-45], 34 bytes payload."""
    for i in range(3):
        v[30 + i] = _i16(d, o) / 10.0;    o += 2  # magnetometer
    for i in range(3):
        v[33 + i] = _i16(d, o) / 100.0;   o += 2  # gyro
    for i in range(3):
        v[36 + i] = _i16(d, o) / 1000.0;  o += 2  # accel
    v[39] = _i16(d, o) / 100.0;            o += 2  # sun_angle
    for i in range(6):
        v[40 + i] = _i16(d, o) / 100.0;   o += 2  # sun_sensors


def _decode_adcs_ctrl(v, d, o):
    """ADCS Control: v[46-62], 36 bytes payload."""
    for i in range(4):
        v[46 + i] = _i16(d, o) / 10000.0; o += 2  # quaternion
    for i in range(3):
        v[50 + i] = _i16(d, o) / 1000.0;  o += 2  # angular velocity
    v[53] = _i16(d, o) / 100.0;            o += 2  # attitude_error
    v[54] = _i16(d, o) / 100.0;            o += 2  # mtq_current
    for i in range(3):
        v[55 + i] = float(_i16(d, o));     o += 2  # rw_speed RPM
    v[58] = _i16(d, o) / 10000.0;          o += 2  # rw_torque
    for i in range(4):
        v[59 + i] = _i16(d, o) / 100.0;   o += 2  # temps


def _decode_thermal(v, d, o):
    """Thermal: v[63-69], 16 bytes payload."""
    for i in range(6):
        v[63 + i] = _i16(d, o) / 100.0;   o += 2  # panel_temps
    v[69] = _i16(d, o) / 1000.0;           o += 2  # heater_current


def _decode_comms(v, d, o):
    """COMMS: v[70-84], 34 bytes payload."""
    v[70] = _i16(d, o) / 10.0;             o += 2  # rssi
    v[71] = _i16(d, o) / 10.0;             o += 2  # snr
    v[72] = _f32(d, o);                    o += 4  # ber (float32)
    v[73] = float(_u16(d, o));             o += 2  # uplink_rate
    v[74] = float(_u16(d, o));             o += 2  # downlink_rate
    v[75] = float(_u16(d, o));             o += 2  # packets_sent
    v[76] = float(_u16(d, o));             o += 2  # packets_received
    v[77] = float(_u16(d, o));             o += 2  # packets_failed
    _u16(d, o);                            o += 2  # reserved
    _u16(d, o);                            o += 2  # reserved
    v[80] = _i16(d, o) / 10.0;            o += 2  # sband_tx_power
    v[81] = _i16(d, o) / 10.0;            o += 2  # pa_temp
    v[82] = _u16(d, o) / 10.0;            o += 2  # dl_success
    v[83] = _u16(d, o) / 10.0;            o += 2  # total_data_mb
    v[84] = _u16(d, o) / 10.0;            o += 2  # tx_duration


_DECODERS = {
    0x40: _decode_obc,
    0x41: _decode_eps_pwr,
    0x42: _decode_eps_sol,
    0x43: _decode_adcs_sens,
    0x44: _decode_adcs_ctrl,
    0x45: _decode_thermal,
    0x46: _decode_comms,
}
