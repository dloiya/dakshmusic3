from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from ..repositories import D1Repository, LibraryRepository, PlaylistRepository
from ..services.playlist.service import PlaylistService
from .deps import get_db, require_session

router=APIRouter(prefix="/playlist",tags=["playlist"])

def get_playlist(db:D1Repository=Depends(get_db))->PlaylistService:
    return PlaylistService(PlaylistRepository(db),LibraryRepository(db))

@router.get("")
async def get_playlist(service:PlaylistService=Depends(get_playlist),_:str=Depends(require_session)):
    return {"ok":True,"items":await service.get()}

@router.post("/tracks/{track_id}")
async def add_track(track_id:int,position:int|None=None,service:PlaylistService=Depends(get_playlist),_:str=Depends(require_session)):
    try: pos=await service.add(track_id,position)
    except ValueError as exc: raise HTTPException(404,str(exc))
    return {"ok":True,"track_id":track_id,"position":pos}

@router.delete("/{entry_id}")
async def remove_track(entry_id:int,service:PlaylistService=Depends(get_playlist),_:str=Depends(require_session)):
    await service.remove(entry_id); return {"ok":True}

@router.delete("")
async def clear_playlist(service:PlaylistService=Depends(get_playlist),_:str=Depends(require_session)):
    await service.clear(); return {"ok":True}
