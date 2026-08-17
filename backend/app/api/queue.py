from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from ..repositories import D1Repository, LibraryRepository, QueueRepository
from ..services.queue.service import QueueService
from .deps import get_db, require_session

router=APIRouter(prefix="/queue",tags=["queue"])

def get_queue(db:D1Repository=Depends(get_db))->QueueService:
    return QueueService(QueueRepository(db),LibraryRepository(db))

@router.get("")
async def get_queue(key:str="main",service:QueueService=Depends(get_queue),_:str=Depends(require_session)):
    return {"ok":True,**await service.get(key)}

@router.post("/shuffle")
async def shuffle_queue(key:str="main",service:QueueService=Depends(get_queue),_:str=Depends(require_session)):
    return {"ok":True,**await service.shuffle(key)}

@router.patch("/state")
async def update_queue_state(payload:dict[str,Any],key:str="main",service:QueueService=Depends(get_queue),_:str=Depends(require_session)):
    return {"ok":True,**await service.update_state(key,payload)}

@router.post("/{track_id}")
async def add_queue(track_id:int,key:str="main",position:int|None=None,service:QueueService=Depends(get_queue),_:str=Depends(require_session)):
    try: pos=await service.add(key,track_id,position)
    except ValueError as exc: raise HTTPException(404,str(exc))
    return {"ok":True,"queue_key":key,"track_id":track_id,"position":pos}

@router.delete("/{entry_id}")
async def remove_queue(entry_id:int,key:str="main",service:QueueService=Depends(get_queue),_:str=Depends(require_session)):
    await service.remove(key,entry_id); return {"ok":True}

@router.delete("")
async def clear_queue(key:str="main",service:QueueService=Depends(get_queue),_:str=Depends(require_session)):
    await service.clear(key); return {"ok":True}
