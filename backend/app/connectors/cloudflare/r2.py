from typing import Any
import boto3
from botocore.config import Config
from ...config import Settings
from .bindings import get_worker_env


class R2Client:
    """R2 adapter using the native Worker bucket binding in production."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = None
        if settings.r2_endpoint and settings.r2_access_key_id and settings.r2_secret_access_key:
            self.client = boto3.client("s3", endpoint_url=settings.r2_endpoint, aws_access_key_id=settings.r2_access_key_id, aws_secret_access_key=settings.r2_secret_access_key, region_name="auto", config=Config(signature_version="s3v4"))

    def _binding(self) -> Any | None:
        env = get_worker_env()
        return getattr(env, "AUDIO", None) if env is not None else None

    async def head(self, key: str) -> dict | None:
        bucket = self._binding()
        if bucket is not None:
            obj = await bucket.head(key)
            return dict(obj) if obj is not None else None
        if not self.client:
            raise RuntimeError("Cloudflare R2 is not configured")
        try:
            return self.client.head_object(Bucket=self.settings.r2_bucket, Key=key)
        except self.client.exceptions.ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise

    async def delete_all(self) -> int:
        bucket = self._binding()
        if bucket is not None:
            deleted = 0
            cursor = None
            while True:
                result = await bucket.list(**({"cursor": cursor} if cursor else {}))
                for obj in result.objects or []:
                    await bucket.delete(obj.key)
                    deleted += 1
                if not result.truncated:
                    break
                cursor = result.cursor
            return deleted
        if not self.client:
            raise RuntimeError("Cloudflare R2 is not configured")
        deleted = 0
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.settings.r2_bucket):
            objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            for start in range(0, len(objects), 1000):
                chunk = objects[start:start + 1000]
                if chunk:
                    self.client.delete_objects(Bucket=self.settings.r2_bucket, Delete={"Objects": chunk, "Quiet": True})
                    deleted += len(chunk)
        return deleted
