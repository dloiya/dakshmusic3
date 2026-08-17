from __future__ import annotations

from ..store import Store


class PlaylistService:
    def __init__(self, store: Store):
        self.store = store

    async def get(self):
        return await self.store.playlist()

    async def add(self, track_id: int, position=None):
        if not await self.store.track(track_id):
            raise ValueError("Track not found")
        return await self.store.playlist_add(track_id, position)

    async def remove(self, entry_id: int):
        await self.store.playlist_remove(entry_id)

    async def clear(self):
        await self.store.playlist_clear()
