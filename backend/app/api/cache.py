"""Cache API routes."""
from fastapi import APIRouter

router = APIRouter(prefix="/cache", tags=["cache"])

@router.get("/status")
async def cache_status():
    return {"items": [], "active": 0}

@router.post("/populate")
async def populate_cache():
    return {"accepted": True, "job_id": None}
