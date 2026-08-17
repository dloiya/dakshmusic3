from fastapi import APIRouter
from .library import router as library_router
from .playlist import router as playlist_router
from .queue import router as queue_router
from .search import router as search_router
from .acquire import router as acquire_router
from .seed import router as seed_router
from .cache import router as cache_router
from .status import router as status_router
from .crud import router as crud_router

router = APIRouter(prefix="/api/v1")
for child in (library_router, playlist_router, queue_router, search_router, acquire_router, seed_router, cache_router, status_router, crud_router):
    router.include_router(child)
