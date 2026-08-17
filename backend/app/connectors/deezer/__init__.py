from ..base import MusicConnector
import httpx


class DeezerConnector(MusicConnector):
    name = "deezer"
    base_url = "https://api.deezer.com"

    async def search(self, query: str, limit: int = 25):
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"{self.base_url}/search", params={"q": query, "limit": max(1, min(limit, 50))})
            response.raise_for_status()
            data = response.json()
        return [{"source":"deezer","source_id":str(x.get("id")),"title":x.get("title"),"artist":(x.get("artist") or {}).get("name"),"album_name":(x.get("album") or {}).get("title"),"artwork_url":(x.get("album") or {}).get("cover_medium"),"duration_ms":int(x.get("duration",0))*1000,"source_url":x.get("link")} for x in data.get("data", [])]

    async def resolve(self, source_id):
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"{self.base_url}/track/{source_id}"); response.raise_for_status(); x=response.json()
        return {"source":"deezer","source_id":str(x.get("id")),"title":x.get("title"),"artist":(x.get("artist") or {}).get("name"),"album_name":(x.get("album") or {}).get("title"),"artwork_url":(x.get("album") or {}).get("cover_medium"),"duration_ms":int(x.get("duration",0))*1000,"source_url":x.get("link")}

    async def metadata(self, source_id):
        return await self.resolve(source_id)

    async def health(self):
        return {"name":self.name,"configured":True}
