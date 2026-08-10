import os, sys, time, requests

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149 Safari/537.36"

_token_cache = {"value": None, "expires_at": 0}


def _get_access_token():
    """
    Client-credentials flow against Spotify's Web API.

    Requires SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in the environment.
    These come from a free Spotify Developer app:
    https://developer.spotify.com/dashboard
    """
    now = time.time()
    if _token_cache["value"] and _token_cache["expires_at"] > now + 10:
        return _token_cache["value"]

    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError(
            "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not configured "
            "(required for Spotify Web API search)"
        )

    r = requests.post(
        "https://accounts.spotify.com/api/token",
        data={"grant_type": "client_credentials"},
        auth=(client_id, client_secret),
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()

    _token_cache["value"] = data["access_token"]
    _token_cache["expires_at"] = now + data.get("expires_in", 3600)
    return _token_cache["value"]


def spotify_url_from_search(title, artist, kind="track"):
    """
    Search the official Spotify Web API and return the first matching
    track/album URL. Replaces the old approach of scraping
    open.spotify.com/search, which doesn't work because that page is a
    JS-rendered SPA and returns no track links in the raw HTML.
    """
    token = _get_access_token()

    q = f"track:{title} artist:{artist}" if kind == "track" else f"album:{title} artist:{artist}"

    r = requests.get(
        "https://api.spotify.com/v1/search",
        params={"q": q, "type": kind, "limit": 5},
        headers={"Authorization": f"Bearer {token}", "User-Agent": UA},
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()

    items = data.get(f"{kind}s", {}).get("items", [])
    if not items:
        # Fall back to a looser, unstructured query before giving up.
        r = requests.get(
            "https://api.spotify.com/v1/search",
            params={"q": f"{artist} {title}", "type": kind, "limit": 5},
            headers={"Authorization": f"Bearer {token}", "User-Agent": UA},
            timeout=20,
        )
        r.raise_for_status()
        items = r.json().get(f"{kind}s", {}).get("items", [])

    if not items:
        raise RuntimeError(f"No Spotify {kind} result found for {artist} - {title}")

    return items[0]["external_urls"]["spotify"]


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: resolve_spotify.py <track|album> <title> <artist>")
    print(spotify_url_from_search(sys.argv[2], sys.argv[3], sys.argv[1]))
