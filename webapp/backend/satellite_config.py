# -*- coding: utf-8 -*-
"""Reads/writes satellite_config.yaml (repo root, shared with
headless_receiver.py). Same pattern as headless_config.py.
"""

import yaml

from . import config

_DEFAULT = {
    "satellite": {"id": "INTISAT-1", "name": "INTISAT"},
    "reception": {
        "driver": "mcu",
        "method": "uart8a",
        "modulation": "GFSK",
        "frequency_mhz": 437.5,
        "gain_db": 40,
        "sync_word": "D391D391",
    },
}


def read() -> dict:
    try:
        with open(config.SATELLITE_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        return dict(_DEFAULT)
    merged = dict(_DEFAULT)
    merged.update(data)
    return merged


def write(data: dict) -> None:
    with open(config.SATELLITE_CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
