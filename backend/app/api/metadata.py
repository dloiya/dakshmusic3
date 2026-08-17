from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..repositories import D1Repository
from ..services.system.data import DataService
from .deps import get_db

router = APIRouter(prefix="/metadata", tags=["metadata"])


def get_data(settings: Settings = Depends(get_settings), db: D1Repository = Depends(get_db)) -> DataService:
    return DataService(settings, db)


class MetadataChunk(BaseModel):
    rows: list[dict[str, Any]]


@router.post("/chunk")
async def metadata_chunk(payload: MetadataChunk, service: DataService = Depends(get_data)):
    try:
        return {"ok": True, **await service.enrich_metadata_chunk(payload.rows)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
