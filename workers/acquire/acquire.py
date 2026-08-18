from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests

JOB_ID = os.environ["JOB_ID"]
TRACK_ID = os.environ["TRACK_ID"]
TITLE = os.environ.get("TITLE", "")
ARTIST = os.environ.get("ARTIST", "")
ALBUM = os.environ.get("ALBUM", "")
SOURCE = os.environ.get("SOURCE", "")
SOURCE_ID = os.environ.get("SOURCE_ID", "")
SOURCE_URL = os.environ.get("SOURCE_URL", "")
ISRC = os.environ.get("ISRC", "")
R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_BUCKET = os.environ.get("R2_BUCKET", "dakshmusic3-audio")
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY"]
R2_SECRET = os.environ["R2_SECRET_KEY"]
RESULT_FILE = Path(os.environ.get("RESULT_FILE", "/tmp/acquisition-result.json"))

HEADERS = {"User-Agent": "Mozilla/5.0 (dakshmusic3-acquisition)"}


def write_result(status: str, **extra):
    RESULT_FILE.write_text(json.dumps({"job_id": JOB_ID, "track_id": TRACK_ID, "status": status, **extra}), encoding="utf-8")


def _deezer_track() -> dict:
    if SOURCE == "deezer" and SOURCE_ID:
        response = requests.get(f"https://api.deezer.com/track/{SOURCE_ID}", headers=HEADERS, timeout=20)
        response.raise_for_status()
        track = response.json()
        if track.get("id"):
            return track
    if ISRC:
        response = requests.get(f"https://api.deezer.com/track/isrc:{ISRC}", headers=HEADERS, timeout=20)
        if response.ok:
            track = response.json()
            if track.get("id"):
                return track
    query = f"{TITLE} {ARTIST}".strip()
    response = requests.get("https://api.deezer.com/search/track", params={"q": query, "limit": 10}, headers=HEADERS, timeout=20)
    response.raise_for_status()
    tracks = response.json().get("data") or []
    if not tracks:
        raise RuntimeError(f"Deezer metadata lookup returned no tracks for {TITLE} / {ARTIST}")
    title_norm, artist_norm = TITLE.casefold().strip(), ARTIST.casefold().strip()
    def score(track):
        t = str(track.get("title", "")).casefold().strip()
        a = str((track.get("artist") or {}).get("name", "")).casefold().strip()
        return (2 if t == title_norm else 0) + (2 if a == artist_norm else 0)
    return max(tracks, key=score)


def _deezer_track_url() -> str:
    track = _deezer_track()
    if not track.get("id"):
        raise RuntimeError(f"Deezer metadata has no track id for {TITLE} / {ARTIST}")
    return f"https://www.deezer.com/track/{track['id']}"


def _songlink_links(deezer_url: str) -> dict[str, str]:
    try:
        response = requests.get("https://song.link/", params={"url": deezer_url}, headers=HEADERS, timeout=20, allow_redirects=True)
        if not response.ok:
            return {}
        html = response.text
    except requests.RequestException:
        return {}
    links = {}
    patterns = {
        "spotify": r'https?:\\?/\\?/open\\.spotify\\.com\\/(?:intl-[^/\\]+\\/)?track\\/[A-Za-z0-9]+',
        "youtube": r'https?:\\?/\\?/(?:www\\.)?youtube\\.com\\/(?:watch\\?v=|shorts/)[A-Za-z0-9_-]+',
        "youtube_music": r'https?:\\?/\\?music\\.youtube\\.com\\/watch\\?v=[A-Za-z0-9_-]+',
    }
    for name, pattern in patterns.items():
        match = re.search(pattern, html)
        if match:
            links[name] = match.group(0).replace("\\/", "/")
    return links


def _resolve_youtube_url(deezer_url: str) -> str | None:
    links = _songlink_links(deezer_url)
    if links.get("youtube_music"):
        return links["youtube_music"]
    if links.get("youtube"):
        return links["youtube"]
    query = f"{ISRC} {TITLE} {ARTIST}".strip() if ISRC else f"{TITLE} {ARTIST}".strip()
    command = ["yt-dlp", f"ytsearch1:{query}", "--flat-playlist", "--print", "%(webpage_url)s", "--skip-download", "--no-warnings"]
    completed = subprocess.run(command, text=True, capture_output=True, timeout=90)
    if completed.returncode:
        return None
    for line in completed.stdout.splitlines():
        line = line.strip()
        if line.startswith(("http://", "https://")):
            return line
    return None


def _download_spotiflac(url: str, output: Path) -> None:
    import asyncio
    import glob
    from SpotiFLAC.client import AsyncSpotiFLAC
    outdir = output.parent / "_spotiflac"
    outdir.mkdir(parents=True, exist_ok=True)
    async def download():
        async with AsyncSpotiFLAC(output_dir=str(outdir), services=["tidal", "qobuz", "amazon"], quality="LOSSLESS", track_max_retries=2, timeout_s=180, embed_lyrics=False, use_extensions_fallback=False) as client:
            await client.download_track(url)
    asyncio.run(download())
    files = [Path(p) for p in glob.glob(str(outdir / "**" / "*.flac"), recursive=True)]
    if not files:
        raise RuntimeError(f"SpotiFLAC produced no FLAC for {TITLE} / {ARTIST}")
    shutil.copy2(max(files, key=lambda p: p.stat().st_mtime), output)


def _run_spotiflac(output: Path):
    deezer_url = _deezer_track_url()
    spotify_url = _songlink_links(deezer_url).get("spotify")
    if spotify_url:
        print(f"SpotiFLAC input: Spotify {spotify_url}")
        try:
            _download_spotiflac(spotify_url, output)
            return
        except Exception as exc:
            print(f"Spotify acquisition failed for {TITLE} / {ARTIST}: {exc}")
    youtube_url = _resolve_youtube_url(deezer_url)
    if not youtube_url:
        raise RuntimeError(f"No Spotify or YouTube mapping for {TITLE} / {ARTIST}")
    print(f"YouTube fallback: {youtube_url}")
    _run_ytdlp(output, youtube_url)


def _run_ytdlp(output: Path, target_url: str | None = None):
    target = target_url or (f"ytsearch5:{ISRC} {TITLE} {ARTIST}" if ISRC else f"ytsearch5:{TITLE} {ARTIST}")
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
            raise RuntimeError((completed.stderr[-4000:] or completed.stdout[-4000:] or "yt-dlp failed").replace("\n", " "))
    finally:
        if cookies_path:
            cookies_path.unlink(missing_ok=True)
    if not output.exists():
        candidates = list(output.parent.glob(output.stem + ".flac"))
        if candidates:
            shutil.move(candidates[0], output)
    if not output.exists():
        raise RuntimeError(f"yt-dlp produced no FLAC for {TITLE} / {ARTIST}")


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
            write_result("failed", error=str(exc).replace("\n", " ")[-4000:])
            raise


if __name__ == "__main__":
    main()
