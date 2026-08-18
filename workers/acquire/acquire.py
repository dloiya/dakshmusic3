from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests

JOB_ID = os.environ["JOB_ID"]
TRACK_ID = os.environ["TRACK_ID"]
TITLE = os.environ.get("TITLE", "")
ARTIST = os.environ.get("ARTIST", "")
ALBUM = os.environ.get("ALBUM", "")
SOURCE = os.environ.get("SOURCE", "")
SOURCE_URL = os.environ.get("SOURCE_URL", "")
CALLBACK = os.environ["CALLBACK_URL"].strip()
SECRET = os.environ["CALLBACK_SECRET"]
R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_BUCKET = os.environ.get("R2_BUCKET", "dakshmusic3-audio")
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY"]
R2_SECRET = os.environ["R2_SECRET_KEY"]

# The Worker callback endpoint is /api/v1/acquire/callback.
# Accept the previous /api/v1/worker/callback value as well so an existing
# CALLBACK_URL secret does not need to be recreated.
if CALLBACK.rstrip("/").endswith("/api/v1/worker/callback"):
    parts = urlsplit(CALLBACK)
    CALLBACK = urlunsplit((parts.scheme, parts.netloc, "/api/v1/acquire/callback", parts.query, parts.fragment))


def callback(status: str, **extra):
    payload = {"job_id": JOB_ID, "status": status, **extra}
    response = requests.post(
        CALLBACK,
        json=payload,
        headers={"Authorization": f"Bearer {SECRET}"},
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Worker callback failed: HTTP {response.status_code}: {response.text[:1000]}")


def _run_spotiflac(output: Path):
    from resolve_apple import resolve
    import asyncio
    import glob
    from SpotiFLAC.client import AsyncSpotiFLAC

    resolved = SOURCE_URL if "music.apple.com" in SOURCE_URL else resolve(TITLE, ARTIST, ALBUM, SOURCE_URL)
    outdir = output.parent / "_spotiflac"
    outdir.mkdir(parents=True, exist_ok=True)

    async def download():
        async with AsyncSpotiFLAC(output_dir=str(outdir), services=["deezer", "tidal", "qobuz", "amazon"], quality="LOSSLESS", track_max_retries=2, timeout_s=180, embed_lyrics=False, use_extensions_fallback=False) as client:
            await client.download_track(resolved)

    asyncio.run(download())
    files = [Path(p) for p in glob.glob(str(outdir / "**" / "*.flac"), recursive=True)]
    if not files:
        raise RuntimeError("SpotiFLAC produced no FLAC")
    shutil.copy2(max(files, key=lambda p: p.stat().st_mtime), output)


def _run_ytdlp(output: Path):
    target = SOURCE_URL or f"ytsearch1:{TITLE} {ARTIST}"
    command = ["yt-dlp", target, "--no-playlist", "-x", "-f", "bestaudio/best", "--audio-format", "flac", "--audio-quality", "0", "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg", "--js-runtimes", "deno", "--remote-components", "ejs:github", "-o", str(output.with_suffix(".%(ext)s")), "--no-warnings"]
    cookies_b64 = os.environ.get("YTDLP_COOKIES_B64")
    cookies_path = None
    if cookies_b64:
        import base64
        fd, name = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        cookies_path = Path(name)
        cookies_path.write_bytes(base64.b64decode(cookies_b64))
        command += ["--cookies", str(cookies_path)]
    try:
        completed = subprocess.run(command, text=True, capture_output=True, timeout=12 * 60)
        if completed.returncode:
            raise RuntimeError(completed.stderr[-4000:] or completed.stdout[-4000:] or "yt-dlp failed")
    finally:
        if cookies_path:
            cookies_path.unlink(missing_ok=True)
    if not output.exists():
        candidates = list(output.parent.glob(output.stem + ".flac"))
        if candidates:
            shutil.move(candidates[0], output)
    if not output.exists():
        raise RuntimeError("yt-dlp produced no FLAC")


def duration_ms(path: Path) -> int | None:
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)], text=True, capture_output=True, check=True, timeout=30)
        return int(float(result.stdout.strip()) * 1000)
    except Exception:
        return None


def main():
    callback("running")
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "audio.flac"
        try:
            if SOURCE in {"deezer", "spotiflac"}:
                _run_spotiflac(output)
            else:
                _run_ytdlp(output)
            if output.stat().st_size < 1024:
                raise RuntimeError("acquired FLAC is unexpectedly small")
            import boto3
            client = boto3.client("s3", endpoint_url=R2_ENDPOINT, aws_access_key_id=R2_ACCESS_KEY, aws_secret_access_key=R2_SECRET, region_name="auto")
            key = f"audio/tracks/{TRACK_ID}.flac"
            client.upload_file(str(output), R2_BUCKET, key, ExtraArgs={"ContentType": "audio/flac"})
            callback("complete", storage_key=key, duration_ms=duration_ms(output), size_bytes=output.stat().st_size)
        except Exception as exc:
            callback("failed", error=str(exc))
            raise


if __name__ == "__main__":
    main()
