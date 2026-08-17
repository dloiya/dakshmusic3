from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Any

from fastapi import APIRouter, Cookie, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from ..config import Settings, get_settings
from ..connectors.cloudflare.r2 import R2Client
from ..connectors.deezer import DeezerConnector
from ..connectors.github.actions import GitHubActionsConnector
from ..services.store import Store

router = APIRouter(prefix="/api/v1")


def store(settings: Settings = Depends(get_settings)) -> Store:
    return Store(settings)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


async def auth_session(session: str | None = Cookie(default=None), db: Store = Depends(store)):
    if not session: raise HTTPException(401, "Authentication required")
    rows=await db.db.query("SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?",[_hash(session),int(time.time())])
    if not rows: raise HTTPException(401,"Session expired")
    await db.db.execute("UPDATE sessions SET last_seen_at=? WHERE id_hash=?",[int(time.time()),_hash(session)])
    return session


@router.get("/status")
async def status(s:Store=Depends(store)): return await s.status()

@router.get("/system/health")
async def health(settings:Settings=Depends(get_settings),s:Store=Depends(store)):
    try:
        rows=await s.db.query("SELECT 1 AS ok")
        return {"ok":bool(rows and rows[0]["ok"]==1),"service":settings.app_name,"version":"2.0.0","database":True}
    except Exception as exc: return {"ok":False,"service":settings.app_name,"version":"2.0.0","database":False,"error":str(exc)}

@router.post("/auth/login")
async def login(payload:dict[str,Any],settings:Settings=Depends(get_settings),s:Store=Depends(store)):
    password=str(payload.get("password",""))
    if not settings.admin_password or not hmac.compare_digest(password,settings.admin_password): raise HTTPException(401,"Invalid credentials")
    token=secrets.token_urlsafe(32); now=int(time.time())
    await s.db.execute("INSERT OR REPLACE INTO sessions(id_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?)",[_hash(token),now,now+2592000,now])
    from fastapi.responses import JSONResponse
    out=JSONResponse({"ok":True}); out.set_cookie("session",token,max_age=2592000,httponly=True,samesite="lax",secure=settings.environment=="production"); return out

@router.post("/auth/logout")
async def logout(session:str|None=Cookie(default=None),s:Store=Depends(store)):
    if session: await s.db.execute("DELETE FROM sessions WHERE id_hash=?",[_hash(session)])
    from fastapi.responses import JSONResponse
    out=JSONResponse({"ok":True}); out.delete_cookie("session"); return out

@router.get("/auth/session")
async def session_info(session:str|None=Cookie(default=None),s:Store=Depends(store)):
    if not session:return {"ok":True,"authenticated":False}
    rows=await s.db.query("SELECT expires_at FROM sessions WHERE id_hash=?",[_hash(session)])
    return {"ok":True,"authenticated":bool(rows and rows[0]["expires_at"]>int(time.time()))}

@router.get("/library/tracks")
async def tracks(q:str|None=None,limit:int=100,offset:int=0,s:Store=Depends(store),_:str=Depends(auth_session)): return {"ok":True,"items":await s.tracks(q,limit,offset)}

@router.get("/library/tracks/{track_id}")
async def track(track_id:int,s:Store=Depends(store),_:str=Depends(auth_session)):
    item=await s.track(track_id)
    if not item: raise HTTPException(404,"Track not found")
    return {"ok":True,"item":item}

@router.post("/library/tracks")
async def create_track(payload:dict[str,Any],s:Store=Depends(store),_:str=Depends(auth_session)):
    if not payload.get("title") or not payload.get("artist"): raise HTTPException(422,"title and artist are required")
    return {"ok":True,"id":await s.upsert_track(payload)}

