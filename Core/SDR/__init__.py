# -*- coding: utf-8 -*-
"""INTISAT — SDR subsystem used by headless_receiver.py and the web backend.

- telemetry_assembler / image_assembler / burst_image_assembler: decode path
  shared with the UART/MCU frames (same byte layout regardless of source).
- sdr_backend_client: pure-Python ZMQ client for the `intisat_sdr` C DSP
  backend (../../intisat_sdr) — RTL-SDR/LimeSDR receive, FFT, decoded
  packets. No Qt dependency; safe to import from any process.
- limesdr_tx: builds/modulates AX.25 command frames to 2FSK IQ and bursts
  them via SDRBackendClient.send_tx_burst() (LimeSDR TX only — RTL-SDR is
  receive-only hardware, there is no TX path for it anywhere in this repo).
- ax25_decode: parses AX.25 frames out of DecodedPacket.raw_bytes (pkt_type,
  data, CRC check) plus a bit-slip recovery fallback — the receive-side
  counterpart of limesdr_tx, used by headless_receiver.py to feed SDR-sourced
  packets into the same on_packet() handler as the UART path.
- dsp_logger: plain-file logging helper used by sdr_backend_client.

This project owns its own copy of these modules — nothing here imports
from or depends on the separate PyQt5 interface project.
"""
