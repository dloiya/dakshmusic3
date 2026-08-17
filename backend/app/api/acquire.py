from __future__ import annotations
import hmac
from typing import Any
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..repositories import AcquisitionRepository, D1Repository, LibraryRepository
from ..services.acquisition.acquire import AcquisitionService
from .deps import get_db, require_session

router=APIRouter(prefix="/acquire",tags=["acquisition"])
class AcquireRequest(BaseModel): track_id:int

def get_acquisition(settings:Settings=Depends(get_settings),db:D1Repository=Depends(get_db))->AcquisitionService:
    return AcquisitionService(settings,AcquisitionRepository(db),LibraryRepository(db))

@router.post("")
async def acquire(body:AcquireRequest,service:AcquisitionService=Depends(get_acquisition),_:str=Depends(require_session)):
    try:return {"ok":True,**await service.acquire(body.track_id)}
    except ValueError as exc:raise HTTPException(404,str(exc))
    except Exception as exc:raise HTTPException(502,f"Acquire worker dispatch failed: {exc}")

@router.get("")
async def acquisition_jobs(limit:int=100,db:D1Repository=Depends(get_db),_:str=Depends(require_session)):
    return {"ok":True,"items":await AcquisitionRepository(db).list(False)}

@router.get("/status")
async def acquisition_status(db:D1Repository=Depends(get_db),_:str=Depends(require_session)):
    return await AcquisitionRepository(db).status()

@router.post("/callback")
async def worker_callback(payload:dict[str,Any],authorization:str|None=Header(default=None),settings:Settings=Depends(get_settings),db:D1Repository=Depends(get_db)):
    expected=settings.worker_callback_secret
    if not expected or not authorization or not hmac.compare_digest(authorization,f"Bearer {expected}"):raise HTTPException(401,"Invalid worker credentials")
    job_id,status=payload.get("job_id"),payload.get("status")
    if not job_id or status not in {"running","complete","failed","cancelled"}:raise HTTPException(400,"Invalid worker callback")
    repo=AcquisitionRepository(db); await repo.update(job_id,status,payload.get("error"))
    if status=="complete" and payload.get("storage_key"):
        await db.execute("UPDATE tracks SET storage_key=?,duration_ms=COALESCE(?,duration_ms),storage_status='available',updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT track_id FROM acquisition_jobs WHERE id=?)",[payload["storage_key"],payload.get("duration_ms"),job_id])
        await db.execute("INSERT OR REPLACE INTO cache_objects(track_id,scope,scope_id,storage_key,status,size_bytes,last_accessed_at) SELECT track_id,'server',NULL,?,?,CURRENT_TIMESTAMP FROM acquisition_jobs WHERE id=?",[payload["storage_key"],"available",payload.get("size_bytes"),job_id])
    return {"ok":True}

@router.get("/{job_id}")
async def acquisition_job(job_id:str,db:D1Repository=Depends(get_db),_:str=Depends(require_session)):
    item=await AcquisitionRepository(db).get(job_id)
    if not item:raise HTTPException(404,"Acquisition job not found")
    return {"ok":True,"item":item}

@router.post("/{job_id}/cancel")
async def cancel_job(job_id:str,db:D1Repository=Depends(get_db),_:str=Depends(require_session)):
    repo=AcquisitionRepository(db)
    if not await repo.get(job_id):raise HTTPException(404,"Acquisition job not found")
    await repo.update(job_id,"cancelled");return {"ok":True}

@router.post("/{job_id}/retry")
async def retry_job(job_id:str,service:AcquisitionService=Depends(get_acquisition),db:D1Repository=Depends(get_db),_:str=Depends(require_session)):
    repo=AcquisitionRepository(db); job=await repo.get(job_id)
    if not job:raise HTTPException(404,"Acquisition job not found")
    await repo.update(job_id,"cancelled"); new_id,_=await repo.create(job["track_id"])
    try:await service.dispatch_job(new_id,job["track_id"])
    except Exception as exc:await repo.update(new_id,"failed",str(exc));raise HTTPException(502,f"Acquire worker dispatch failed: {exc}")
    return {"ok":True,"job_id":new_id}
