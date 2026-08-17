from typing import Any
import httpx
from ...config import Settings
from .bindings import get_worker_env


class D1Client:
    """D1 adapter with native Worker binding support and local REST fallback."""

    def __init__(self, settings: Settings):
        self.settings = settings

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        env = get_worker_env()
        db = getattr(env, "DB", None) if env is not None else None
        if db is not None:
            statement = db.prepare(sql)
            if params:
                statement = statement.bind(*params)
            result = await statement.run()
            return list(result.results or [])

        if not self.settings.cloudflare_account_id or not self.settings.cloudflare_d1_database_id or not self.settings.cloudflare_api_token:
            raise RuntimeError("Cloudflare D1 is not configured")

        base_url = f"https://api.cloudflare.com/client/v4/accounts/{self.settings.cloudflare_account_id}/d1/database/{self.settings.cloudflare_d1_database_id}/query"
        headers = {"Authorization": f"Bearer {self.settings.cloudflare_api_token}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(base_url, headers=headers, json={"sql": sql, "params": params or []})
            response.raise_for_status()
            payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(str(payload.get("errors") or "D1 query failed"))
        result = payload.get("result") or []
        return result[0].get("results") or [] if result else []
