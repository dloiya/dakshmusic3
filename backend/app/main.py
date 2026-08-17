from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from .config import get_settings
from .api.v2_router import router
from .connectors.cloudflare.d1 import D1Client

settings = get_settings()
app = FastAPI(title=settings.app_name, version="2.0.0", docs_url=None if settings.environment == "production" else "/docs", redoc_url=None if settings.environment == "production" else "/redoc")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Requested-With"],
)


@app.get("/health", tags=["system"])
async def health():
    try:
        await D1Client(settings).query("SELECT 1 AS ok")
    except Exception as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return {"ok": True, "service": settings.app_name, "version": "2.0.0", "environment": settings.environment}


@app.get("/health/live", tags=["system"])
async def liveness():
    return {"ok": True, "service": settings.app_name}


app.include_router(router)
