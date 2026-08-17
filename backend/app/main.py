from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import get_settings
from .api.router import router

settings=get_settings()
app=FastAPI(title=settings.app_name,version="2.0.0")
app.add_middleware(CORSMiddleware,allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],allow_credentials=True,allow_methods=["*"],allow_headers=["*"])

@app.get("/health")
async def health():
    return {"ok":True,"service":settings.app_name,"version":"2.0.0"}

app.include_router(router)
