from __future__ import annotations

from ..store import Store


class QueueService:
    def __init__(self, store: Store):
        self.store = store

    async def get(self, key="main"):
        return await self.store.queue(key)

    async def add(self, key, track_id, position=None):
        if not await self.store.track(track_id):
            raise ValueError("Track not found")
        return await self.store.queue_add(key, track_id, position)

    async def remove(self, key, entry_id):
        await self.store.queue_remove(key, entry_id)

    async def clear(self, key):
        await self.store.queue_clear(key)

    async def shuffle(self, key):
        await self.store.queue_shuffle(key)
        return await self.store.queue(key)

    async def update_state(self, key, data):
        await self.store.queue_state(key, data)
        return await self.store.queue(key)
