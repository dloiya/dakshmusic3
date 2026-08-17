from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/seed", tags=["seed"])


@router.post("")
async def seed(file: UploadFile = File(...), store: Store = Depends(get_store), _: str = Depends(require_session)):
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(415, "CSV file required")
    return await store.import_csv(file.filename or "library.csv", await file.read())


@router.get("/{job_id}")
async def seed_status(job_id: str, store: Store = Depends(get_store), _: str = Depends(require_session)):
    item = await store.import_job(job_id)
    if not item:
        raise HTTPException(404, "Import job not found")
    return {"ok": True, "item": item}
