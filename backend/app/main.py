from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .core.errors import AppError
from .api.status import router as status_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


settings = get_settings()
app = FastAPI(title=settings.app_name, version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def app_error_handler(_, exc: AppError):
    from fastapi.responses import JSONResponse
    return JSONResponse({"ok": False, "error": exc.message}, status_code=exc.status_code)


@app.get("/health")
async def health():
    return {"ok": True, "service": settings.app_name, "version": "2.0.0"}


app.include_router(status_router, prefix=settings.api_prefix)
