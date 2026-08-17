from __future__ import annotations

from fastapi import APIRouter, Depends
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/crud", tags=["crud"])


@router.delete("/all")
async def clear_all(include_audio: bool = True, store: Store = Depends(get_store), _: str = Depends(require_session)):
    return await store.clear_all(include_audio)
