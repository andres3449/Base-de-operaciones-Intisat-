"""Authenticated, bounded receive-only configuration bridge to the C backend.

One REQ socket per request avoids poisoned sockets after a timeout. An ACK
means the C command was accepted; the existing protocol has no hardware readback.
"""
import os
from typing import Literal

import zmq
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..auth import require_auth

router = APIRouter(prefix='/api/sdr', tags=['sdr'], dependencies=[Depends(require_auth)])
ENDPOINT = os.environ.get('INTISAT_SDR_COMMAND_ENDPOINT', 'tcp://127.0.0.1:5556')


class RuntimeUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    center_freq_hz: float | None = Field(default=None, ge=100_000, le=2_000_000_000)
    rf_gain_db: float | None = Field(default=None, ge=0, le=100)
    symbol_rate_sps: int | None = Field(default=None, ge=1, le=250_000)
    freq_deviation_hz: int | None = Field(default=None, ge=1, le=125_000)
    rx_bandwidth_hz: int | None = Field(default=None, ge=1, le=250_000)
    sync_power_gate: float | None = Field(default=None, ge=0, le=1)
    modulation_type: Literal['2FSK', '2GFSK', '4FSK', '4GFSK'] | None = None
    sync_word: list[int] | None = Field(default=None, min_length=4, max_length=4)
    packet_length: int | None = Field(default=None, ge=1, le=255)

    @model_validator(mode='after')
    def validate_update(self):
        if not self.model_dump(exclude_none=True):
            raise ValueError('Choose at least one receive parameter')
        if self.sync_word and any(b < 0 or b > 255 for b in self.sync_word):
            raise ValueError('Sync bytes must be between 0 and 255')
        return self


def send_receive_config(values: dict) -> dict:
    socket = zmq.Context.instance().socket(zmq.REQ)
    socket.setsockopt(zmq.LINGER, 0)
    socket.setsockopt(zmq.SNDTIMEO, 2000)
    socket.setsockopt(zmq.RCVTIMEO, 5000)
    try:
        socket.connect(ENDPOINT)
        remaining = {k: v for k, v in values.items() if k != 'center_freq_hz'}
        commands = ([{'cmd': 'UPDATE_CONFIG', 'config': remaining}] if remaining else [])
        # UPDATE_CONFIG updates DSP tuning state; SET_FREQ also retunes hardware.
        if 'center_freq_hz' in values:
            commands.append({'cmd': 'SET_FREQ', 'value': values['center_freq_hz']})
        for command in commands:
            socket.send_json(command)
            reply = socket.recv_json()
            if not isinstance(reply, dict) or reply.get('status') != 'ok':
                raise HTTPException(502, 'SDR rejected a receive command; partial changes may have occurred')
        return {'status': 'acknowledged', 'requested': values, 'hardware_verified': False}
    except zmq.Again:
        raise HTTPException(504, 'No SDR acknowledgement. Runtime state is unknown; verify before retrying.')
    except (zmq.ZMQError, ValueError):
        raise HTTPException(502, 'SDR communication failed; runtime state is unknown')
    finally:
        socket.close(0)


@router.post('/runtime')
def update_runtime(update: RuntimeUpdate):
    return send_receive_config(update.model_dump(exclude_none=True))
