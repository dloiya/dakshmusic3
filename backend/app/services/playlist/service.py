from __future__ import annotations

from ...repositories import LibraryRepository, PlaylistRepository


class PlaylistService:
    def __init__(self, playlist: PlaylistRepository, library: LibraryRepository):
        self.playlist = playlist
        self.library = library

    async def get(self):
        return await self.playlist.list()

    async def add(self, track_id: int, position=None):
        if not await self.library.track(track_id):
            raise ValueError("Track not found")
        return await self.playlist.add(track_id, position)

    async def remove(self, entry_id: int):
        await self.playlist.remove(entry_id)

    async def clear(self):
        await self.playlist.clear()
