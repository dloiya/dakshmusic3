from __future__ import annotations
from fastapi import APIRouter, Depends
from ..config import Settings, get_settings
from ..repositories import D1Repository
from ..services.system.data import DataService
from .deps import get_db, require_session

router=APIRouter(prefix="/crud",tags=["crud"])

def get_data(settings:Settings=Depends(get_settings),db:D1Repository=Depends(get_db))->DataService:
    return DataService(settings,db)

@router.delete("/all")
@router.post("/clear-all")
async def clear_all(include_audio:bool=True,service:DataService=Depends(get_data),_:str=Depends(require_session)):
    return await service.clear_all(include_audio)
