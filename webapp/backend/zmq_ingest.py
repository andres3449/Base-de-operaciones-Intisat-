# -*- coding: utf-8 -*-
"""Background ingest: subscribes to Core/telemetry_publisher.py's ZMQ PUB
feed (topics TLM/MSG/LOG), persists telemetry+messages to ClickHouse, and
fans everything out to WebSocket clients tagged with a `kind` discriminator
so the frontend can route each event to the right panel.

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


def _handle_tlm(ch_client, frame: dict):
    ts = frame.get("ts", time.time())
    source = frame.get("source", "unknown")
    satellite_id = frame.get("satellite_id", "")
    channels = frame.get("channels", {})

    state["last_frame_ts"] = ts
    state["frames_received"] += 1

    try:
        clickhouse_client.insert_frame(ch_client, ts, source, channels, satellite_id)
    except Exception as e:
        print(f"[zmq_ingest] ClickHouse insert (telemetry) failed: {e}")

    return {"kind": "telemetry", **frame}


def _handle_msg(ch_client, frame: dict):
    try:
        clickhouse_client.insert_message(
            ch_client,
            ts=frame.get("ts", time.time()),
            satellite_id=frame.get("satellite_id", ""),
            source=frame.get("source", "mcu"),
            pkt_type=frame.get("pkt_type", 0),
            pkt_type_name=frame.get("pkt_type_name", ""),
            decoded=frame.get("decoded", True),
            error=frame.get("error", ""),
            size_bytes=frame.get("size_bytes", 0),
        )
    except Exception as e:
        print(f"[zmq_ingest] ClickHouse insert (message) failed: {e}")

    return {"kind": "message", **frame}


def _worker(loop: asyncio.AbstractEventLoop):
    ctx = zmq.Context.instance()
    sock = ctx.socket(zmq.SUB)
    sock.setsockopt(zmq.RCVTIMEO, 1000)  # let the loop check _stop periodically
    sock.connect(config.ZMQ_ENDPOINT)
    for topic in (b"TLM", b"MSG", b"LOG"):
        sock.setsockopt(zmq.SUBSCRIBE, topic)
    ch_client = clickhouse_client.get_client()
    state["connected"] = True
    print(f"[zmq_ingest] subscribed to {config.ZMQ_ENDPOINT}")

    while not _stop.is_set():
        try:
            topic, payload = sock.recv_multipart()
        except zmq.Again:
            continue
        except zmq.ZMQError:
            break

        try:
            frame = json.loads(payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"[zmq_ingest] bad frame: {e}")
            continue

        if topic == b"TLM":
            out = _handle_tlm(ch_client, frame)
        elif topic == b"MSG":
            out = _handle_msg(ch_client, frame)
        else:  # LOG — live view only, never persisted
            out = {"kind": "log", **frame}

        asyncio.run_coroutine_threadsafe(manager.broadcast(out), loop)

    sock.close(0)
    state["connected"] = False


def start(loop: asyncio.AbstractEventLoop) -> threading.Thread:
    _stop.clear()
    t = threading.Thread(target=_worker, args=(loop,), daemon=True, name="zmq-ingest")
    t.start()
    return t


def stop():
    _stop.set()
