"""Seed/import API routes."""
from fastapi import APIRouter

router = APIRouter(prefix="/seed", tags=["seed"])

@router.post("")
async def seed():
    return {"accepted": True, "job_id": None}
