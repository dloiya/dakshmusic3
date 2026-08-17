"""Playlist API routes."""
from fastapi import APIRouter

router = APIRouter(prefix="/playlist", tags=["playlist"])

@router.get("")
async def get_playlist():
    return {"items": []}
