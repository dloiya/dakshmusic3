from __future__ import annotations

from ...repositories import LibraryRepository


class LibraryService:
    def __init__(self, repository: LibraryRepository):
        self.repository = repository

    async def list_tracks(self, q=None, limit=100, offset=0):
        return await self.repository.tracks(q, limit, offset)

    async def get_track(self, track_id: int):
        return await self.repository.track(track_id)

    async def create_track(self, data: dict):
        if not data.get("title") or not data.get("artist"):
            raise ValueError("title and artist are required")
        return await self.repository.upsert_track(data)

    async def update_track(self, track_id: int, data: dict):
        if not await self.repository.track(track_id):
            raise ValueError("Track not found")
        await self.repository.update_track(track_id, data)
        return await self.repository.track(track_id)

    async def delete_track(self, track_id: int):
        if not await self.repository.track(track_id):
            raise ValueError("Track not found")
        await self.repository.delete_track(track_id)
