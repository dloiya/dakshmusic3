from typing import Any
import httpx
from ...config import Settings


class GitHubActionsConnector:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def dispatch(self, workflow: str, inputs: dict[str, Any]) -> None:
        if not self.settings.github_token or not self.settings.github_repo:
            raise RuntimeError("GitHub Actions connector is not configured")
        url = f"https://api.github.com/repos/{self.settings.github_repo}/actions/workflows/{workflow}/dispatches"
        headers = {"Authorization": f"Bearer {self.settings.github_token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(url, headers=headers, json={"ref": self.settings.github_ref, "inputs": inputs})
            response.raise_for_status()
