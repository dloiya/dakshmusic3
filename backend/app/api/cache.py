from __future__ import annotations

from fastapi import APIRouter, Depends
from ..services.cache.service import CacheService
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/cache", tags=["cache"])


@router.get("/status")
async def cache_status(store: Store = Depends(get_store), _: str = Depends(require_session)):
    return await CacheService(store.settings, store).status()


@router.post("/populate")
async def populate_cache(limit: int = 100, store: Store = Depends(get_store), _: str = Depends(require_session)):
    return await CacheService(store.settings, store).populate(limit)
