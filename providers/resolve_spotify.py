import html,re,sys,urllib.parse,requests
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149 Safari/537.36"
def spotify_url_from_search(title,artist,kind="track"):
    q=urllib.parse.quote_plus(f"{artist} {title}")
    r=requests.get(f"https://open.spotify.com/search/{q}/{kind}s",
                   headers={"User-Agent":UA,"Accept-Language":"en-US,en;q=0.9"},timeout=20)
    r.raise_for_status()
    body=html.unescape(r.text)
    ids=list(dict.fromkeys(re.findall(r'https://open\.spotify\.com/'+kind+r'/([A-Za-z0-9]+)',body)))
    if not ids:
        ids=list(dict.fromkeys(re.findall(r'href=["\']/'+kind+r'/([A-Za-z0-9]+)',body)))
    if not ids: raise RuntimeError(f"No Spotify {kind} result found for {artist} - {title}")
    return f"https://open.spotify.com/{kind}/{ids[0]}"
if __name__=="__main__":
    if len(sys.argv)!=4: raise SystemExit("usage: resolve_spotify.py <track|album> <title> <artist>")
    print(spotify_url_from_search(sys.argv[2],sys.argv[3],sys.argv[1]))
