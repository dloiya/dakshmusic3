import boto3
from botocore.config import Config
from ...config import Settings


class R2Client:
    def __init__(self, settings: Settings):
        self.settings = settings
        if not settings.r2_endpoint or not settings.r2_access_key_id or not settings.r2_secret_access_key:
            self.client = None
        else:
            self.client = boto3.client("s3", endpoint_url=settings.r2_endpoint, aws_access_key_id=settings.r2_access_key_id, aws_secret_access_key=settings.r2_secret_access_key, region_name="auto", config=Config(signature_version="s3v4"))

    def _require(self):
        if not self.client:
            raise RuntimeError("Cloudflare R2 is not configured")
        return self.client

    def head(self, key: str) -> dict | None:
        client = self._require()
        try:
            return client.head_object(Bucket=self.settings.r2_bucket, Key=key)
        except client.exceptions.ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise

    def delete_all(self) -> int:
        client = self._require()
        deleted = 0
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.settings.r2_bucket):
            objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            for start in range(0, len(objects), 1000):
                chunk = objects[start:start + 1000]
                if chunk:
                    client.delete_objects(Bucket=self.settings.r2_bucket, Delete={"Objects": chunk, "Quiet": True})
                    deleted += len(chunk)
        return deleted
