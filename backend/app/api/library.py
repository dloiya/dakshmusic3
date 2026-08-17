"""Library API routes."""
from fastapi import APIRouter

router = APIRouter(prefix="/library", tags=["library"])

@router.get("/tracks")
async def list_tracks():
    return {"items": []}
