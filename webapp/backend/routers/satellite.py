# -*- coding: utf-8 -*-
import os

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from .. import satellite_config
from ..auth import require_auth

router = APIRouter(prefix="/api/satellite", tags=["satellite"], dependencies=[Depends(require_auth)])

_DECODER_FILE = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "Core", "SDR", "telemetry_assembler.py")
)


class SatelliteIn(BaseModel):
    id: str
    name: str


class ReceptionIn(BaseModel):
    driver: str
    method: str
    modulation: str
    frequency_mhz: float
    gain_db: float
    sync_word: str


class SatelliteConfigIn(BaseModel):
    satellite: SatelliteIn
    reception: ReceptionIn


@router.get("")
def get_satellite():
    return satellite_config.read()


@router.put("")
def put_satellite(body: SatelliteConfigIn):
    data = body.model_dump()
    satellite_config.write(data)
    return data


@router.get("/decoder-file", response_class=PlainTextResponse)
def get_decoder_file():
    with open(_DECODER_FILE, "r", encoding="utf-8") as f:
        return f.read()
