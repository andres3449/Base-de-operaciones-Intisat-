# -*- coding: utf-8 -*-
import time

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
def latest():
    return {"values": clickhouse_client.query_latest(clickhouse_client.get_client())}


@router.get("/telemetry/history")
def history(channel: str, minutes: int = 30):
    if minutes <= 0 or minutes > 60 * 24 * 30:
        raise HTTPException(400, "minutes must be between 1 and 43200")
    end = time.time()
    start = end - minutes * 60
    return {
        "channel": channel,
        "points": clickhouse_client.query_history(
            clickhouse_client.get_client(), channel, start, end
        ),
    }
