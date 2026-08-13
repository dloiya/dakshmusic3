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
        "-show_entries",
        "format=duration:format_tags=title,artist,album,album_artist,track,isrc",
        "-of", "json", str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")

    data = json.loads(result.stdout or "{}")
    fmt = data.get("format") or {}
    tags = fmt.get("tags") or {}
    return {
        "duration_s": float(fmt["duration"]) if fmt.get("duration") else None,
        **{str(k).lower(): str(v).strip() for k, v in tags.items() if v is not None},
    }


def main(path_text: str) -> None:
    path = Path(path_text).resolve()
    expected_title = os.environ.get("AUDIO_TITLE", "").strip()
    expected_artist = os.environ.get("AUDIO_ARTIST", "").strip()
    expected_album = os.environ.get("AUDIO_ALBUM", "").strip()
    expected_duration_ms_raw = os.environ.get("AUDIO_DURATION_MS", "").strip()

    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError("Validation failed: output audio file is missing or empty")

    if not expected_duration_ms_raw:
        raise RuntimeError(
            "Validation failed: AUDIO_DURATION_MS is missing. "
            "Duration is required for recording identity verification."
        )

    try:
        expected_duration_s = float(expected_duration_ms_raw) / 1000.0
    except ValueError as exc:
        raise RuntimeError(f"Validation failed: invalid AUDIO_DURATION_MS={expected_duration_ms_raw!r}") from exc

    actual = read_metadata(path)
    actual_title = actual.get("title", "")
    actual_artist = actual.get("artist", "")
    actual_album = actual.get("album", "")
    actual_duration_s = actual.get("duration_s")

    title_score = similarity(expected_title, actual_title)
    artist_score = similarity(expected_artist, actual_artist)

    duration_delta_s = (
        abs(actual_duration_s - expected_duration_s)
        if actual_duration_s is not None
        else None
    )

    # Duration is a recording-level signal that survives changes in filenames,
    # provider title formatting, and missing/rewritten container tags. Allow a
    # small tolerance for encoder/container rounding and provider trimming.
    duration_tolerance_s = max(2.0, expected_duration_s * 0.005)
    duration_ok = (
        actual_duration_s is not None
        and duration_delta_s <= duration_tolerance_s
    )

    # Artist is another stable signal. Do not use title as an identity gate:
    # providers commonly return titles such as "Artist - Song" or omit remix
    # annotations even when the underlying recording is correct.
    artist_ok = bool(actual_artist) and artist_score >= 0.90

    # Album is diagnostic/supporting only. Different providers may identify a
    # single, deluxe edition, remaster, or compilation differently.
    album_score = similarity(expected_album, actual_album) if expected_album and actual_album else None
    album_ok = True if not expected_album or not actual_album else album_score >= 0.70

    valid = bool(artist_ok and duration_ok and album_ok)

    report = {
        "expected": {
            "title": expected_title,
            "artist": expected_artist,
            "album": expected_album,
            "duration_s": round(expected_duration_s, 3),
        },
        "actual": {
            "title": actual_title,
            "artist": actual_artist,
            "album": actual_album,
            "album_artist": actual.get("album_artist", ""),
            "track": actual.get("track", ""),
            "isrc": actual.get("isrc", ""),
            "duration_s": None if actual_duration_s is None else round(actual_duration_s, 3),
        },
        "scores": {
            "title": round(title_score, 4),
            "artist": round(artist_score, 4),
            "album": None if album_score is None else round(album_score, 4),
            "duration_delta_s": None if duration_delta_s is None else round(duration_delta_s, 3),
            "duration_tolerance_s": round(duration_tolerance_s, 3),
        },
        "checks": {
            "artist": artist_ok,
            "duration": duration_ok,
            "album": album_ok,
            "title_diagnostic_only": True,
        },
        "valid": valid,
    }
    print(json.dumps(report, indent=2))

    if not artist_ok:
        raise RuntimeError(
            f"Audio identity validation failed: artist mismatch. "
            f"Requested={expected_artist!r}, downloaded={actual_artist!r}, score={artist_score:.3f}"
        )

    if not duration_ok:
        raise RuntimeError(
            f"Audio identity validation failed: duration mismatch. "
            f"Requested={expected_duration_s:.3f}s, downloaded={actual_duration_s!r}s, "
            f"delta={duration_delta_s!r}s, tolerance={duration_tolerance_s:.3f}s"
        )

    if not album_ok:
        raise RuntimeError(
            f"Audio identity validation warning/failure: album mismatch. "
            f"Requested={expected_album!r}, downloaded={actual_album!r}, score={album_score:.3f}"
        )

    print("Audio identity validation PASSED (artist + duration)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: validate_audio.py /path/to/audio.flac")
    main(sys.argv[1])
