# Personal Music Server

FastAPI backend for a personal music player.

## Architecture

- PostgreSQL: playlist, metadata and play counts
- Redis: sessions and download jobs
- Google Drive: permanent audio-library storage
- Server cache: 25 general tracks
- Album cache: 5 active album sessions
- Device cache: client-enforced 10-track window
- Deezer public API: metadata/search; no Spotify Web API/Premium credentials
- Last.fm: Explore recommendations
- Configurable authorized acquisition provider + fallback
- Docker Compose + Caddy + GitHub Actions

## Acquisition flow

    user query
       -> Deezer metadata search
       -> selected canonical Deezer URL
       -> authorized acquisition provider
       -> local audio file
       -> Google Drive permanent library
       -> server cache
       -> device

Current SpotiFLAC releases document Deezer URLs as a supported input type and
headless CLI usage. If you choose to use SpotiFLAC, configure it through the
provider hook and ensure your use of the source/provider is authorized.

The backend does not require Spotify Web API/Premium credentials.

## Setup

    cp .env.example .env
    docker compose up -d postgres redis
    docker compose run --rm api alembic upgrade head
    docker compose run --rm api python -m app.cli.hash_password
    docker compose up -d api worker caddy

Never commit `.env`, OAuth tokens, passwords or audio files.
