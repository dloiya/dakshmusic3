from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

JOB_ID = os.environ["JOB_ID"]
TRACK_ID = os.environ["TRACK_ID"]
TITLE = os.environ.get("TITLE", "")
ARTIST = os.environ.get("ARTIST", "")
ALBUM = os.environ.get("ALBUM", "")
SOURCE = os.environ.get("SOURCE", "")
SOURCE_URL = os.environ.get("SOURCE_URL", "")
R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_BUCKET = os.environ.get("R2_BUCKET", "dakshmusic3-audio")
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY"]
R2_SECRET = os.environ["R2_SECRET_KEY"]
RESULT_FILE = Path(os.environ.get("RESULT_FILE", "/tmp/acquisition-result.json"))


def write_result(status: str, **extra):
    RESULT_FILE.write_text(json.dumps({"job_id": JOB_ID, "track_id": TRACK_ID, "status": status, **extra}), encoding="utf-8")


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
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "audio.flac"
        try:
            # Apple Music URLs are not supported by yt-dlp. Route them through
            # the lossless resolver instead.
            if SOURCE in {"deezer", "spotiflac"} or "music.apple.com" in SOURCE_URL:
                _run_spotiflac(output)
            else:
                _run_ytdlp(output)
            if output.stat().st_size < 1024:
                raise RuntimeError("acquired FLAC is unexpectedly small")
            import boto3
            client = boto3.client("s3", endpoint_url=R2_ENDPOINT, aws_access_key_id=R2_ACCESS_KEY, aws_secret_access_key=R2_SECRET, region_name="auto")
            key = f"audio/tracks/{TRACK_ID}.flac"
            size_bytes = output.stat().st_size
            duration = duration_ms(output)
            client.upload_file(str(output), R2_BUCKET, key, ExtraArgs={"ContentType": "audio/flac"})
            write_result("complete", storage_key=key, duration_ms=duration, size_bytes=size_bytes)
        except Exception as exc:
            write_result("failed", error=str(exc)[-4000:])
            raise


if __name__ == "__main__":
    main()
