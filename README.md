# dakshmusic3 v2

Ground-up rebuild of the personal music server.

## Architecture

```text
React UI
   |
   v
FastAPI API
   |
   +--> services
   |      +--> acquisition
   |      +--> queue
   |      +--> cache
   |      +--> library
   |      +--> system
   |
   +--> connectors
          +--> Cloudflare D1
          +--> Cloudflare R2
          +--> Deezer / MusicBrainz
          +--> GitHub Actions
          +--> SpotiFLAC / YTFLAC workers
```

The new backend lives under `backend/`, the React application under `frontend-react/`, and the canonical D1 schema under `db/`.

## API

The v2 API is versioned under `/api/v1` and will expose auth, library, playlist, queue, search, acquisition, seed, cache, status, and CRUD operations.

`GET /api/v1/status` is read-only and reports songs currently in `queued`, `dispatched`, or `running` acquisition states.

## Database

The clean D1 schema contains only the canonical v2 tables:

- `tracks`
- `albums`
- `playlist_entries`
- `queue_entries`
- `queue_state`
- `acquisition_jobs`
- `cache_objects`
- `sessions`
- `import_jobs`

Device cache remains local to the browser. Audio and artwork objects live in R2; D1 stores their canonical `storage_key` values.

## Development

Backend:

```bash
cd backend
python -m venv .venv
# activate the environment
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd frontend-react
npm install
npm run dev
```

Set the `DAKSH_*` environment variables before using the FastAPI D1/R2 connectors.

The old JavaScript Worker/frontend remains in the repository temporarily as a migration reference. It is not the v2 application architecture and will be removed after feature parity and cutover tests pass.

Only use sources and downloads you are authorized to access.
