import asgi
from workers import WorkerEntrypoint

from app.main import app
from app.connectors.cloudflare.bindings import set_worker_env, reset_worker_env


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        token = set_worker_env(self.env)
        try:
            return await asgi.fetch(app, request, self.env)
        finally:
            reset_worker_env(token)
