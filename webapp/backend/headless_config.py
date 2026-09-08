# -*- coding: utf-8 -*-
"""Reads/writes the YAML config shared with headless_receiver.py (same
server, same filesystem). This is the single source of truth for the
schedule and the images directory — see Core/mcu_commands.py and
headless_receiver.py::ScheduleRunner for the process that consumes it.
"""

import os

import yaml

from . import config

_EMPTY_SCHEDULE = {"recurring": [], "once": []}


def read_full() -> dict:
    try:
        with open(config.HEADLESS_CONFIG_PATH, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}


def read_schedule() -> dict:
    cfg = read_full()
    return cfg.get("schedule") or dict(_EMPTY_SCHEDULE)


def write_schedule(schedule: dict) -> None:
    cfg = read_full()
    cfg["schedule"] = schedule
    with open(config.HEADLESS_CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)


def read_images_dir() -> str:
    images_dir = read_full().get("images_dir", "./images")
    if not os.path.isabs(images_dir):
        # Relative to headless_receiver.yaml's own directory — matches
        # headless_receiver.py, which is expected to run from the repo root
        # (same directory the YAML lives in).
        images_dir = os.path.normpath(
            os.path.join(os.path.dirname(config.HEADLESS_CONFIG_PATH), images_dir)
        )
    return images_dir
