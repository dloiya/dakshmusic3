from typing import Any
from ...config import Settings
from .bindings import get_worker_env


class R2Client:
    """R2 adapter using native Worker bindings in production and S3 only for local fallback."""
    def __init__(self, settings: Settings):
        self.settings=settings; self.client=None
        if settings.r2_endpoint and settings.r2_access_key_id and settings.r2_secret_access_key:
            import boto3
            from botocore.config import Config
            self.client=boto3.client("s3",endpoint_url=settings.r2_endpoint,aws_access_key_id=settings.r2_access_key_id,aws_secret_access_key=settings.r2_secret_access_key,region_name="auto",config=Config(signature_version="s3v4"))

    def _binding(self)->Any|None:
        env=get_worker_env(); return getattr(env,"AUDIO",None) if env is not None else None

    async def get(self,key:str):
        bucket=self._binding()
        if bucket is not None: return await bucket.get(key)
        if not self.client: raise RuntimeError("Cloudflare R2 is not configured")
        try: return self.client.get_object(Bucket=self.settings.r2_bucket,Key=key)
        except self.client.exceptions.ClientError as exc:
            if exc.response.get("Error",{}).get("Code") in {"404","NoSuchKey","NotFound"}: return None
            raise

    async def head(self,key:str):
        bucket=self._binding()
        if bucket is not None: return await bucket.head(key)
        if not self.client: raise RuntimeError("Cloudflare R2 is not configured")
        try: return self.client.head_object(Bucket=self.settings.r2_bucket,Key=key)
        except self.client.exceptions.ClientError as exc:
            if exc.response.get("Error",{}).get("Code") in {"404","NoSuchKey","NotFound"}: return None
            raise

    async def put(self,key:str,data,content_type:str|None=None):
        bucket=self._binding()
        if bucket is not None:
            if content_type: return await bucket.put(key,data,httpMetadata={"contentType":content_type})
            return await bucket.put(key,data)
        if not self.client: raise RuntimeError("Cloudflare R2 is not configured")
        extra={"ContentType":content_type} if content_type else {}; return self.client.put_object(Bucket=self.settings.r2_bucket,Key=key,Body=data,**extra)

    async def delete_all(self)->int:
        bucket=self._binding()
        if bucket is not None:
            deleted=0; cursor=None
            while True:
                result=await bucket.list(**({"cursor":cursor} if cursor else {}))
                for obj in result.objects or []: await bucket.delete(obj.key); deleted+=1
                if not result.truncated: break
                cursor=result.cursor
            return deleted
        if not self.client: raise RuntimeError("Cloudflare R2 is not configured")
        deleted=0
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.settings.r2_bucket):
            objects=[{"Key":o["Key"]} for o in page.get("Contents",[])]
            for start in range(0,len(objects),1000):
                chunk=objects[start:start+1000]
                if chunk: self.client.delete_objects(Bucket=self.settings.r2_bucket,Delete={"Objects":chunk,"Quiet":True}); deleted+=len(chunk)
        return deleted
