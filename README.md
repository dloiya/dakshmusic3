# Personal Music Server — GitHub-only / no VPS

Production:

    Device
       |
       v
    Cloudflare Worker
       |
       +--> D1 (playlist, metadata, cache/job state)
       |
       +--> GitHub Actions (on-demand acquisition)
                    |
                    +--> SpotiFLAC (resolved via Apple Music search)
                    +--> YtFLAC/yt-dlp fallback
                    +--> R2 (via an authenticated PUT to the Worker)
       |
       v
    Device playback

Permanent audio lives in Cloudflare R2, bound directly to the Worker (no OAuth
token refresh needed for playback). No VPS, Docker, PostgreSQL or Redis is
required for production.

See `GITHUB_ONLY_SETUP.md`.

The existing Docker/FastAPI implementation is retained only for local/reference
use.

Provider scripts must be configured for the exact SpotiFLAC/YtFLAC versions you
use. Only use sources and downloads you are authorized to access.
