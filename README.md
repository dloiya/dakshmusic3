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
                    +--> SpotiFLAC
                    +--> YtFLAC/yt-dlp fallback
                    +--> Google Drive
       |
       v
    Device playback

Permanent audio lives in Google Drive. No VPS, Docker, PostgreSQL or Redis is
required for production.

See `GITHUB_ONLY_SETUP.md`.

The existing Docker/FastAPI implementation is retained only for local/reference
use.

Provider scripts must be configured for the exact SpotiFLAC/YtFLAC versions you
use. Only use sources and downloads you are authorized to access.
