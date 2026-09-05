# DakshMusic3 Worker API Contract

Base URL:

`https://<worker-host>`

The Worker has one HTTP API router. `worker/entry.js` is only the Cloudflare runtime entrypoint; API routes are implemented in `worker/router.js`.

All JSON requests must use:

`Content-Type: application/json`

## System

### GET /api/health

Returns Worker/D1 availability.

### POST /api/start

Starts the OCI retriever instance through the Worker-side OCI client.

### POST /api/watchdog

Runs the OCI instance health/recovery check manually. The same check runs from the Worker cron trigger.

## Search

### GET /api/search?q=<query>&limit=25

Searches Deezer and returns the upstream search payload.

## Library

### GET /api/library/tracks?limit=500

Returns the stored track catalog.

### GET /api/library/albums?limit=500

Returns the logical album list derived from tracks.

### GET /api/library/albums/:albumId

Returns an album and its tracks.

### GET /api/albums/history

Returns recently played albums.

## Tracks

### POST /api/tracks/resolve

Upserts a resolved source track into D1 and returns its local track ID.

Request:

```json
{
  "title": "Behold",
  "artist": "JID",
  "album_id": 456,
  "album_name": "The Forever Story",
  "source": "deezer",
  "source_id": "3399059211",
  "source_url": "https://www.deezer.com/track/3399059211",
  "artwork_url": "...",
  "duration_ms": 200000,
  "isrc": null,
  "metadata_json": {}
}
```

If `album_id` is supplied, the parent album is created/updated before the track row, preserving the D1 foreign-key relationship.

## Playlist

### GET /api/playlist

Returns the default playlist.

### POST /api/playlist

Adds an existing track to the default playlist.

### DELETE /api/playlist/:entryId

Removes a playlist entry.

## Playback

### POST /api/playback/mode

Sets playback mode to `track` or `album`.

### POST /api/play/track

Starts playback preparation for a track and dispatches acquisition if the file is not already cached. Acquisition status is not tracked or polled by the Worker API.

### POST /api/play/album/:albumId

Creates the current album queue, records album history, and dispatches acquisition for the album tracks. Acquisition status is not tracked or polled by the Worker API.

## Queue

### GET /api/queue?queue_key=default

Returns queue state and tracks.

### POST /api/queue/add

Adds an already-resolved track to a queue. The queue parent is created automatically when necessary.

### DELETE /api/queue/:entryId

Removes a queue entry.

### POST /api/queue/next

Advances the current queue index.

### POST /api/queue/shuffle

Sets shuffle state.

## Acquisition

### POST /api/acquisition

Dispatches acquisition for a track to the OCI retriever. No acquisition job row is created and there is no status-polling endpoint.

Request:

```json
{
  "track_id": 123,
  "priority": "normal"
}
```

Response is `202 Accepted` when dispatch is queued with `status: "dispatched"`.

## Library import/export

### GET /api/export/tracks.csv

Exports the track catalog as CSV.

### POST /api/import/tracks.csv

Imports track rows from CSV.

### POST /api/data/delete

Deletes library, queue, playlist, and playback-history data after receiving `{ "confirm": "DELETE" }`.

## Error format

All API errors use:

```json
{
  "error": "human readable message"
}
```

HTTP status is authoritative.
