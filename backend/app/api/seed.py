from __future__ import annotations
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from ..config import Settings, get_settings
from ..repositories import D1Repository
from ..services.system.data import DataService
from .deps import get_db, require_session

router=APIRouter(prefix="/seed",tags=["seed"])

def get_data(settings:Settings=Depends(get_settings),db:D1Repository=Depends(get_db))->DataService:
    return DataService(settings,db)

@router.post("")
async def seed(file:UploadFile=File(...),service:DataService=Depends(get_data),_:str=Depends(require_session)):
    if not (file.filename or "").lower().endswith(".csv"):raise HTTPException(415,"CSV file required")
    return await service.import_csv(file.filename or "library.csv",await file.read())

@router.get("/{job_id}")
async def seed_status(job_id:str,service:DataService=Depends(get_data),_:str=Depends(require_session)):
    item=await service.import_job(job_id)
    if not item:raise HTTPException(404,"Import job not found")
    return {"ok":True,"item":item}
