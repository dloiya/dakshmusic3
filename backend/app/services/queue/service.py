from __future__ import annotations

from ...repositories import LibraryRepository, QueueRepository


class QueueService:
    def __init__(self, queue: QueueRepository, library: LibraryRepository):
        self.queue = queue
        self.library = library

    async def get(self, key="main"):
        return await self.queue.get(key)

    async def add(self, key, track_id, position=None):
        if not await self.library.track(track_id):
            raise ValueError("Track not found")
        return await self.queue.add(key, track_id, position)

    async def remove(self, key, entry_id):
        await self.queue.remove(key, entry_id)

    async def clear(self, key):
        await self.queue.clear(key)

    async def shuffle(self, key):
        await self.queue.shuffle(key)
        return await self.queue.get(key)

    async def update_state(self, key, data):
        await self.queue.state(key, data)
        return await self.queue.get(key)
