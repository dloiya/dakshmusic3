from abc import ABC, abstractmethod
from typing import Any


class MusicConnector(ABC):
    name: str

    @abstractmethod
    async def search(self, query: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def resolve(self, source_id: str) -> dict[str, Any]: ...

    @abstractmethod
    async def metadata(self, source_id: str) -> dict[str, Any]: ...

    @abstractmethod
    async def health(self) -> dict[str, Any]: ...
