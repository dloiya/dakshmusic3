from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote

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
MDL_SUPPORTED_HOSTS = ("open.spotify.com", "music.apple.com", "music.amazon.", "music.youtube.com", "youtube.com", "youtu.be", "soundcloud.com", "bandcamp.com", "deezer.com", "qobuz.com", "tidal.com")


def write_result(status: str, **extra):
    RESULT_FILE.write_text(json.dumps({"job_id": JOB_ID, "track_id": TRACK_ID, "status": status, **extra}), encoding="utf-8")


def _resolve_spotify_from_isrc() -> str | None:
    if not ISRC:
        return None
    response = requests.get(f"https://isrctools.com/api/lookup/{ISRC}", headers={**HEADERS, "Accept": "application/json"}, timeout=30)
    response.raise_for_status()
    data = response.json()
    tracks = [t for t in (data.get("tracks") or []) if t.get("url") and "open.spotify.com/track/" in t["url"]]
    if not tracks:
        return None
    match = re.search(r"https?://open\.spotify\.com/track/[A-Za-z0-9]+", str(tracks[0]["url"]))
    return match.group(0) if match else None


def _is_mdl_url(url: str) -> bool:
    value = url.casefold()
    return value.startswith(("http://", "https://")) and any(host in value for host in MDL_SUPPORTED_HOSTS)


def _resolve_mdl_url() -> str | None:
    if _is_mdl_url(SOURCE_URL):
        print(f"MusicDL input: source URL {SOURCE_URL}")
        return SOURCE_URL
    if SOURCE == "deezer" and SOURCE_ID:
        return f"https://www.deezer.com/track/{quote(SOURCE_ID, safe='')}"
    return _resolve_spotify_from_isrc()


def _find_flac(root: Path) -> Path:
    files = [p for p in root.rglob("*.flac") if p.is_file() and p.stat().st_size >= 1024]
    if not files:
        raise RuntimeError(f"MusicDL produced no usable FLAC for {TITLE} / {ARTIST}")
    return max(files, key=lambda p: p.stat().st_mtime)


def _run_mdl(output: Path) -> None:
    source_url = _resolve_mdl_url()
    if not source_url:
        raise RuntimeError(f"MusicDL needs a supported source URL or ISRC mapping for {TITLE} / {ARTIST}")
    mdl = os.environ.get("MDL_BIN") or shutil.which("mdl")
    if not mdl:
        raise RuntimeError("MusicDL executable 'mdl' was not found on PATH")
    outdir = output.parent / "mdl-output"
    outdir.mkdir(parents=True, exist_ok=True)
    command = [mdl, source_url, "--output", str(outdir), "--format", "flac", "--parallel", "1"]
    print("Running MusicDL:", " ".join(command[:2]), "...")
    completed = subprocess.run(command, cwd=str(outdir), text=True, capture_output=True, timeout=12 * 60)
    print("MusicDL stdout tail:", completed.stdout[-2000:])
    if completed.returncode:
        raise RuntimeError((completed.stderr[-4000:] or completed.stdout[-4000:] or "MusicDL failed").replace("\n", " "))
    candidates = []
    for root in (outdir, output.parent):
        candidates.extend([p for p in root.rglob("*.flac") if p.is_file() and p.stat().st_size >= 1024])
    candidates = list({p.resolve(): p for p in candidates}.values())
    if not candidates:
        raise RuntimeError(f"MusicDL exited successfully but produced no FLAC. stderr={completed.stderr[-2000:]!r}")
    source = max(candidates, key=lambda p: p.stat().st_mtime)
    if source.resolve() != output.resolve():
        shutil.copy2(source, output)


def _run_ytdlp(output: Path, target_url: str | None = None):
    target = target_url or (f"ytsearch5:{ISRC} {TITLE} {ARTIST}" if ISRC else f"ytsearch5:{TITLE} {ARTIST}")
    base = ["yt-dlp", target, "--no-playlist", "-x", "--audio-format", "flac", "--audio-quality", "0", "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg", "--js-runtimes", "deno", "--remote-components", "ejs:github", "-o", str(output.with_suffix(".%(ext)s")), "--no-warnings"]
    cookies_b64 = os.environ.get("YTDLP_COOKIES_B64")
    cookies_path = None
    if cookies_b64:
        fd, name = tempfile.mkstemp(suffix=".txt"); os.close(fd)
        cookies_path = Path(name); cookies_path.write_bytes(base64.b64decode(cookies_b64))
        base += ["--cookies", str(cookies_path)]
    selectors = ["bestaudio/best", "best", None]
    errors = []
    try:
        for selector in selectors:
            command = list(base)
            if selector:
                command += ["-f", selector]
            print("Running yt-dlp fallback with format:", selector or "auto")
            completed = subprocess.run(command, text=True, capture_output=True, timeout=12 * 60)
            if completed.returncode == 0:
                break
            errors.append((completed.stderr[-1500:] or completed.stdout[-1500:] or "yt-dlp failed").replace("\n", " "))
        else:
            raise RuntimeError(" | ".join(errors[-3:]))
    finally:
        if cookies_path:
            cookies_path.unlink(missing_ok=True)
    if not output.exists():
        candidates = list(output.parent.glob(output.stem + ".flac"))
        if candidates:
            shutil.move(candidates[0], output)
    if not output.exists():
        raise RuntimeError(f"yt-dlp succeeded but produced no FLAC for {TITLE} / {ARTIST}")


def _acquire_audio(output: Path) -> str:
    try:
        _run_mdl(output)
        print(f"Acquisition succeeded with MusicDL for {TITLE} / {ARTIST}")
        return "mdl"
    except Exception as mdl_error:
        print(f"MusicDL failed for {TITLE} / {ARTIST}: {mdl_error}")
        print("Falling back to yt-dlp search")
        _run_ytdlp(output)
        return "yt-dlp"


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
            provider = _acquire_audio(output)
            if not output.exists() or output.stat().st_size < 1024:
                raise RuntimeError("acquired FLAC is unexpectedly small or missing")
            import boto3
            client = boto3.client("s3", endpoint_url=R2_ENDPOINT, aws_access_key_id=R2_ACCESS_KEY, aws_secret_access_key=R2_SECRET, region_name="auto")
            key = f"audio/tracks/{TRACK_ID}.flac"
            size_bytes = output.stat().st_size
            client.upload_file(str(output), R2_BUCKET, key, ExtraArgs={"ContentType": "audio/flac"})
            write_result("complete", storage_key=key, duration_ms=duration_ms(output), size_bytes=size_bytes, provider=provider)
        except Exception as exc:
            write_result("failed", error=str(exc).replace("\n", " ")[-4000:]); raise

if __name__ == "__main__":
    main()
