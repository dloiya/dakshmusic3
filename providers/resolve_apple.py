import sys
import urllib.parse

import requests

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149 Safari/537.36"


def _normalize(s: str) -> str:
    return "".join(ch.lower() for ch in s if ch.isalnum() or ch.isspace()).strip()


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

    # Prefer a result whose artist matches exactly; otherwise fall back to
    # whichever result iTunes ranked first.
    best = None
    for item in results:
        if _normalize(item.get("artistName", "")) == wanted_artist:
            best = item
            break
    if best is None:
        best = results[0]

    url = best.get("trackViewUrl")
    if not url:
        raise RuntimeError(f"Apple Music result for {artist} - {title} had no trackViewUrl")
    return url


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: resolve_apple.py <title> <artist> [album]")
    title, artist = sys.argv[1], sys.argv[2]
    album = sys.argv[3] if len(sys.argv) == 4 else ""
    print(apple_music_url_from_search(title, artist, album))
