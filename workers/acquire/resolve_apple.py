from __future__ import annotations

import re
from urllib.parse import urlparse

import requests

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149 Safari/537.36"


def _norm(value: str) -> str:
    return "".join(ch.lower() for ch in str(value or "") if ch.isalnum() or ch.isspace()).strip()


def _isrc(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def deezer_isrc(source_url: str) -> str:
    parsed = urlparse(source_url or "")
    if parsed.hostname not in {"deezer.com", "www.deezer.com", "api.deezer.com"}:
        return ""
    match = re.search(r"/track/(\d+)", parsed.path)
    if not match:
        return ""
    try:
        response = requests.get(f"https://api.deezer.com/track/{match.group(1)}", headers={"User-Agent": UA}, timeout=15)
        response.raise_for_status()
        return _isrc(response.json().get("isrc"))
    except Exception:
        return ""


def from_isrc(isrc: str) -> str | None:
    if not isrc:
        return None
    try:
        response = requests.get("https://itunes.apple.com/lookup", params={"isrc": isrc, "entity": "song", "country": "US"}, headers={"User-Agent": UA}, timeout=20)
        response.raise_for_status()
        for item in response.json().get("results", []):
            if item.get("trackViewUrl"):
                return item["trackViewUrl"]
    except Exception:
        return None
    return None


def from_search(title: str, artist: str, album: str = "") -> str:
    response = requests.get("https://itunes.apple.com/search", params={"term": f"{artist} {title}", "media": "music", "entity": "song", "limit": 10, "country": "US"}, headers={"User-Agent": UA}, timeout=20)
    response.raise_for_status()
    results = response.json().get("results", [])
    if not results:
        raise RuntimeError(f"No Apple Music result for {artist} - {title}")
    wanted_artist, wanted_title = _norm(artist), _norm(title)

    def score(item):
        ia, it = _norm(item.get("artistName")), _norm(item.get("trackName"))
        score = 0
        if ia == wanted_artist: score += 2
        elif wanted_artist in ia or ia in wanted_artist: score += 1
        if it == wanted_title: score += 2
        elif wanted_title in it or it in wanted_title: score += 1
        return score

    best = max(results, key=score)
    if score(best) < 3 or not best.get("trackViewUrl"):
        raise RuntimeError(f"No confident Apple Music match for {artist} - {title}")
    return best["trackViewUrl"]


def resolve(title: str, artist: str, album: str = "", source_url: str = "") -> str:
    exact = from_isrc(deezer_isrc(source_url))
    return exact or from_search(title, artist, album)
