# -*- coding: utf-8 -*-
import time

from fastapi import APIRouter

from .. import zmq_ingest

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/status")
def status():
    s = zmq_ingest.state
    return {
        "zmq_connected": s["connected"],
        "last_frame_ts": s["last_frame_ts"],
        "seconds_since_last_frame": (
            time.time() - s["last_frame_ts"] if s["last_frame_ts"] else None
        ),
        "frames_received": s["frames_received"],
        "backend_uptime_s": time.time() - s["started_at"],
    }
