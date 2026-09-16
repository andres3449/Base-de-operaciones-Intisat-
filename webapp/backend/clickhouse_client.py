# -*- coding: utf-8 -*-
"""Thin ClickHouse wrapper — schema bootstrap, batch insert, range queries."""

import datetime
import os
import time
from typing import Optional

import clickhouse_connect

from . import config


def get_client():
    return clickhouse_connect.get_client(
        host=config.CLICKHOUSE_HOST,
        port=config.CLICKHOUSE_PORT,
        username=config.CLICKHOUSE_USER,
        password=config.CLICKHOUSE_PASSWORD,
        database=config.CLICKHOUSE_DATABASE,
    )


def ensure_schema(client):
    """Idempotent — safe to call on every backend startup."""
    schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")
    with open(schema_path, "r", encoding="utf-8") as f:
        statements = [s.strip() for s in f.read().split(";") if s.strip()]
    for stmt in statements:
        client.command(stmt)


def _epoch(dt: datetime.datetime) -> float:
    """clickhouse-connect may return naive datetimes even for tz-aware
    columns depending on driver settings — always treat them as UTC,
    since every row is written as UTC (see insert_frame)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.timestamp()


def _dt(ts: float) -> datetime.datetime:
    return datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)


def _fmt(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts))


def insert_frame(client, ts: float, source: str, channels: dict, satellite_id: str = ""):
    """Insert one telemetry frame as N rows (one per channel) in a single call."""
    if not channels:
        return
    dt = _dt(ts)
    rows = [[dt, source, name, value, satellite_id] for name, value in channels.items()]
    client.insert(
        "telemetry",
        rows,
        column_names=["ts", "source", "channel", "value", "satellite_id"],
        column_type_names=["DateTime64(3, 'UTC')", "String", "String", "Float64", "String"],
    )


def query_history(client, channel: str, start: float, end: float, satellite_id: Optional[str] = None):
    sat_clause = " AND satellite_id = {satellite_id:String}" if satellite_id else ""
    params = {"channel": channel, "start": _fmt(start), "end": _fmt(end)}
    if satellite_id:
        params["satellite_id"] = satellite_id
    result = client.query(
        "SELECT ts, value FROM telemetry "
        "WHERE channel = {channel:String} AND ts >= {start:DateTime64(3)} AND ts <= {end:DateTime64(3)}"
        + sat_clause + " ORDER BY ts",
        parameters=params,
    )
    return [{"ts": _epoch(row[0]), "value": row[1]} for row in result.result_rows]


def query_latest(client, satellite_id: Optional[str] = None):
    sat_clause = " WHERE satellite_id = {satellite_id:String}" if satellite_id else ""
    params = {"satellite_id": satellite_id} if satellite_id else {}
    result = client.query(
        "SELECT channel, argMax(value, ts) AS value, max(ts) AS last_ts "
        f"FROM telemetry{sat_clause} GROUP BY channel ORDER BY channel",
        parameters=params,
    )
    return [
        {"channel": row[0], "value": row[1], "ts": _epoch(row[2])}
        for row in result.result_rows
    ]


def query_channels(client):
    result = client.query("SELECT DISTINCT channel FROM telemetry ORDER BY channel")
    return [row[0] for row in result.result_rows]


def insert_message(
    client, ts: float, satellite_id: str, source: str,
    pkt_type: int, pkt_type_name: str, decoded: bool, error: str, size_bytes: int,
):
    client.insert(
        "messages",
        [[_dt(ts), satellite_id, source, pkt_type, pkt_type_name, 1 if decoded else 0, error, size_bytes]],
        column_names=["ts", "satellite_id", "source", "pkt_type", "pkt_type_name", "decoded", "error", "size_bytes"],
        column_type_names=[
            "DateTime64(3, 'UTC')", "String", "String", "UInt16", "String", "UInt8", "String", "UInt32",
        ],
    )


def query_messages(
    client,
    start: Optional[float] = None,
    end: Optional[float] = None,
    satellite_id: Optional[str] = None,
    pkt_type: Optional[int] = None,
    source: Optional[str] = None,
    decoded: Optional[bool] = None,
    limit: int = 200,
):
    clauses = []
    params: dict = {"limit": limit}
    if start is not None:
        clauses.append("ts >= {start:DateTime64(3)}")
        params["start"] = _fmt(start)
    if end is not None:
        clauses.append("ts <= {end:DateTime64(3)}")
        params["end"] = _fmt(end)
    if satellite_id:
        clauses.append("satellite_id = {satellite_id:String}")
        params["satellite_id"] = satellite_id
    if pkt_type is not None:
        clauses.append("pkt_type = {pkt_type:UInt16}")
        params["pkt_type"] = pkt_type
    if source:
        clauses.append("source = {source:String}")
        params["source"] = source
    if decoded is not None:
        clauses.append("decoded = {decoded:UInt8}")
        params["decoded"] = 1 if decoded else 0

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    result = client.query(
        "SELECT ts, satellite_id, source, pkt_type, pkt_type_name, decoded, error, size_bytes "
        f"FROM messages {where} ORDER BY ts DESC LIMIT {{limit:UInt32}}",
        parameters=params,
    )
    return [
        {
            "ts": _epoch(row[0]), "satellite_id": row[1], "source": row[2],
            "pkt_type": row[3], "pkt_type_name": row[4], "decoded": bool(row[5]),
            "error": row[6], "size_bytes": row[7],
        }
        for row in result.result_rows
    ]