@router.patch("/library/tracks/{track_id}")
async def update_track(track_id:int,payload:dict[str,Any],s:Store=Depends(store),_:str=Depends(auth_session)):
    if not await s.track(track_id): raise HTTPException(404,"Track not found")
    fields=[k for k in ("title","artist","album_name","source","source_id","source_url","isrc","duration_ms","artwork_url","storage_key","storage_status","play_count","cache_requested") if k in payload]
    if fields: await s.db.execute(f"UPDATE tracks SET {','.join(f'{f}=?' for f in fields)},updated_at=CURRENT_TIMESTAMP WHERE id=?",[payload[f] for f in fields]+[track_id])
    return {"ok":True,"item":await s.track(track_id)}

@router.delete("/library/tracks/{track_id}")
async def delete_track(track_id:int,s:Store=Depends(store),_:str=Depends(auth_session)): await s.delete_track(track_id); return {"ok":True}

@router.get("/library/albums")
async def albums(q:str|None=None,limit:int=100,offset:int=0,s:Store=Depends(store),_:str=Depends(auth_session)): return {"ok":True,"items":await s.albums(q,limit,offset)}

@router.get("/playlist")
async def playlist(s:Store=Depends(store),_:str=Depends(auth_session)): return {"ok":True,"items":await s.playlist()}
@router.post("/playlist/tracks/{track_id}")
async def playlist_add(track_id:int,position:int|None=None,s:Store=Depends(store),_:str=Depends(auth_session)): return {"ok":True,"track_id":track_id,"position":await s.playlist_add(track_id,position)}
@router.delete("/playlist/{entry_id}")
async def playlist_remove(entry_id:int,s:Store=Depends(store),_:str=Depends(auth_session)): await s.playlist_remove(entry_id); return {"ok":True}
@router.delete("/playlist")
async def playlist_clear(s:Store=Depends(store),_:str=Depends(auth_session)): await s.playlist_clear(); return {"ok":True}

@router.get("/queue")
async def queue(key:str="main",s:Store=Depends(store),_:str=Depends(auth_session)): return {"ok":True,**(await s.queue(key))}
@router.post("/queue/{track_id}")
async def queue_add(track_id:int,key:str="main",position:int|None=None,s:Store=Depends(store),_:str=Depends(auth_session)): return {"ok":True,"queue_key":key,"track_id":track_id,"position":await s.queue_add(key,track_id,position)}
@router.delete("/queue/{entry_id}")
async def queue_remove(entry_id:int,key:str="main",s:Store=Depends(store),_:str=Depends(auth_session)): await s.queue_remove(key,entry_id); return {"ok":True}
@router.delete("/queue")
async def queue_clear(key:str="main",s:Store=Depends(store),_:str=Depends(auth_session)): await s.queue_clear(key); return {"ok":True}
@router.post("/queue/shuffle")
async def queue_shuffle(key:str="main",s:Store=Depends(store),_:str=Depends(auth_session)): await s.queue_shuffle(key); return {"ok":True,**(await s.queue(key))}

@router.get("/search")
async def search(q:str=Query(min_length=1),limit:int=25,source:str="deezer",_:str=Depends(auth_session)):
    if source!="deezer": raise HTTPException(400,"Unsupported search source")
    return {"ok":True,"items":await DeezerConnector().search(q,limit)}

@router.post("/acquire/{track_id}")
async def acquire(track_id:int,s:Store=Depends(store),settings:Settings=Depends(get_settings),_:str=Depends(auth_session)):
    track=await s.track(track_id)
    if not track: raise HTTPException(404,"Track not found")
    job_id,created=await s.create_job(track_id)
    if created:
        try:
            await GitHubActionsConnector(settings).dispatch(settings.acquire_workflow,{"track_id":str(track_id),"job_id":job_id,"source":str(track.get("source") or ""),"source_id":str(track.get("source_id") or ""),"source_url":str(track.get("source_url") or "")})
            await s.update_job(job_id,"dispatched")
        except Exception as exc:
            await s.update_job(job_id,"failed",str(exc)); raise HTTPException(502,f"Acquire worker dispatch failed: {exc}")
    return {"ok":True,"job_id":job_id,"created":created}

