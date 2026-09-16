# -*- coding: utf-8 -*-
"""Usuario/contraseña fijo para proteger Configuración + Programación.

Sin dependencias nuevas: hashlib.pbkdf2_hmac (stdlib) para el password,
un token de sesión aleatorio guardado en memoria (server-side) con
expiración, entregado al cliente como cookie httpOnly.

No es multi-usuario ni pretende serlo — es LAN-only, un solo admin fijo
definido por INTISAT_ADMIN_USER / INTISAT_ADMIN_PASSWORD (ver config.py).
"""

import hashlib
import hmac
import secrets
import time
from typing import Optional

from fastapi import Cookie, HTTPException

from . import config

SESSION_COOKIE = "intisat_session"
SESSION_TTL_S = 8 * 3600  # 8 horas

_PBKDF2_ITERATIONS = 200_000
_SALT = b"intisat-static-salt-v1"  # fijo: un solo admin, no hay tabla de usuarios que proteger entre si

# token -> expiry epoch
_sessions = {}  # type: dict


def _hash_password(password: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), _SALT, _PBKDF2_ITERATIONS)


def verify_credentials(username: str, password: str) -> bool:
    user_ok = hmac.compare_digest(username, config.ADMIN_USERNAME)
    pass_ok = hmac.compare_digest(_hash_password(password), _hash_password(config.ADMIN_PASSWORD))
    return user_ok and pass_ok


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    _sessions[token] = time.time() + SESSION_TTL_S
    return token


def destroy_session(token: str) -> None:
    _sessions.pop(token, None)


def is_valid(token: Optional[str]) -> bool:
    if not token:
        return False
    expiry = _sessions.get(token)
    if expiry is None:
        return False
    if expiry < time.time():
        _sessions.pop(token, None)
        return False
    return True


def require_auth(intisat_session: Optional[str] = Cookie(default=None)) -> None:
    """FastAPI dependency — raise 401 unless a valid session cookie is present."""
    if not is_valid(intisat_session):
        raise HTTPException(status_code=401, detail="No autenticado")
