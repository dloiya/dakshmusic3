"""Search API routes."""
from fastapi import APIRouter, Query

router = APIRouter(prefix="/search", tags=["search"])

@router.get("")
async def search(q: str = Query(..., min_length=1)):
    return {"query": q, "items": []}
