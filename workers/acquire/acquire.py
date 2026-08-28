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

import boto3
import requests


# ============================================================
# Environment
# ============================================================

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
R2_SECRET_KEY = os.environ["R2_SECRET_KEY"]

YTDLP_COOKIES_B64 = os.environ.get("YTDLP_COOKIES_B64")

RESULT_FILE = Path(
    os.environ.get(
        "RESULT_FILE",
        "/tmp/acquisition-result.json",
    )
)

MDL_HOSTS = (
    "open.spotify.com",
    "music.apple.com",
    "music.amazon.",
    "music.youtube.com",
    "youtube.com",
    "youtu.be",
    "soundcloud.com",
    "bandcamp.com",
    "qobuz.com",
    "deezer.com",
    "tidal.com",
)


# ============================================================
# Result handling
# ============================================================

def write_result(status: str, **extra) -> None:
    result = {
        "job_id": JOB_ID,
        "track_id": TRACK_ID,
        "status": status,
        **extra,
    }

    RESULT_FILE.write_text(
        json.dumps(result),
        encoding="utf-8",
    )


# ============================================================
# Cookie handling
# ============================================================

def create_cookie_file() -> Path | None:
    """
    Decode the base64 YouTube cookies into a temporary Netscape
    cookie file usable by both MusicDL and yt-dlp.
    """

    if not YTDLP_COOKIES_B64:
        return None

    fd, cookie_path = tempfile.mkstemp(
        suffix=".txt",
        prefix="youtube-cookies-",
    )

    os.close(fd)

    path = Path(cookie_path)

    try:
        path.write_bytes(
            base64.b64decode(YTDLP_COOKIES_B64)
        )
    except Exception:
        path.unlink(missing_ok=True)
        raise

    return path


# ============================================================
# MusicDL source resolution
# ============================================================

def spotify_from_isrc() -> str | None:
    """
    Try to resolve the ISRC to a Spotify track URL.
    """

    if not ISRC:
        return None

    try:
        response = requests.get(
            f"https://isrctools.com/api/lookup/{ISRC}",
            timeout=30,
        )

        response.raise_for_status()

        data = response.json()

        for track in data.get("tracks", []):
            url = str(track.get("url") or "")

            match = re.search(
                r"https?://open\.spotify\.com/track/[A-Za-z0-9]+",
                url,
            )

            if match:
                return match.group(0)

    except Exception as exc:
        print("ISRC lookup failed:", exc)

    return None


def get_mdl_url() -> str | None:
    """
    Determine the best URL to pass to MusicDL.

    Priority:
    1. Existing supported source URL
    2. Deezer track ID
    3. Spotify lookup from ISRC
    """

    if SOURCE_URL.startswith(("http://", "https://")):
        source_url_lower = SOURCE_URL.casefold()

        if any(host in source_url_lower for host in MDL_HOSTS):
            print("MusicDL input: source URL", SOURCE_URL)
            return SOURCE_URL

    if SOURCE == "deezer" and SOURCE_ID:
        deezer_url = (
            "https://www.deezer.com/track/"
            f"{quote(SOURCE_ID, safe='')}"
        )

        print("MusicDL input: Deezer track URL", deezer_url)

        return deezer_url

    spotify_url = spotify_from_isrc()

    if spotify_url:
        print("MusicDL input: Spotify URL resolved from ISRC")
        return spotify_url

    return None


# ============================================================
# File helpers
# ============================================================

def find_flac(root: Path) -> Path | None:
    """
    Return the newest valid FLAC file under root.
    """

    candidates = [
        path
        for path in root.rglob("*.flac")
        if path.is_file()
        and path.stat().st_size >= 1024
    ]

    if not candidates:
        return None

    return max(
        candidates,
        key=lambda path: path.stat().st_mtime,
    )


# ============================================================
# MusicDL acquisition
# ============================================================

def run_mdl(
    output: Path,
    cookie_path: Path | None,
) -> None:
    """
    Acquire audio using MusicDL.

    The source may be a track, album, or playlist URL.
    """

    source_url = get_mdl_url()

    if not source_url:
        raise RuntimeError(
            "No supported MusicDL source URL available"
        )

    output_dir = output.parent / "mdl-output"

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    command = [
        "npx",
        "--yes",
        "@mdlx/cli",
        source_url,

        "--output",
        str(output_dir),

        "--parallel",
        "1",

        "--format",
        "flac",

        "--bitrate",
        "best",

        "--no-po-token",
    ]

    if cookie_path:
        command.extend([
            "--yt-cookie",
            str(cookie_path),
        ])

    print(
        "Running MusicDL:",
        " ".join(command[:6]),
        "...",
    )

    completed = subprocess.run(
        command,
        cwd=str(output_dir),
        text=True,
        capture_output=True,
        timeout=720,
    )

    log = (
        completed.stdout
        + completed.stderr
    )

    print(
        "MusicDL output tail:",
        log[-2500:],
    )

    if completed.returncode != 0:
        raise RuntimeError(
            (
                log[-4000:]
                or "MusicDL failed"
            ).replace("\n", " ")
        )

    # MusicDL can occasionally exit successfully even when
    # the per-track result contains an error.
    if re.search(
        r"\bError:\s*\{",
        log,
        re.IGNORECASE,
    ):
        raise RuntimeError(
            (
                log[-4000:]
                or "MusicDL reported a track error"
            ).replace("\n", " ")
        )

    source_file = (
        find_flac(output_dir)
        or find_flac(output.parent)
    )

    if not source_file:
        raise RuntimeError(
            "MusicDL completed without producing a FLAC file"
        )

    if source_file.resolve() != output.resolve():
        shutil.copy2(
            source_file,
            output,
        )


