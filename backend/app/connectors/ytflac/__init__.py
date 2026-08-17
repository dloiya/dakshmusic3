from ..base import MusicConnector


class YtFlacConnector(MusicConnector):
    name="ytflac"
    async def search(self,query,limit=25):
        # Search is intentionally delegated to the acquisition runner where yt-dlp is available.
        return []
    async def resolve(self,source_id): return {"source":self.name,"source_id":str(source_id),"source_url":str(source_id)}
    async def metadata(self,source_id): return await self.resolve(source_id)
    async def health(self): return {"name":self.name,"configured":True,"executor":"github-actions"}
