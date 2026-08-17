import asgi
from workers import WorkerEntrypoint

from app.main import app
from app.config import get_settings
from app.connectors.cloudflare.bindings import set_worker_env, reset_worker_env
from app.connectors.cloudflare.d1 import D1Client
from app.repositories import D1Repository
from app.services.system.data import DataService


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        token = set_worker_env(self.env)
        try:
            return await asgi.fetch(app, request, self.env)
        finally:
            reset_worker_env(token)

    async def queue(self, batch):
        token = set_worker_env(self.env)
        try:
            settings = get_settings()
            db = D1Repository(D1Client(settings))
            service = DataService(settings, db)
            for message in batch.messages:
                try:
                    track = message.body
                    enriched = await service._enrich_metadata([track])
                    if enriched:
                        message.ack()
                    else:
                        # Keep unresolved tracks retryable without blocking the whole import.
                        message.ack()
                except Exception:
                    message.retry()
        finally:
            reset_worker_env(token)
