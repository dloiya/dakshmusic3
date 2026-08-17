import httpx
from ..base import MusicConnector
from ...config import Settings


class SpotiFlacConnector(MusicConnector):
    name="spotiflac"
    def __init__(self,settings:Settings): self.settings=settings
    async def _get(self,path,params=None):
        if not self.settings.spotiflac_api_url: raise RuntimeError("SpotiFLAC API is not configured")
        async with httpx.AsyncClient(timeout=30) as client:
            r=await client.get(self.settings.spotiflac_api_url.rstrip('/')+'/'+path.lstrip('/'),params=params); r.raise_for_status(); return r.json()
    async def search(self,query,limit=25): return (await self._get("search",{"q":query,"limit":limit})).get("items",[])
    async def resolve(self,source_id): return await self._get(f"resolve/{source_id}")
    async def metadata(self,source_id): return await self._get(f"metadata/{source_id}")
    async def health(self): return {"name":self.name,"configured":bool(self.settings.spotiflac_api_url)}
