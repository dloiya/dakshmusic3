from ..base import MusicConnector


class YtFlacConnector(MusicConnector):
    name = "ytflac"

    async def search(self, query):
        raise NotImplementedError

    async def resolve(self, source_id):
        raise NotImplementedError

    async def metadata(self, source_id):
        raise NotImplementedError

    async def health(self):
        return {"name": self.name, "configured": False}
