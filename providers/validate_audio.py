import json
import os
import re
import subprocess
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"\([^)]*\b(?:remix|edit|version|mix|live|remaster(?:ed)?)\b[^)]*\)", " ", value)
    value = re.sub(r"\[[^]]*\b(?:remix|edit|version|mix|live|remaster(?:ed)?)\b[^]]*\]", " ", value)
    value = value.replace("&", " and ")
    value = re.sub(r"\b(feat\.?|ft\.?)\b.*$", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def similarity(a: str, b: str) -> float:
    a, b = normalize(a), normalize(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def read_metadata(path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format_tags=title,artist,album,album_artist,track",
        "-of", "json", str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")
    data = json.loads(result.stdout or "{}")
    tags = (data.get("format") or {}).get("tags") or {}
    return {str(k).lower(): str(v).strip() for k, v in tags.items() if v is not None}


def main(path_text: str) -> None:
    path = Path(path_text).resolve()
    expected_title = os.environ.get("AUDIO_TITLE", "").strip()
    expected_artist = os.environ.get("AUDIO_ARTIST", "").strip()
    expected_album = os.environ.get("AUDIO_ALBUM", "").strip()

    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError("Validation failed: output audio file is missing or empty")

    actual = read_metadata(path)
    actual_title = actual.get("title", "")
    actual_artist = actual.get("artist", "")
    actual_album = actual.get("album", "")

    title_score = similarity(expected_title, actual_title)
    artist_score = similarity(expected_artist, actual_artist)
    album_score = similarity(expected_album, actual_album) if expected_album and actual_album else None

    # Artist identity is mandatory. Title identity is also mandatory.
    # A title must be very close and the artist must be essentially the same.
    artist_ok = bool(actual_artist) and artist_score >= 0.90
    title_ok = bool(actual_title) and title_score >= 0.90

    # Album is a supporting signal only because providers may return a
    # different edition/album while still returning the correct recording.
    album_ok = album_score is None or album_score >= 0.70

    report = {
        "expected": {
            "title": expected_title,
            "artist": expected_artist,
            "album": expected_album,
        },
        "actual": {
            "title": actual_title,
            "artist": actual_artist,
            "album": actual_album,
            "album_artist": actual.get("album_artist", ""),
            "track": actual.get("track", ""),
        },
        "scores": {
            "title": round(title_score, 4),
            "artist": round(artist_score, 4),
            "album": None if album_score is None else round(album_score, 4),
        },
        "valid": bool(artist_ok and title_ok and album_ok),
    }
    print(json.dumps(report, indent=2))

    if not artist_ok:
        raise RuntimeError(
            f"Audio metadata validation failed: artist mismatch. "
            f"Requested={expected_artist!r}, downloaded={actual_artist!r}, score={artist_score:.3f}"
        )
    if not title_ok:
        raise RuntimeError(
            f"Audio metadata validation failed: title mismatch. "
            f"Requested={expected_title!r}, downloaded={actual_title!r}, score={title_score:.3f}"
        )
    if not album_ok:
        raise RuntimeError(
            f"Audio metadata validation failed: album mismatch. "
            f"Requested={expected_album!r}, downloaded={actual_album!r}, score={album_score:.3f}"
        )

    print("Audio metadata validation PASSED")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: validate_audio.py /path/to/audio.flac")
    main(sys.argv[1])
