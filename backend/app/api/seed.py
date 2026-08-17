from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..repositories import D1Repository
from ..services.system.data import DataService
from .deps import get_db

router=APIRouter(prefix="/seed",tags=["seed"])

def get_data(settings:Settings=Depends(get_settings),db:D1Repository=Depends(get_db))->DataService:
    return DataService(settings,db)

class SeedChunk(BaseModel):
    filename: str = "library.csv"
    job_id: str | None = None
    rows: list[dict[str, Any]]
    total: int
    done: bool = False

@router.post("")
async def seed(file:UploadFile=File(...),service:DataService=Depends(get_data)):
    if not (file.filename or "").lower().endswith(".csv"): raise HTTPException(415,"CSV file required")
    content=await file.read()
    if len(content)>2_000_000:
        raise HTTPException(413,"CSV is too large for a single request; use the chunked importer")
    return await service.import_csv(file.filename or "library.csv",content)

@router.post("/chunk")
async def seed_chunk(payload:SeedChunk,service:DataService=Depends(get_data)):
    if not payload.rows or len(payload.rows)>DataService.SEED_CHUNK_SIZE:
        raise HTTPException(400,f"chunk must contain 1-{DataService.SEED_CHUNK_SIZE} rows")
    try:
        job_id=payload.job_id or await service.start_import(payload.filename,payload.total)
        return await service.import_chunk(job_id,payload.rows,payload.done)
    except ValueError as exc:
        raise HTTPException(404,str(exc)) from exc

@router.get("/{job_id}")
async def seed_status(job_id:str,service:DataService=Depends(get_data)):
    item=await service.import_job(job_id)
    if not item: raise HTTPException(404,"Import job not found")
    return {"ok":True,"item":item}
