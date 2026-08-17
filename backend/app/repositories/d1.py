from __future__ import annotations

from typing import Any
from ..connectors.cloudflare.d1 import D1Client


class D1Repository:
    """Small, dependency-free repository wrapper around the D1 connector."""

    def __init__(self, db: D1Client):
        self.db = db

    async def query(self, sql: str, params: list[Any] | None = None):
        return await self.db.query(sql, params)

    async def one(self, sql: str, params: list[Any] | None = None):
        rows = await self.db.query(sql, params)
        return rows[0] if rows else None

    async def execute(self, sql: str, params: list[Any] | None = None):
        await self.db.query(sql, params)

    async def batch(self, statements: list[tuple[str, list[Any] | None]]):
        await self.db.batch(statements)