# ============================================================
# yt-dlp fallback
# ============================================================

def get_ytdlp_candidates() -> list[str]:
    """
    Search YouTube using both ISRC and title/artist queries.

    Results are deduplicated while preserving search order.
    """

    queries: list[str] = []

    if ISRC:
        queries.append(
            f'ytsearch10:"{ISRC}"'
        )

    if TITLE or ARTIST:
        queries.append(
            f'ytsearch10:"{TITLE}" {ARTIST}'
        )

    candidates: list[str] = []

    for query in queries:

        print(
            "Searching YouTube:",
            query,
        )

        completed = subprocess.run(
            [
                "yt-dlp",
                "--flat-playlist",
                "--print",
                "%(id)s",
                query,
                "--no-warnings",
            ],
            text=True,
            capture_output=True,
            timeout=120,
        )

        for video_id in completed.stdout.splitlines():

            video_id = video_id.strip()

            if video_id:
                candidates.append(video_id)

    return list(
        dict.fromkeys(candidates)
    )


def run_ytdlp(
    output: Path,
    cookie_path: Path | None,
) -> None:
    """
    Try multiple YouTube candidates until one produces a FLAC.
    """

    candidates = get_ytdlp_candidates()

    print(
        "yt-dlp candidate count:",
        len(candidates),
    )

    if not candidates:
        raise RuntimeError(
            "yt-dlp search returned no candidates"
        )

    errors: list[str] = []

    for video_id in candidates:

        video_url = (
            "https://www.youtube.com/watch?v="
            f"{video_id}"
        )

        command = [
            "yt-dlp",
            video_url,

            "--no-playlist",

            "--extract-audio",

            "--audio-format",
            "flac",

            "--audio-quality",
            "0",

            "--js-runtimes",
            "deno",

            "--remote-components",
            "ejs:github",

            "--output",
            str(
                output.with_suffix(
                    ".%(ext)s"
                )
            ),

            "--no-warnings",

            "--retries",
            "3",

            "--extractor-retries",
            "3",
        ]

        if cookie_path:
            command.extend([
                "--cookies",
                str(cookie_path),
            ])

        print(
            "Trying yt-dlp candidate:",
            video_id,
        )

        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=720,
        )

        if completed.returncode == 0:

            source_file = find_flac(
                output.parent
            )

            if source_file:

                if (
                    source_file.resolve()
                    != output.resolve()
                ):
                    shutil.move(
                        source_file,
                        output,
                    )

                return

        error = (
            completed.stderr[-800:]
            or completed.stdout[-800:]
            or "yt-dlp failed"
        )

        errors.append(
            error.replace("\n", " ")
        )

    raise RuntimeError(
        " | ".join(errors[-5:])
    )


# ============================================================
# Acquisition
# ============================================================

def acquire_audio(
    output: Path,
    cookie_path: Path | None,
) -> str:
    """
    Try MusicDL first, then fall back to yt-dlp.
    """

    try:

        run_mdl(
            output,
            cookie_path,
        )

        print(
            "Acquisition succeeded with MusicDL"
        )

        return "mdl"

    except Exception as exc:

        print(
            "MusicDL failed:",
            exc,
        )

        print(
            "Falling back to yt-dlp candidates"
        )

        run_ytdlp(
            output,
            cookie_path,
        )

        return "yt-dlp"


# ============================================================
# Metadata
# ============================================================

def get_duration_ms(
    audio_file: Path,
) -> int | None:

    try:

        completed = subprocess.run(
            [
                "ffprobe",

                "-v",
                "error",

                "-show_entries",
                "format=duration",

                "-of",
                "default=noprint_wrappers=1:nokey=1",

                str(audio_file),
            ],
            text=True,
            capture_output=True,
            check=True,
        )

        seconds = float(
            completed.stdout.strip()
        )

        return int(
            seconds * 1000
        )

    except Exception:

        return None


# ============================================================
# R2 upload
# ============================================================

def upload_to_r2(
    audio_file: Path,
) -> str:

    storage_key = (
        f"audio/tracks/{TRACK_ID}.flac"
    )

    client = boto3.client(
        "s3",

        endpoint_url=R2_ENDPOINT,

        aws_access_key_id=R2_ACCESS_KEY,

        aws_secret_access_key=R2_SECRET_KEY,

        region_name="auto",
    )

    client.upload_file(
        str(audio_file),
        R2_BUCKET,
        storage_key,
        ExtraArgs={
            "ContentType": "audio/flac",
        },
    )

    return storage_key


# ============================================================
# Main
# ============================================================

def main() -> None:

    with tempfile.TemporaryDirectory() as temp_dir:

        temp_dir = Path(temp_dir)

        output = (
            temp_dir
            / "audio.flac"
        )

        cookie_path: Path | None = None

        try:

            cookie_path = create_cookie_file()

            provider = acquire_audio(
                output,
                cookie_path,
            )

            if (
                not output.exists()
                or output.stat().st_size < 1024
            ):
                raise RuntimeError(
                    "Acquired FLAC is missing or too small"
                )

            storage_key = upload_to_r2(
                output
            )

            write_result(
                "complete",

                storage_key=storage_key,

                duration_ms=get_duration_ms(
                    output
                ),

                size_bytes=output.stat().st_size,

                provider=provider,
            )

            print(
                "Acquisition completed successfully:",
                storage_key,
            )

        except Exception as exc:

            error_message = (
                str(exc)
                .replace("\n", " ")
                [-4000:]
            )

            write_result(
                "failed",
                error=error_message,
            )

            raise

        finally:

            if cookie_path:
                cookie_path.unlink(
                    missing_ok=True
                )


if __name__ == "__main__":
    main()
