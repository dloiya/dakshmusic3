from __future__ import annotations

from ...config import Settings
from ...connectors.deezer import DeezerConnector
from ...connectors.spotiflac import SpotiFlacConnector
from ...connectors.ytflac import YtFlacConnector


class SearchService:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def search(self, query: str, limit: int = 25, source: str = "deezer"):
        limit = max(1, min(int(limit), 100))
        if source == "deezer":
            items = await DeezerConnector().search(query, limit)
        elif source == "spotiflac":
            items = await SpotiFlacConnector(self.settings).search(query, limit)
        elif source == "ytflac":
            items = await YtFlacConnector().search(query, limit)
        else:
            raise ValueError("Unsupported search source")
        return {"source": source, "items": items}
