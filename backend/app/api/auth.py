"""Authentication API routes."""
from fastapi import APIRouter

router = APIRouter(prefix="/auth", tags=["auth"])

@router.get("/session")
async def session_status():
    return {"authenticated": False}
