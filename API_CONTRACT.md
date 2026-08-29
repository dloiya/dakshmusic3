# DakshMusic3 Worker API Contract

Base URL:

`https://<worker-host>`

All JSON requests must use:

`Content-Type: application/json`

## GET /api/health

Returns Worker/D1 availability.

Response:

```json
{
  "ok": true,
  "service": "dakshmusic3-queue"
}
```

## GET /api/queue?queue_key=default

Returns the current queue.

Response:

```json
{
  "queue_key": "default",
  "state": {
    "current_index": 0,
    "mode": "playlist",
    "shuffle_enabled": 1
  },
  "tracks": [
    {
      "queue_entry_id": 1,
      "position": 0,
      "id": 123,
      "title": "Behold",
      "artist": "JID",
      "album_id": 456,
      "album_name": "The Forever Story",
      "source": "deezer",
      "source_id": "3399059211",
      "source_url": "https://www.deezer.com/track/3399059211",
      "artwork_url": "...",
      "duration_ms": 200000,
      "storage_key": "music/...",
      "storage_status": "ready"
    }
  ]
}
```

## POST /api/queue/initialize

Creates a queue if one does not already exist.

The initial playlist queue is 20 entries:

- 5 random tracks from the logical Top Cache
- 15 random tracks from the track catalog

The implementation deliberately avoids duplicating a track inside the queue.

Request:

```json
{
  "queue_key": "default"
}
```

Response:

```json
{
  "queue_key": "default",
  "created": true,
  "count": 20
}
```

If a queue already exists:

```json
{
  "queue_key": "default",
  "created": false,
  "count": 20
}
```

## POST /api/queue/add

Adds an already-resolved Deezer result to D1 and the queue.

Request:

```json
{
  "queue_key": "default",
  "track": {
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
}
```

Response:

```json
{
  "ok": true,
  "track_id": 123,
  "queue_entry_id": 99,
  "position": 20
}
```

## DELETE /api/queue/:entryId

Removes a queue entry.

Response:

```json
{
  "ok": true
}
```

## POST /api/queue/next

Advances the current index.

Request:

```json
{
  "queue_key": "default"
}
```

Response:

```json
{
  "ok": true,
  "current_index": 1
}
```

## POST /api/queue/shuffle

Toggles or sets shuffle state.

Request:

```json
{
  "queue_key": "default",
  "enabled": true
}
```

## GET /api/acquisition?limit=20

Returns recent acquisition jobs from D1.

## POST /api/acquisition

Creates an acquisition job for a track.

Request:

```json
{
  "track_id": 123
}
```

The Worker records the job. OCI acquisition orchestration is intentionally separated from queue state; wire `OCI_API_URL` in the Worker environment when the executor is enabled.

## Error format

All API errors use:

```json
{
  "error": "human readable message"
}
```

HTTP status is authoritative.
