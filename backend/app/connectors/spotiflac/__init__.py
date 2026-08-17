from ..base import MusicConnector


class SpotiFlacConnector(MusicConnector):
    name = "spotiflac"

    async def search(self, query):
        raise NotImplementedError

    async def resolve(self, source_id):
        raise NotImplementedError

    async def metadata(self, source_id):
        raise NotImplementedError

    async def health(self):
        return {"name": self.name, "configured": False}
