# -*- coding: utf-8 -*-
"""Configuration for the INTISAT web monitoring backend.

Values come from config.yaml (next to this file); any of them can be
overridden with an environment variable INTISAT_<NAME> without touching
the YAML, e.g. INTISAT_CH_HOST=192.168.1.50 for a different ClickHouse host.
"""

import os

import yaml

_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")

with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
    _cfg = yaml.safe_load(f)


def _get(env_name: str, section: str, key: str, cast=str):
    env_val = os.environ.get(f"INTISAT_{env_name}")
    return cast(env_val) if env_val is not None else cast(_cfg[section][key])


# ZMQ bridge published by Core/telemetry_publisher.py inside the PyQt5 app.
ZMQ_ENDPOINT = _get("ZMQ_ENDPOINT", "zmq", "endpoint")

# ClickHouse (matches docker-compose.web.yml)
CLICKHOUSE_HOST = _get("CH_HOST", "clickhouse", "host")
CLICKHOUSE_PORT = _get("CH_PORT", "clickhouse", "port", int)
CLICKHOUSE_USER = _get("CH_USER", "clickhouse", "user")
CLICKHOUSE_PASSWORD = _get("CH_PASSWORD", "clickhouse", "password")
CLICKHOUSE_DATABASE = _get("CH_DB", "clickhouse", "database")

# Web server
HOST = _get("WEB_HOST", "web", "host")
PORT = _get("WEB_PORT", "web", "port", int)

# Built React static assets (produced by `npm run build` in webapp/frontend)
FRONTEND_DIST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "dist"
)

# headless_receiver.py's YAML — shared filesystem, same server. Resolved
# relative to this file so the default works from any cwd.
_headless_path = _get("HEADLESS_CONFIG_PATH", "headless", "config_path")
HEADLESS_CONFIG_PATH = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), _headless_path)
)
