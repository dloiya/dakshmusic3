# dakshmusic3

React + FastAPI music library, queue, cache, and acquisition system.

## Active structure

- `frontend-react/` — React/Vite client
- `backend/` — FastAPI application and reusable services/connectors
- `workers/` — acquisition/fill execution code
- `db/` — canonical D1 schema and migrations
- `configs/` — runtime configuration
- `.github/workflows/ci.yml` — v2-only validation
- `.github/workflows/deploy.yml` — manual production deployment
- `.github/workflows/acquire-audio.yml` — acquisition worker

## Runtime

FastAPI is the application API. D1 is the source of truth for metadata, library, queues, acquisition jobs, cache state, sessions, and imports. R2 stores audio/artwork objects. GitHub Actions executes acquisition jobs.

Cloudflare bindings:

- D1: `dakshmusic3`
- D1 ID: `3f384751-424c-4628-ac18-384c068afd8b`
- R2: `dakshmusic3-audio`

## Required Worker secrets

Set these on the Cloudflare Worker:

- `DAKSH_ADMIN_PASSWORD`
- `DAKSH_GITHUB_TOKEN`
- `DAKSH_WORKER_CALLBACK_SECRET`

The GitHub acquisition workflow also requires repository secrets:

- `CLOUDFLARE_API_TOKEN` — deployment token
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID
- `DAKSH_WORKER_URL` — deployed Worker base URL
- `DAKSH_WORKER_CALLBACK_SECRET` — same value as the Worker secret
- `DAKSH_R2_ENDPOINT` — R2 S3 endpoint
- `DAKSH_R2_ACCESS_KEY_ID` — R2 API token access key
- `DAKSH_R2_SECRET_ACCESS_KEY` — R2 API token secret
- `YTDLP_COOKIES_B64` — optional base64-encoded cookies.txt for YouTube anti-bot challenges

## APIs

All application APIs are under `/api/v1`:

- `/auth`
- `/library`
- `/playlist`
- `/queue`
- `/search`
- `/acquire`
- `/seed`
- `/cache`
- `/status`
- `/crud`
- `/playback`
- `/system/health`

`GET /api/v1/status` is read-only and reports the songs whose acquisition jobs are queued, dispatched, or running.

## Database

The canonical schema contains only:

1. `tracks`
2. `albums`
3. `playlist_entries`
4. `queue_entries`
5. `queue_state`
6. `acquisition_jobs`
7. `cache_objects`
8. `sessions`
9. `import_jobs`

There are no runtime-created tables and no legacy reconciliation schema.

## Deployment

Build and validate locally:

```bash
uv sync --dev
uv run pywrangler dev

cd frontend-react
npm install
npm run build
```

Production deployment is intentionally manual:

```text
GitHub Actions → Deploy dakshmusic3 → apply D1 migrations → pywrangler deploy
```

The repository intentionally contains no legacy JavaScript Worker application, legacy frontend, legacy provider directory, or legacy migration tree.
