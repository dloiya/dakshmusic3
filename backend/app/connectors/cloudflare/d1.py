from typing import Any

import httpx

from ...config import Settings


class D1Client:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.base_url = (
            f"https://api.cloudflare.com/client/v4/accounts/"
            f"{settings.cloudflare_account_id}/d1/database/{settings.cloudflare_d1_database_id}/query"
        )

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        if not self.settings.cloudflare_account_id or not self.settings.cloudflare_d1_database_id:
            raise RuntimeError("Cloudflare D1 is not configured")
        headers = {
            "Authorization": f"Bearer {self.settings.cloudflare_api_token}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(self.base_url, headers=headers, json={"sql": sql, "params": params or []})
            response.raise_for_status()
            payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(str(payload.get("errors") or "D1 query failed"))
        result = payload.get("result") or []
        if not result:
            return []
        return result[0].get("results") or []
