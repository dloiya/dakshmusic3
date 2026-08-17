"""Queue API routes."""
from fastapi import APIRouter

router = APIRouter(prefix="/queue", tags=["queue"])

@router.get("")
async def get_queue():
    return {"items": [], "current_index": 0, "shuffle": False}
