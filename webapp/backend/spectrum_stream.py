# -*- coding: utf-8 -*-
"""Opt-in live RF spectrum stream (/ws/spectrum).

Subscribes directly to the C SDR backend's own PUB socket (topic FFT --
Core/SDR/sdr_backend_client.py's ZMQ_PUB_ENDPOINT), as an independent SUB
client. ZMQ PUB supports multiple simultaneous subscribers, so this does not
touch headless_receiver.py's own SUB socket or its packet-decoding path.

The raw FFT feed (~2048 float32 bins, ~30 frames/s) is too much to push to
a browser unconditionally -- streaming it as JSON would be well over 1MB/s
per client. So this only does the parse+broadcast work while at least one
WebSocket client is connected, decimates each frame down to a plot-sized
number of bins, and throttles the broadcast rate.

Same blocking-thread pattern as zmq_ingest.py (not zmq.asyncio: Windows'
default ProactorEventLoop can't be used with zmq.asyncio's add_reader()).
"""

import asyncio
import struct
import threading
import time

import numpy as np
import zmq
from fastapi import WebSocket

from . import config

_FFT_HDR_FMT = "<IffQ"  # uint32 fft_size, float center_freq, float sample_rate, uint64 ts_us
_FFT_HDR_SIZE = struct.calcsize(_FFT_HDR_FMT)

_BROADCAST_INTERVAL_S = 1.0 / 8  # throttle to ~8 fps for the browser
_PLOT_BINS = 512  # decimated from the native 2048

_stop = threading.Event()


class SpectrumManager:
    def __init__(self):
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self._clients.discard(ws)

    @property
    def has_clients(self) -> bool:
        return bool(self._clients)

    async def broadcast(self, message: dict):
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)


manager = SpectrumManager()


def _parse_fft(payload: bytes):
    if len(payload) < _FFT_HDR_SIZE:
        return None
    fft_size, center_freq, sample_rate, _ts_us = struct.unpack_from(_FFT_HDR_FMT, payload, 0)
    if len(payload) < _FFT_HDR_SIZE + fft_size * 4:
        return None
    power_db = np.frombuffer(payload, dtype=np.float32, offset=_FFT_HDR_SIZE, count=fft_size)
    freq_axis = np.fft.fftshift(np.fft.fftfreq(fft_size, d=1.0 / sample_rate))
    return freq_axis, power_db, center_freq, sample_rate


def _decimate(freq_axis: np.ndarray, power_db: np.ndarray, n: int):
    if power_db.size <= n:
        return freq_axis, power_db
    factor = power_db.size // n
    usable = factor * n
    p = power_db[:usable].reshape(n, factor).max(axis=1)
    f = freq_axis[:usable].reshape(n, factor).mean(axis=1)
    return f, p


def _worker(loop: asyncio.AbstractEventLoop):
    ctx = zmq.Context.instance()
    sock = ctx.socket(zmq.SUB)
    sock.setsockopt(zmq.RCVTIMEO, 1000)
    sock.connect(config.SDR_FFT_ENDPOINT)
    sock.setsockopt(zmq.SUBSCRIBE, b"FFT")
    print(f"[spectrum_stream] subscribed to {config.SDR_FFT_ENDPOINT} (topic FFT)")

    last_broadcast_ts = 0.0
    while not _stop.is_set():
        try:
            topic, payload = sock.recv_multipart()
        except zmq.Again:
            continue
        except zmq.ZMQError:
            break

        if topic != b"FFT" or not manager.has_clients:
            continue

        now = time.time()
        if now - last_broadcast_ts < _BROADCAST_INTERVAL_S:
            continue

        parsed = _parse_fft(payload)
        if parsed is None:
            continue
        freq_axis, power_db, center_freq, sample_rate = parsed
        freq_axis, power_db = _decimate(freq_axis, power_db, _PLOT_BINS)
        last_broadcast_ts = now

        frame = {
            "kind": "spectrum",
            "ts": now,
            "center_freq_hz": float(center_freq),
            "sample_rate_hz": float(sample_rate),
            "freq_hz": [round(float(x), 1) for x in freq_axis],
            "power_db": [round(float(x), 1) for x in power_db],
        }
        asyncio.run_coroutine_threadsafe(manager.broadcast(frame), loop)

    sock.close(0)


def start(loop: asyncio.AbstractEventLoop) -> threading.Thread:
    _stop.clear()
    t = threading.Thread(target=_worker, args=(loop,), daemon=True, name="spectrum-stream")
    t.start()
    return t


def stop():
    _stop.set()
