# dakshmusic3

A clean React + FastAPI music library and acquisition system.

## Architecture

- `frontend-react/` — React/Vite client
- `backend/` — FastAPI application
- `db/` — canonical D1 schema and migrations
- `workers/` — acquisition, fill, and deployment workers
- `connectors/` — external provider and Cloudflare integrations
- `services/` — application business logic
- `domain/` — shared domain models
- `configs/` — deployment and runtime configuration
- `tests/` — automated tests

## Production

Cloudflare D1 stores application state and metadata. Cloudflare R2 stores audio and artwork. Acquisition execution is delegated to GitHub Actions workers through the FastAPI acquisition service.

The repository contains no legacy JavaScript Worker application or legacy frontend. The active backend is Python/FastAPI and the active frontend is React.
