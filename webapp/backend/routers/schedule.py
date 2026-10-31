# -*- coding: utf-8 -*-
import uuid
from datetime import datetime
from threading import RLock

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from .. import headless_config
from ..auth import require_auth
from Core.mcu_commands import COMMAND_REFERENCE

router = APIRouter(prefix="/api", tags=["schedule"], dependencies=[Depends(require_auth)])
_schedule_lock = RLock()


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


class SchedulePatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool | None = None
    command: str | None = None
    window_start: str | None = None
    window_end: str | None = None
    interval_s: int | None = None
    fire_at: str | None = None


def validate_times(row: dict, kind: str):
    try:
        names = ('window_start', 'window_end') if kind == 'recurring' else ('fire_at',)
        dates = [datetime.fromisoformat(row[k].replace('Z', '+00:00')) for k in names]
        if any(d.tzinfo is None for d in dates):
            raise ValueError('Use timezone-aware UTC dates')
        if kind == 'recurring' and (dates[1] <= dates[0] or row['interval_s'] < 1):
            raise ValueError('End must follow start and interval must be positive')
        if not row.get('command', '').strip():
            raise ValueError('Command is required')
    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(422, str(error))


@router.patch('/schedule/{kind}/{entry_id}')
def update_entry(kind: str, entry_id: str, update: SchedulePatch):
    if kind not in ('recurring', 'once'):
        raise HTTPException(400, "kind must be 'recurring' or 'once'")
    changes = update.model_dump(exclude_none=True)
    allowed = {'enabled', 'command'} | ({'window_start', 'window_end', 'interval_s'} if kind == 'recurring' else {'fire_at'})
    if not changes or not set(changes) <= allowed:
        raise HTTPException(422, 'Invalid fields for this schedule kind')
    with _schedule_lock:
        schedule = headless_config.read_schedule()
        row = next((e for e in schedule.get(kind, []) if e.get('id') == entry_id), None)
        if row is None:
            raise HTTPException(404, 'entry not found')
        candidate = {**row, **changes}
        # Toggling a legacy entry preserves its scheduling and firing metadata.
        if set(changes) != {'enabled'}:
            validate_times(candidate, kind)
        row.update(changes)
        headless_config.write_schedule(schedule)
        return row
