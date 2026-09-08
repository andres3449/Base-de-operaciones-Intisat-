# -*- coding: utf-8 -*-
"""Background ingest: subscribes to Core/telemetry_publisher.py's ZMQ PUB
feed, persists each frame to ClickHouse, and fans it out to WebSocket
clients.

Runs the ZMQ SUB loop in a plain OS thread with blocking recv_multipart(),
NOT zmq.asyncio — on Windows, asyncio defaults to ProactorEventLoop, which
zmq.asyncio cannot use (it requires add_reader(), which Proactor doesn't
implement), so a naive asyncio SUB silently never receives anything there.
A blocking thread sidesteps that entirely and works the same on every OS.
"""

import asyncio
import json
import threading
import time

import zmq

from . import clickhouse_client, config
from .ws_manager import manager

# Simple in-process status, read by routers/status.py
state = {
    "connected": False,
    "last_frame_ts": None,
    "frames_received": 0,
    "started_at": time.time(),
}

_stop = threading.Event()


def _worker(loop: asyncio.AbstractEventLoop):
    ctx = zmq.Context.instance()
    sock = ctx.socket(zmq.SUB)
    sock.setsockopt(zmq.RCVTIMEO, 1000)  # let the loop check _stop periodically
    sock.connect(config.ZMQ_ENDPOINT)
    sock.setsockopt(zmq.SUBSCRIBE, b"TLM")
    ch_client = clickhouse_client.get_client()
    state["connected"] = True
    print(f"[zmq_ingest] subscribed to {config.ZMQ_ENDPOINT}")

    while not _stop.is_set():
        try:
            _topic, payload = sock.recv_multipart()
        except zmq.Again:
            continue
        except zmq.ZMQError:
            break

        try:
            frame = json.loads(payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"[zmq_ingest] bad frame: {e}")
            continue

        ts = frame.get("ts", time.time())
        source = frame.get("source", "unknown")
        channels = frame.get("channels", {})

        state["last_frame_ts"] = ts
        state["frames_received"] += 1

        try:
            clickhouse_client.insert_frame(ch_client, ts, source, channels)
        except Exception as e:
            print(f"[zmq_ingest] ClickHouse insert failed: {e}")

        asyncio.run_coroutine_threadsafe(manager.broadcast(frame), loop)

    sock.close(0)
    state["connected"] = False


def start(loop: asyncio.AbstractEventLoop) -> threading.Thread:
    _stop.clear()
    t = threading.Thread(target=_worker, args=(loop,), daemon=True, name="zmq-ingest")
    t.start()
    return t


def stop():
    _stop.set()
