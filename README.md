# DakshMusic

Clean architecture: Cloudflare Worker + existing D1/R2 + Oracle acquisition node.

## Architecture

`Web -> Cloudflare Worker -> D1 queue -> Oracle -> MDL / yt-dlp -> FLAC -> R2`

The Oracle server is the only acquisition machine. Browsers never run yt-dlp or FFmpeg.

## Oracle

Install Node.js, yt-dlp, FFmpeg, and npm. Then:

```bash
cd oracle
export DAKSH_API_URL=https://dakshmusic3.dakshhloiya.workers.dev
node worker.js
```

The worker claims queued jobs, tries `npx --yes @mdlx/cli <source> --format flac --no-po-token`, then falls back to `yt-dlp ytsearch1:<artist> - <title>` and uploads the FLAC to R2 through the Cloudflare Worker.

## Existing data

No D1 migration is included. The production D1 database and R2 bucket are treated as authoritative.
