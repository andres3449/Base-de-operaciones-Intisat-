# -*- coding: utf-8 -*-
"""INTISAT web monitoring backend — FastAPI app.

Run natively on Windows (not in Docker) alongside the PyQt5 app:

    uvicorn webapp.backend.main:app --host 0.0.0.0 --port 8000

Requires ClickHouse running (docker compose -f docker-compose.web.yml up -d)
and, ideally, the PyQt5 app running so Core/telemetry_publisher.py has
something to publish — the backend still starts fine without it and will
just show zero frames in /api/status until the app connects.
"""

import asyncio
import contextlib
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from . import clickhouse_client, config, spectrum_stream, zmq_ingest
from .routers import auth, images, messages, satellite, schedule, sdr_scan, sdr_runtime, status, telemetry
from .ws_manager import manager


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        clickhouse_client.ensure_schema(clickhouse_client.get_client())
    except Exception as e:
        print(f"[main] ADVERTENCIA: ClickHouse no disponible, sigue sin historial/persistencia: {e}")
    zmq_ingest.start(asyncio.get_running_loop())
    spectrum_stream.start(asyncio.get_running_loop())
    yield
    zmq_ingest.stop()
    spectrum_stream.stop()


app = FastAPI(title="INTISAT Ground Station — Monitoring Room", lifespan=lifespan)
app.include_router(telemetry.router)
app.include_router(status.router)
app.include_router(schedule.router)
app.include_router(images.router)
app.include_router(auth.router)
app.include_router(satellite.router)
app.include_router(messages.router)
app.include_router(sdr_scan.router)
app.include_router(sdr_runtime.router)


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            # Client doesn't need to send anything; just keep the connection open.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(ws)


@app.websocket("/ws/spectrum")
async def ws_spectrum(ws: WebSocket):
    await spectrum_stream.manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await spectrum_stream.manager.disconnect(ws)


# Serve the built React app (npm run build in webapp/frontend) if present.
if os.path.isdir(config.FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="frontend")
