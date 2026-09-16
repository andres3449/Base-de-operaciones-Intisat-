# -*- coding: utf-8 -*-
from typing import Optional

from fastapi import APIRouter, Cookie, HTTPException, Response
from pydantic import BaseModel

from .. import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginIn, response: Response):
    if not auth.verify_credentials(body.username, body.password):
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")
    token = auth.create_session()
    response.set_cookie(
        auth.SESSION_COOKIE,
        token,
        max_age=auth.SESSION_TTL_S,
        httponly=True,
        samesite="lax",
    )
    return {"ok": True}


@router.post("/logout")
def logout(response: Response, intisat_session: Optional[str] = Cookie(default=None)):
    if intisat_session:
        auth.destroy_session(intisat_session)
    response.delete_cookie(auth.SESSION_COOKIE)
    return {"ok": True}


@router.get("/me")
def me(intisat_session: Optional[str] = Cookie(default=None)):
    return {"authenticated": auth.is_valid(intisat_session)}
