import boto3
from botocore.config import Config
from ...config import Settings


class R2Client:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = boto3.client("s3", endpoint_url=settings.r2_endpoint, aws_access_key_id=settings.r2_access_key_id, aws_secret_access_key=settings.r2_secret_access_key, region_name="auto", config=Config(signature_version="s3v4")) if settings.r2_endpoint else None

    def head(self, key: str) -> dict | None:
        if not self.client:
            raise RuntimeError("Cloudflare R2 is not configured")
        try:
            return self.client.head_object(Bucket=self.settings.r2_bucket, Key=key)
        except self.client.exceptions.ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
