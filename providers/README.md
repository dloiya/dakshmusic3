# Acquisition providers

Primary is SpotiFLAC 1.5.2. Its headless CLI needs a track-identifying URL
before it can download lossless audio from Deezer/Tidal/Qobuz/Amazon --
it explicitly rejects Deezer URLs as direct input, and Spotify's own
lookup path isn't usable here (see below). Instead, the provider resolves
the selected title/artist to an Apple Music URL via Apple's free,
unauthenticated iTunes Search API (no account, no app registration), then
hands that to SpotiFLAC.

## Why not Spotify?

Two separate problems rule Spotify out entirely:

- As of February 2026, Spotify requires the account registering a
  developer app to have Premium, blocking the official Web API path.
- Even the unofficial/anonymous web-player token lookup (the same
  mechanism the public search page itself uses when logged out) gets a
  403 from GitHub Actions' datacenter IP ranges.

Apple's iTunes Search API has no such account requirement and is
historically much more lenient about datacenter/cloud IPs.

Fallback is a headless adapter based on the YtFLAC project's documented
stack: yt-dlp + ffmpeg, FLAC extraction, metadata and thumbnail embedding.
Note this fallback path produces a FLAC *container* but not lossless
*audio* -- YouTube doesn't serve lossless sources, so this is a quality
downgrade compared to the primary path, used only when primary fails.

Upstream YtFLAC: https://github.com/hmz64/YtFLAC

### YouTube bot-check

YouTube frequently blocks requests from datacenter IPs (like GitHub-hosted
runners) with "Sign in to confirm you're not a bot." The most reliable
mitigation is supplying real browser cookies via the optional
`YTDLP_COOKIES_B64` GitHub Actions secret (base64-encoded `cookies.txt`
exported from a logged-in browser session). See the yt-dlp wiki:
https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies

If both providers keep failing even with these mitigations, the most
durable fix is running this workflow on a self-hosted runner (e.g. a
machine on your home network) instead of GitHub's cloud runners, since
datacenter IPs are specifically what gets blocked.

Only use audio sources and downloads you are authorized to access.
