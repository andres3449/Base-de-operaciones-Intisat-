# -*- coding: utf-8 -*-
from typing import Optional

from fastapi import APIRouter

from .. import clickhouse_client

router = APIRouter(prefix="/api", tags=["messages"])


@router.get("/messages")
def list_messages(
    from_ts: Optional[float] = None,
    to_ts: Optional[float] = None,
    satellite_id: Optional[str] = None,
    pkt_type: Optional[int] = None,
    source: Optional[str] = None,
    decoded: Optional[bool] = None,
    limit: int = 200,
):
    client = clickhouse_client.get_client()
    return {
        "messages": clickhouse_client.query_messages(
            client,
            start=from_ts,
            end=to_ts,
            satellite_id=satellite_id,
            pkt_type=pkt_type,
            source=source,
            decoded=decoded,
            limit=min(limit, 1000),
        )
    }
