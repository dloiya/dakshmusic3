import re
import sys
import urllib.parse
from urllib.parse import urlparse

import requests

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149 Safari/537.36"


def _normalize(s: str) -> str:
    return "".join(ch.lower() for ch in s if ch.isalnum() or ch.isspace()).strip()


def _normalize_isrc(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def deezer_isrc_from_source_url(source_url: str) -> str:
    """
    Fetch the canonical ISRC directly from Deezer's own track endpoint,
    using the same source_url the Worker already gives us. This is the
    same approach validate_audio.py uses as ground truth, so resolving
    through it here means we're targeting the exact same recording the
    validator will check against, not just something that looks similar.
    """
    if not source_url:
        return ""
    parsed = urlparse(source_url)
    if parsed.hostname not in {"deezer.com", "www.deezer.com", "api.deezer.com"}:
        return ""
    match = re.search(r"/track/(\d+)", parsed.path)
    if not match:
        return ""
    try:
        r = requests.get(
            f"https://api.deezer.com/track/{match.group(1)}",
            headers={"User-Agent": UA},
            timeout=15,
        )
        r.raise_for_status()
        return _normalize_isrc(r.json().get("isrc", ""))
    except Exception:
        return ""


def apple_music_url_from_isrc(isrc: str):
    """
    Resolve a track to its Apple Music URL via an exact ISRC lookup.
    ISRC is a globally unique recording identifier, so unlike a text
    search this can't accidentally match a different song by the same
    artist. Returns None (not an exception) on no match, since this is
    meant to be tried before falling back to fuzzy search.
    """
    if not isrc:
        return None
    try:
        r = requests.get(
            "https://itunes.apple.com/lookup",
            params={"isrc": isrc, "entity": "song", "country": "US"},
            headers={"User-Agent": UA},
            timeout=20,
        )
        r.raise_for_status()
        results = r.json().get("results", [])
    except Exception:
        return None
    for item in results:
        url = item.get("trackViewUrl")
        if url:
            return url
    return None


def apple_music_url_from_search(title, artist, album=""):
    """
    Resolve a track to its Apple Music URL using Apple's free, unauthenticated
    iTunes Search API (no account, no developer registration, no Premium
    requirement -- unlike Spotify's Web API as of Feb 2026).

    Returns a URL in the form spotiflac expects:
    https://music.apple.com/<storefront>/album/<slug>/<albumId>?i=<trackId>
    """
    term = f"{artist} {title}"
    params = {
        "term": term,
        "media": "music",
        "entity": "song",
        "limit": 10,
        "country": "US",
    }
    r = requests.get(
        "https://itunes.apple.com/search",
        params=params,
        headers={"User-Agent": UA},
        timeout=20,
    )
    r.raise_for_status()
    results = r.json().get("results", [])

    if not results:
        raise RuntimeError(f"No Apple Music result found for {artist} - {title}")

    wanted_artist = _normalize(artist)
    wanted_title = _normalize(title)

    def score(item):
        item_artist = _normalize(item.get("artistName", ""))
        item_title = _normalize(item.get("trackName", ""))
        s = 0
        if item_artist == wanted_artist:
            s += 2
        elif wanted_artist in item_artist or item_artist in wanted_artist:
            s += 1
        if item_title == wanted_title:
            s += 2
        elif wanted_title in item_title or item_title in wanted_title:
            s += 1
        return s

    best = max(results, key=score)
    best_score = score(best)

    # Previously this only required the artist to match, which let a
    # completely different song by the same artist through silently
    # (e.g. resolving "King Kunta" to "HUMBLE." because both are
    # Kendrick Lamar). Require the title to also plausibly match --
    # score 3 needs meaningful agreement on both artist and title, not
    # just one of them.
    if best_score < 3:
        raise RuntimeError(
            f"No confident Apple Music match for {artist} - {title} "
            f"(best candidate: {best.get('artistName')} - {best.get('trackName')}, score {best_score})"
        )

    url = best.get("trackViewUrl")
    if not url:
        raise RuntimeError(f"Apple Music result for {artist} - {title} had no trackViewUrl")
    return url


def resolve_apple_music_url(title, artist, album="", source_url=""):
    """
    Preferred entry point: try an exact ISRC match first (via Deezer's own
    track detail), falling back to the scored fuzzy text search only if
    that isn't available or doesn't find anything.
    """
    isrc = deezer_isrc_from_source_url(source_url)
    if isrc:
        url = apple_music_url_from_isrc(isrc)
        if url:
            return url
    return apple_music_url_from_search(title, artist, album)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: resolve_apple.py <title> <artist> [album]")
    title, artist = sys.argv[1], sys.argv[2]
    album = sys.argv[3] if len(sys.argv) == 4 else ""
    print(apple_music_url_from_search(title, artist, album))
