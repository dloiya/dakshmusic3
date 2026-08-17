from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from .config import get_settings
from .core.errors import AppError
from .connectors.cloudflare.bindings import set_worker_env, reset_worker_env
from .api.auth import router as auth_router
from .api.library import router as library_router
from .api.playlist import router as playlist_router
from .api.queue import router as queue_router
from .api.search import router as search_router
from .api.acquire import router as acquire_router
from .api.seed import router as seed_router
from .api.cache import router as cache_router
from .api.status import router as status_router
from .api.crud import router as crud_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


settings = get_settings()
app = FastAPI(title=settings.app_name, version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def worker_binding_context(request: Request, call_next):
    env = request.scope.get("env")
    token = set_worker_env(env) if env is not None else None
    try:
        return await call_next(request)
    finally:
        if token is not None:
            reset_worker_env(token)


@app.exception_handler(AppError)
async def app_error_handler(_, exc: AppError):
    from fastapi.responses import JSONResponse
    return JSONResponse({"ok": False, "error": exc.message}, status_code=exc.status_code)


@app.get("/health")
async def health():
    return {"ok": True, "service": settings.app_name, "version": "2.0.0"}


for router in (auth_router, library_router, playlist_router, queue_router, search_router, acquire_router, seed_router, cache_router, status_router, crud_router):
    app.include_router(router, prefix=settings.api_prefix)
