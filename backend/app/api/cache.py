from __future__ import annotations
from fastapi import APIRouter, Depends
from ..config import Settings, get_settings
from ..repositories import AcquisitionRepository, CacheRepository, D1Repository, LibraryRepository
from ..services.acquisition.acquire import AcquisitionService
from ..services.cache.service import CacheService
from .deps import get_db

router=APIRouter(prefix="/cache",tags=["cache"])

def get_cache(settings:Settings=Depends(get_settings),db:D1Repository=Depends(get_db))->CacheService:
    jobs=AcquisitionRepository(db)
    acquisition=AcquisitionService(settings,jobs,LibraryRepository(db))
    return CacheService(CacheRepository(db),jobs,acquisition,settings)

@router.get("/status")
async def cache_status(service:CacheService=Depends(get_cache)):
    return await service.status()

@router.post("/populate")
async def populate_cache(limit:int|None=None,service:CacheService=Depends(get_cache)):
    return await service.populate(limit)
