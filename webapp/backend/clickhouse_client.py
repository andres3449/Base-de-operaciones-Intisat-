# -*- coding: utf-8 -*-
"""Thin ClickHouse wrapper — schema bootstrap, batch insert, range queries."""

import datetime
import os
import time

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


def insert_frame(client, ts: float, source: str, channels: dict):
    """Insert one telemetry frame as N rows (one per channel) in a single call."""
    if not channels:
        return
    dt = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
    rows = [[dt, source, name, value] for name, value in channels.items()]
    client.insert(
        "telemetry",
        rows,
        column_names=["ts", "source", "channel", "value"],
        column_type_names=["DateTime64(3, 'UTC')", "String", "String", "Float64"],
    )


def query_history(client, channel: str, start: float, end: float):
    result = client.query(
        "SELECT ts, value FROM telemetry "
        "WHERE channel = {channel:String} AND ts >= {start:DateTime64(3)} AND ts <= {end:DateTime64(3)} "
        "ORDER BY ts",
        parameters={
            "channel": channel,
            "start": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(start)),
            "end": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(end)),
        },
    )
    return [{"ts": _epoch(row[0]), "value": row[1]} for row in result.result_rows]


def query_latest(client):
    result = client.query(
        "SELECT channel, argMax(value, ts) AS value, max(ts) AS last_ts "
        "FROM telemetry GROUP BY channel ORDER BY channel"
    )
    return [
        {"channel": row[0], "value": row[1], "ts": _epoch(row[2])}
        for row in result.result_rows
    ]


def query_channels(client):
    result = client.query("SELECT DISTINCT channel FROM telemetry ORDER BY channel")
    return [row[0] for row in result.result_rows]
