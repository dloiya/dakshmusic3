from __future__ import annotations
from fastapi import APIRouter, Depends
from ..repositories import AcquisitionRepository, D1Repository
from .deps import get_db

router=APIRouter(prefix="/status",tags=["status"])

@router.get("")
async def status(db:D1Repository=Depends(get_db)):
    return await AcquisitionRepository(db).status()

@router.get("/health")
async def health(db:D1Repository=Depends(get_db)):
    try:
        row=await db.one("SELECT 1 AS ok")
        return {"ok":bool(row and row["ok"]==1),"database":True}
    except Exception as exc:
        return {"ok":False,"database":False,"error":str(exc)}
