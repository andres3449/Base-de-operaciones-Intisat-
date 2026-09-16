# -*- coding: utf-8 -*-
"""
INTISAT — Telemetry Publisher (bridge to the web monitoring backend).

Publishes every decoded telemetry frame over a local ZMQ PUB socket so an
independent process (the FastAPI web backend under `webapp/backend/`) can
subscribe and persist history to ClickHouse, without touching the UART/RF
decoding pipeline that lives inside this process.

This mirrors the existing ZMQ PUB/SUB pattern already used between the C SDR
backend (`intisat_sdr`, tcp://127.0.0.1:5555) and `Core/SDR/sdr_backend_client.py`
— ZMQ PUB supports multiple independent subscribers, so this is a second,
unrelated PUB endpoint bound by the Python side.

Two structurally different telemetry shapes exist in this app and both are
normalized here into one flat {channel_name: float} schema, tagged by a
`source` field so consumers can tell them apart:

  - publish_sim(v)  — the 85-float tuple from TelemetryAssembler (simulated /
    RF sub-packet path). Channel names come straight from the decoder field
    comments in Core/SDR/telemetry_assembler.py (the authoritative index map),
    prefixed "sim.".
  - publish_real(tlm) — the nested {'eps':.., 'uhf':.., 'obc':..} dict from
    GUI/pages/comms.py's real OBC full-telemetry decoder, flattened key by
    key, prefixed "real.<section>.". Units are NOT converted to match the sim
    path (e.g. millivolts stay millivolts) — deliberately, to avoid silently
    introducing conversion bugs; consumers key off the prefix.

Sends are always non-blocking and best-effort: if no subscriber is attached
or the socket's high-water mark is full, the frame is silently dropped
rather than ever stalling the Qt event loop.
"""

import json
import time

import zmq

PUB_ENDPOINT = "tcp://127.0.0.1:5560"

# Canonical name for each index of the 85-float simulated telemetry tuple
# (index 0 is unused; 78/79 are reserved padding in the wire format and
# carry no real value, so they're intentionally left out here).
# Source of truth: the field comments in Core/SDR/telemetry_assembler.py.
SIM_CHANNEL_NAMES = {
    1: "obc_cpu_load", 2: "obc_ram_usage", 3: "obc_temp",
    4: "obc_fs_usage", 5: "obc_uptime", 6: "obc_status",

    7: "eps_batt_voltage", 8: "eps_batt_current", 9: "eps_batt_temp",
    10: "eps_batt_soc", 11: "eps_bus_voltage", 12: "eps_bus_current",
    13: "eps_pwr_obc", 14: "eps_pwr_comms", 15: "eps_pwr_adcs", 16: "eps_pwr_tcs",

    17: "eps_solar_voltage_1", 18: "eps_solar_voltage_2", 19: "eps_solar_voltage_3",
    20: "eps_solar_voltage_4", 21: "eps_solar_voltage_5", 22: "eps_solar_voltage_6",
    23: "eps_solar_current_1", 24: "eps_solar_current_2", 25: "eps_solar_current_3",
    26: "eps_solar_current_4", 27: "eps_solar_current_5", 28: "eps_solar_current_6",
    29: "eps_solar_total_power",

    30: "adcs_mag_x", 31: "adcs_mag_y", 32: "adcs_mag_z",
    33: "adcs_gyro_x", 34: "adcs_gyro_y", 35: "adcs_gyro_z",
    36: "adcs_accel_x", 37: "adcs_accel_y", 38: "adcs_accel_z",
    39: "adcs_sun_angle",
    40: "adcs_sun_sensor_1", 41: "adcs_sun_sensor_2", 42: "adcs_sun_sensor_3",
    43: "adcs_sun_sensor_4", 44: "adcs_sun_sensor_5", 45: "adcs_sun_sensor_6",

    46: "adcs_quat_w", 47: "adcs_quat_x", 48: "adcs_quat_y", 49: "adcs_quat_z",
    50: "adcs_ang_vel_x", 51: "adcs_ang_vel_y", 52: "adcs_ang_vel_z",
    53: "adcs_attitude_error", 54: "adcs_mtq_current",
    55: "adcs_rw_speed_1", 56: "adcs_rw_speed_2", 57: "adcs_rw_speed_3",
    58: "adcs_rw_torque",
    59: "adcs_ctrl_temp_1", 60: "adcs_ctrl_temp_2",
    61: "adcs_ctrl_temp_3", 62: "adcs_ctrl_temp_4",

    63: "tcs_panel_temp_1", 64: "tcs_panel_temp_2", 65: "tcs_panel_temp_3",
    66: "tcs_panel_temp_4", 67: "tcs_panel_temp_5", 68: "tcs_panel_temp_6",
    69: "tcs_heater_current",

    70: "coms_rssi", 71: "coms_snr", 72: "coms_ber",
    73: "coms_uplink_rate", 74: "coms_downlink_rate",
    75: "coms_packets_sent", 76: "coms_packets_received", 77: "coms_packets_failed",
    80: "coms_sband_tx_power", 81: "coms_pa_temp",
    82: "coms_dl_success", 83: "coms_total_data_mb", 84: "coms_tx_duration",
}


