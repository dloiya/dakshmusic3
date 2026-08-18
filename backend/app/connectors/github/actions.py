from typing import Any
import httpx
from ...config import Settings


class GitHubActionsConnector:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def dispatch(self, workflow: str, inputs: dict[str, Any]) -> None:
        if not self.settings.github_token:
            raise RuntimeError("GitHub Actions connector is not configured: GITHUB_TOKEN is missing")
        if not self.settings.github_repo:
            raise RuntimeError("GitHub Actions connector is not configured: GITHUB_REPO is missing")
        if not workflow:
            raise RuntimeError("GitHub Actions workflow filename is missing")

        url = f"https://api.github.com/repos/{self.settings.github_repo}/actions/workflows/{workflow}/dispatches"
        headers = {
            "Authorization": f"Bearer {self.settings.github_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "dakshmusic3",
        }
        payload = {"ref": self.settings.github_ref, "inputs": inputs}

        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, headers=headers, json=payload)
            if response.status_code not in (201, 204):
                try:
                    detail = response.json()
                except Exception:
                    detail = response.text[:500]
                raise RuntimeError(
                    f"GitHub workflow dispatch failed: HTTP {response.status_code}: {detail}"
                )
