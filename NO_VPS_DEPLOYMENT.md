# No-VPS deployment for the music server

The production path is now serverless:

1. Cloudflare Workers + D1 for API/database.
2. GitHub Actions for on-demand acquisition.
3. Cloudflare R2 for permanent audio storage.
4. Your frontend can be served as Worker static assets.
5. No Docker/VPS is required for production.

The old Docker/FastAPI stack remains in the repository for local development.

## Why

Cloudflare Workers Free currently includes D1 and 100,000 D1 row writes/day,
5 million reads/day and 500 MB per database. R2 has a free tier (10 GB
storage, no egress fees) and is bound directly to the Worker, so playback
doesn't need any OAuth token refresh. GitHub Actions standard runners are
free for public repositories. This is suitable for a personal metadata
database and occasional acquisition jobs.

## Setup

From `serverless/`:

    npm install
    npx wrangler login
    npx wrangler d1 create dakshmusic3
    npx wrangler r2 bucket create dakshmusic3-audio

Put the returned D1 ID into `wrangler.toml`, then:

    npx wrangler d1 execute dakshmusic3 --remote --file=./schema.sql

Create password:

    node scripts/make-password.mjs "your-password"

Set secrets:

    npx wrangler secret put PASSWORD_SALT
    npx wrangler secret put PASSWORD_HASH
    npx wrangler secret put APP_SECRET
    npx wrangler secret put GITHUB_TOKEN
    npx wrangler secret put CALLBACK_SECRET

`GITHUB_OWNER`/`GITHUB_REPO` are declared directly in `wrangler.toml`'s
`[vars]` block (not sensitive, so no need for a secret + they'd otherwise
get wiped by plaintext-var overwrite on the next deploy).

After deployment, set GitHub Actions secrets:

    WORKER_BASE_URL
    CALLBACK_SECRET

Then deploy:

    npx wrangler deploy

## GitHub token

Create a fine-grained token that can write Actions for this repository. The Worker
uses it only to dispatch `.github/workflows/acquire-audio.yml`. GitHub documents
workflow dispatch through its REST API.

## Provider wrappers

`providers/primary.sh` and `providers/fallback.sh` are intentionally placeholders.
Wire them to the exact SpotiFLAC and YtFLAC CLI interfaces you use. They must create
`$AUDIO_OUTPUT` and exit 0 on success.

Do not commit provider credentials.
