import os
import subprocess
import sys
import tempfile
from pathlib import Path

import requests


JOB_ID=os.environ["JOB_ID"]
TRACK_ID=os.environ["TRACK_ID"]
SOURCE_URL=os.environ.get("SOURCE_URL","")
SOURCE=os.environ.get("SOURCE","")
CALLBACK=os.environ["CALLBACK_URL"]
SECRET=os.environ["CALLBACK_SECRET"]
R2_ENDPOINT=os.environ.get("R2_ENDPOINT","")
R2_BUCKET=os.environ.get("R2_BUCKET","dakshmusic3-audio")
R2_ACCESS_KEY=os.environ.get("R2_ACCESS_KEY","")
R2_SECRET=os.environ.get("R2_SECRET_KEY","")


def callback(status, **extra):
    payload={"job_id":JOB_ID,"status":status,**extra}
    r=requests.post(CALLBACK,json=payload,headers={"Authorization":f"Bearer {SECRET}"},timeout=30)
    r.raise_for_status()


def main():
    callback("running")
    with tempfile.TemporaryDirectory() as tmp:
        out=Path(tmp)/"audio.%(ext)s"
        cmd=["yt-dlp","--no-playlist","--extract-audio","--audio-format","flac","--audio-quality","0","-o",str(out),SOURCE_URL]
        subprocess.run(cmd,check=True)
        files=list(Path(tmp).glob("audio.*"))
        if not files: raise RuntimeError("acquisition produced no audio file")
        flac=files[0]
        key=f"audio/tracks/{TRACK_ID}.flac"
        if not (R2_ENDPOINT and R2_ACCESS_KEY and R2_SECRET): raise RuntimeError("R2 worker credentials are not configured")
        import boto3
        client=boto3.client("s3",endpoint_url=R2_ENDPOINT,aws_access_key_id=R2_ACCESS_KEY,aws_secret_access_key=R2_SECRET,region_name="auto")
        client.upload_file(str(flac),R2_BUCKET,key,ExtraArgs={"ContentType":"audio/flac"})
        callback("complete",storage_key=key)


if __name__=="__main__":
    try: main()
    except Exception as exc:
        try: callback("failed",error=str(exc))
        finally: raise
