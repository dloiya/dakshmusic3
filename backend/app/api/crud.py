from fastapi import APIRouter, Depends
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client
from ..connectors.cloudflare.r2 import R2Client
from ..services.system.auth import require_session

router = APIRouter(prefix="/crud", tags=["crud"])


@router.delete("/clear-all")
async def clear_all(settings: Settings = Depends(get_settings), _: str = Depends(require_session)):
    db = D1Client(settings)
    await db.query("DELETE FROM cache_objects")
    await db.query("DELETE FROM queue_entries")
    await db.query("DELETE FROM queue_state")
    await db.query("DELETE FROM playlist_entries")
    await db.query("DELETE FROM acquisition_jobs")
    await db.query("DELETE FROM import_jobs")
    await db.query("DELETE FROM tracks")
    await db.query("DELETE FROM albums")
    deleted_objects = R2Client(settings).delete_all()
    return {"ok": True, "r2_deleted": deleted_objects}
