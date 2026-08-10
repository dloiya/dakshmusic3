import sys, time, requests

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149 Safari/537.36"

_token_cache = {"value": None, "expires_at": 0}


def _get_anonymous_token(session):
    """
    Fetches a short-lived anonymous access token the same way
    open.spotify.com's own web player does for logged-out visitors.

    This does NOT require a Spotify account, Premium, or a registered
    developer app -- it's the same mechanism the search page itself uses
    to let anyone browse/search without signing in. (Spotify's official
    Web API now requires a Premium account to even register an app, which
    is why we don't use that path here.)
    """
    now = time.time()
    if _token_cache["value"] and _token_cache["expires_at"] > now + 10:
        return _token_cache["value"]

    # Visiting the homepage first establishes the cookies the token
    # endpoint expects.
    session.get(
        "https://open.spotify.com/",
        headers={"User-Agent": UA},
        timeout=20,
    )

    r = session.get(
        "https://open.spotify.com/get_access_token",
        params={"reason": "transport", "productType": "web_player"},
        headers={"User-Agent": UA, "Accept": "application/json"},
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()

    token = data.get("accessToken")
    if not token:
        raise RuntimeError("Could not obtain an anonymous Spotify access token")

    _token_cache["value"] = token
    _token_cache["expires_at"] = data.get("accessTokenExpirationTimestampMs", (now + 3000) * 1000) / 1000
    return token


def spotify_url_from_search(title, artist, kind="track"):
    """
    Resolve a track/album to its Spotify URL using the same anonymous
    web-player search endpoint the public search page uses when logged
    out. Replaces the old approach of regex-scraping
    open.spotify.com/search's raw HTML, which doesn't work because that
    page is a JS-rendered SPA and returns no track links without
    executing JavaScript.
    """
    session = requests.Session()
    token = _get_anonymous_token(session)

    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
    }

    def _search(query):
        r = session.get(
            "https://api.spotify.com/v1/search",
            params={"q": query, "type": kind, "limit": 5},
            headers=headers,
            timeout=20,
        )
        r.raise_for_status()
        return r.json().get(f"{kind}s", {}).get("items", [])

    field = "track" if kind == "track" else "album"
    items = _search(f"{field}:{title} artist:{artist}")
    if not items:
        items = _search(f"{artist} {title}")

    if not items:
        raise RuntimeError(f"No Spotify {kind} result found for {artist} - {title}")

    return items[0]["external_urls"]["spotify"]


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: resolve_spotify.py <track|album> <title> <artist>")
    print(spotify_url_from_search(sys.argv[2], sys.argv[3], sys.argv[1]))
