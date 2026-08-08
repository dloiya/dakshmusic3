# No-VPS deployment

Production deployment uses:

- Cloudflare Workers Free: public API + static frontend hosting
- Cloudflare D1 Free: playlist/metadata/jobs database
- Cloudflare Queues is not required; GitHub Actions is used as the on-demand audio worker
- Google Drive: permanent audio library
- GitHub Actions: on-demand SpotiFLAC/YtFLAC acquisition

Cloudflare's current Workers Free plan includes D1, and D1 Free currently allows
up to 500 MB per database, 5 million row reads/day and 100,000 row writes/day.
GitHub Actions standard hosted runners are free for public repositories.

The audio acquisition workflow is intentionally separate. The Worker only dispatches
a job; the GitHub runner performs acquisition, uploads the result to Google Drive,
and updates D1 through a protected callback.

## Flow

    device
      -> Cloudflare Worker
      -> D1
      -> GitHub workflow_dispatch
      -> SpotiFLAC
      -> YtFLAC fallback
      -> Google Drive
      -> callback Worker
      -> D1
      -> device

The worker never stores permanent audio locally.

## Cloudflare setup

Install Wrangler:

    npm install

Authenticate:

    npx wrangler login

Create the D1 database:

    npx wrangler d1 create music-library

Copy the returned database_id into wrangler.toml.

Apply schema:

    npx wrangler d1 execute music-library --remote --file=./serverless/schema.sql

Set secrets:

    npx wrangler secret put APP_SECRET
    npx wrangler secret put PASSWORD_HASH
    npx wrangler secret put PASSWORD_SALT
    npx wrangler secret put GITHUB_TOKEN
    npx wrangler secret put GITHUB_OWNER
    npx wrangler secret put GITHUB_REPO
    npx wrangler secret put GOOGLE_CLIENT_ID
    npx wrangler secret put GOOGLE_CLIENT_SECRET
    npx wrangler secret put GOOGLE_REFRESH_TOKEN

Deploy:

    npx wrangler deploy

## GitHub secrets

The repository running the acquisition workflow needs:

    DEEZER_USER_AGENT
    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET
    GOOGLE_REFRESH_TOKEN
    GOOGLE_DRIVE_ROOT_FOLDER
    CALLBACK_URL
    CALLBACK_SECRET

The callback URL is the deployed Worker URL plus:

    /api/v1/jobs/callback

## Password

Generate a PBKDF2 password hash:

    node serverless/scripts/make-password.mjs "your-password"

Set the resulting `PASSWORD_SALT` and `PASSWORD_HASH` as Worker secrets.

## Important

Do not put GitHub tokens, Google refresh tokens, or passwords into the repository.
Use Cloudflare Worker secrets and GitHub Actions secrets.

This design is on-demand: the API remains available through Cloudflare, while the
audio worker runs only when a song/album needs acquisition.
