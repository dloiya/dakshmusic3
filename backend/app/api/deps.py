from __future__ import annotations

from fastapi import Depends
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client
from ..repositories import D1Repository


def get_db(settings: Settings = Depends(get_settings)) -> D1Repository:
    return D1Repository(D1Client(settings))