class TelemetryPublisher:
    """Thin ZMQ PUB wrapper — bind once, call publish_sim/publish_real per frame.

    Three message kinds, on three ZMQ topics so a subscriber can pick which
    ones it cares about (e.g. the backend's messages-table insert only needs
    MSG, the live log view in the web UI only needs LOG):
      - TLM — a telemetry frame (decoded channel values), see publish_sim/publish_real.
      - MSG — one row per received packet, logged whether or not it decoded
        (see publish_message) — backs the ClickHouse `messages` table.
      - LOG — free-text status/error lines for the live log view only, never
        persisted to ClickHouse (see publish_log).
    """

    def __init__(self, endpoint: str = PUB_ENDPOINT, satellite_id: str = ""):
        self._satellite_id = satellite_id
        self._ctx = zmq.Context.instance()
        self._sock = self._ctx.socket(zmq.PUB)
        self._sock.setsockopt(zmq.SNDHWM, 10)
        self._sock.setsockopt(zmq.LINGER, 0)
        self._sock.bind(endpoint)

    def publish_sim(self, v: tuple):
        channels = {}
        for idx, name in SIM_CHANNEL_NAMES.items():
            if idx < len(v):
                channels[f"sim.{name}"] = float(v[idx])
        if not channels:
            return
        self._send(b"TLM", {"ts": time.time(), "source": "sim",
                             "satellite_id": self._satellite_id, "channels": channels})

    def publish_real(self, tlm: dict):
        channels = {}
        for section, fields in tlm.items():          # 'eps' | 'uhf' | 'obc'
            for key, value in fields.items():
                if isinstance(value, bool):
                    continue
                if isinstance(value, (int, float)):
                    channels[f"real.{section}.{key}"] = float(value)
                elif isinstance(value, (list, tuple)):
                    for i, item in enumerate(value):
                        if isinstance(item, (int, float)) and not isinstance(item, bool):
                            channels[f"real.{section}.{key}_{i}"] = float(item)
        if not channels:
            return
        self._send(b"TLM", {"ts": time.time(), "source": "real",
                             "satellite_id": self._satellite_id, "channels": channels})

    def publish_message(
        self, pkt_type: int, pkt_type_name: str = "", source: str = "mcu",
        decoded: bool = True, error: str = "", size_bytes: int = 0,
    ):
        """One row per received packet — backs the ClickHouse `messages` log,
        independent of whether TelemetryAssembler could decode it."""
        self._send(b"MSG", {
            "ts": time.time(), "satellite_id": self._satellite_id, "source": source,
            "pkt_type": pkt_type, "pkt_type_name": pkt_type_name,
            "decoded": decoded, "error": error, "size_bytes": size_bytes,
        })

    def publish_log(self, text: str):
        """Free-text line for the live log view — never written to ClickHouse."""
        self._send(b"LOG", {"ts": time.time(), "text": text})

    def _send(self, topic: bytes, payload: dict):
        msg = json.dumps(payload).encode("utf-8")
        try:
            self._sock.send_multipart([topic, msg], flags=zmq.NOBLOCK)
        except zmq.ZMQError:
            pass  # no subscriber / socket full — never block the GUI thread

    def close(self):
        try:
            self._sock.close(0)
        except Exception:
            pass