@router.get("/acquire")
async def acquire_jobs(s:Store=Depends(store),_:str=Depends(auth_session)): return await s.status()
@router.get("/acquire/{job_id}")
async def acquire_job(job_id:str,s:Store=Depends(store),_:str=Depends(auth_session)):
    rows=await s.db.query("SELECT j.*,t.title,t.artist,t.album_name FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.id=?",[job_id])
    if not rows: raise HTTPException(404,"Acquisition job not found")
    return {"ok":True,"item":rows[0]}
@router.post("/acquire/{job_id}/cancel")
async def cancel_job(job_id:str,s:Store=Depends(store),_:str=Depends(auth_session)): await s.update_job(job_id,"cancelled"); return {"ok":True}
@router.post("/acquire/{job_id}/retry")
async def retry_job(job_id:str,s:Store=Depends(store),settings:Settings=Depends(get_settings),_:str=Depends(auth_session)):
    rows=await s.db.query("SELECT track_id FROM acquisition_jobs WHERE id=?",[job_id])
    if not rows: raise HTTPException(404,"Acquisition job not found")
    await s.update_job(job_id,"cancelled"); new_id,_=await s.create_job(rows[0]["track_id"]); track=await s.track(rows[0]["track_id"])
    await GitHubActionsConnector(settings).dispatch(settings.acquire_workflow,{"track_id":str(track["id"]),"job_id":new_id,"source":str(track.get("source") or ""),"source_id":str(track.get("source_id") or ""),"source_url":str(track.get("source_url") or "")}); await s.update_job(new_id,"dispatched"); return {"ok":True,"job_id":new_id}

@router.post("/seed")
async def seed(file:UploadFile=File(...),s:Store=Depends(store),_:str=Depends(auth_session)): return await s.import_csv(file.filename or "library.csv",await file.read())
@router.get("/seed/{job_id}")
async def seed_status(job_id:str,s:Store=Depends(store),_:str=Depends(auth_session)):
    item=await s.import_job(job_id)
    if not item: raise HTTPException(404,"Import job not found")
    return {"ok":True,"item":item}

@router.get("/cache/status")
async def cache_status(s:Store=Depends(store),_:str=Depends(auth_session)): return await s.cache_status()
@router.post("/cache/populate")
async def cache_populate(limit:int=100,s:Store=Depends(store),_:str=Depends(auth_session)): return await s.populate_top_cache(limit)

@router.post("/crud/clear-all")
async def clear_all(include_audio:bool=True,s:Store=Depends(store),_:str=Depends(auth_session)): return await s.clear_all(include_audio)

@router.post("/worker/callback")
async def worker_callback(payload:dict[str,Any],authorization:str|None=Header(default=None),settings:Settings=Depends(get_settings),s:Store=Depends(store)):
    if not settings.worker_callback_secret or not authorization or not hmac.compare_digest(authorization,f"Bearer {settings.worker_callback_secret}"): raise HTTPException(401,"Invalid worker credentials")
    job_id=payload.get("job_id"); status=payload.get("status")
    if not job_id or status not in {"running","complete","failed","cancelled"}: raise HTTPException(400,"Invalid worker callback")
    await s.update_job(job_id,status,payload.get("error"))
    if status=="complete" and payload.get("storage_key"):
        await s.db.execute("UPDATE tracks SET storage_key=?,storage_status='available',updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT track_id FROM acquisition_jobs WHERE id=?)",[payload["storage_key"],job_id])
    return {"ok":True}

@router.get("/playback/{track_id}")
async def playback(track_id:int,s:Store=Depends(store),_:str=Depends(auth_session)):
    track=await s.track(track_id)
    if not track or not track.get("storage_key"): raise HTTPException(404,"Audio not available")
    obj=await R2Client(s.settings).get(track["storage_key"])
    if obj is None: raise HTTPException(404,"Audio object not found")
    await s.db.execute("UPDATE tracks SET play_count=play_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",[track_id])
    body=getattr(obj,"body",None)
    if body is None and isinstance(obj,dict): body=obj.get("Body")
    return StreamingResponse(body,media_type="audio/flac",headers={"Accept-Ranges":"bytes"})
