# -*- coding: utf-8 -*-
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import headless_config
from Core.mcu_commands import COMMAND_REFERENCE

router = APIRouter(prefix="/api", tags=["schedule"])


class RecurringIn(BaseModel):
    command: str
    window_start: str   # ISO 8601
    window_end: str     # ISO 8601
    interval_s: int
    enabled: bool = True


class OnceIn(BaseModel):
    command: str
    fire_at: str         # ISO 8601
    enabled: bool = True


@router.get("/commands")
def list_commands():
    return {"commands": COMMAND_REFERENCE}


@router.get("/schedule")
def get_schedule():
    return headless_config.read_schedule()


@router.post("/schedule/recurring")
def add_recurring(entry: RecurringIn):
    schedule = headless_config.read_schedule()
    row = entry.model_dump()
    row["id"] = str(uuid.uuid4())[:8]
    row["last_fired_at"] = None
    schedule.setdefault("recurring", []).append(row)
    headless_config.write_schedule(schedule)
    return row


@router.post("/schedule/once")
def add_once(entry: OnceIn):
    schedule = headless_config.read_schedule()
    row = entry.model_dump()
    row["id"] = str(uuid.uuid4())[:8]
    row["fired"] = False
    schedule.setdefault("once", []).append(row)
    headless_config.write_schedule(schedule)
    return row


@router.delete("/schedule/{kind}/{entry_id}")
def delete_entry(kind: str, entry_id: str):
    if kind not in ("recurring", "once"):
        raise HTTPException(400, "kind must be 'recurring' or 'once'")
    schedule = headless_config.read_schedule()
    before = len(schedule.get(kind, []))
    schedule[kind] = [e for e in schedule.get(kind, []) if e.get("id") != entry_id]
    if len(schedule[kind]) == before:
        raise HTTPException(404, "entry not found")
    headless_config.write_schedule(schedule)
    return {"deleted": entry_id}
