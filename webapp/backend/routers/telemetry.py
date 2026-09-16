# -*- coding: utf-8 -*-
import time
from typing import Optional

from fastapi import APIRouter, HTTPException

from .. import clickhouse_client

router = APIRouter(prefix="/api", tags=["telemetry"])

# Sync endpoints run in FastAPI's threadpool, so concurrent requests (e.g.
# the frontend fetching history for several charts at once) can execute in
# parallel. clickhouse-connect's client is not safe to share across
# concurrently-running queries (verified empirically: two requests fired at
# once against a shared client both silently returned zero rows), so each
# request gets its own short-lived client instead of the app-wide one used
# at startup/by the ingest thread.


@router.get("/channels")
def list_channels():
    return {"channels": clickhouse_client.query_channels(clickhouse_client.get_client())}


@router.get("/telemetry/latest")
def latest(satellite_id: Optional[str] = None):
    return {"values": clickhouse_client.query_latest(clickhouse_client.get_client(), satellite_id)}


@router.get("/telemetry/history")
def history(
    channel: str,
    minutes: int = 30,
    from_ts: Optional[float] = None,
    to_ts: Optional[float] = None,
    satellite_id: Optional[str] = None,
):
    """Time window: either an explicit from_ts/to_ts pair (Grafana-style
    range picker), or the legacy `minutes`-from-now default when neither
    is given."""
    if from_ts is not None and to_ts is not None:
        start, end = from_ts, to_ts
    else:
        if minutes <= 0 or minutes > 60 * 24 * 30:
            raise HTTPException(400, "minutes must be between 1 and 43200")
        end = time.time()
        start = end - minutes * 60
    return {
        "channel": channel,
        "points": clickhouse_client.query_history(
            clickhouse_client.get_client(), channel, start, end, satellite_id
        ),
    }
