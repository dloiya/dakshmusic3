"""Generic CRUD and destructive system operations."""
from fastapi import APIRouter

router = APIRouter(prefix="/crud", tags=["crud"])

@router.get("/health")
async def crud_health():
    return {"ok": True}

@router.delete("/all")
async def clear_all():
    return {"accepted": True}
