# dakshmusic3

React + FastAPI music library, queue, cache, and acquisition system.

## Active structure

- `frontend-react/` — React/Vite client
- `backend/` — FastAPI application and reusable services/connectors
- `db/` — canonical D1 schema and migrations
- `.github/workflows/ci.yml` — v2-only validation

## Runtime

FastAPI is the application API. D1 is the source of truth for metadata, library, queues, acquisition jobs, cache state, sessions, and imports. R2 stores audio/artwork objects. GitHub Actions executes acquisition jobs.

The repository intentionally contains no legacy JavaScript Worker application, legacy frontend, legacy provider directory, or legacy migration tree.
