# No-VPS deployment

Production deployment uses:

- Cloudflare Workers Free: public API + static frontend hosting
- Cloudflare D1 Free: playlist/metadata/jobs database
- Cloudflare R2 Free: permanent audio storage (bound directly to the Worker)
- Cloudflare Queues is not required; GitHub Actions is used as the on-demand audio worker
- GitHub Actions: on-demand SpotiFLAC/YtFLAC acquisition

Cloudflare's current Workers Free plan includes D1, and D1 Free currently allows
up to 500 MB per database, 5 million row reads/day and 100,000 row writes/day.
R2's free tier includes 10 GB of storage with no egress fees. GitHub Actions
standard hosted runners are free for public repositories.

The audio acquisition workflow is intentionally separate. The Worker only dispatches
a job; the GitHub runner performs acquisition and PUTs the result directly to the
Worker's authenticated upload endpoint, which streams it into R2 and updates D1
in the same request.

## Flow

    device
      -> Cloudflare Worker
      -> D1
      -> GitHub workflow_dispatch
      -> SpotiFLAC (resolved via Apple Music search)
      -> YtFLAC fallback
      -> R2 (via an authenticated PUT to the Worker)
      -> D1
      -> device

The worker streams audio directly from R2 on playback -- no OAuth token
refresh, unlike the old Google Drive-based flow.

## Cloudflare setup

Install Wrangler:

    npm install

Authenticate:

    npx wrangler login

Create the D1 database:

    npx wrangler d1 create dakshmusic3

Copy the returned database_id into wrangler.toml.

Create the R2 bucket:

    npx wrangler r2 bucket create dakshmusic3-audio

Apply schema:

    npx wrangler d1 execute dakshmusic3 --remote --file=./serverless/schema.sql

Set secrets:

    npx wrangler secret put APP_SECRET
    npx wrangler secret put PASSWORD_HASH
    npx wrangler secret put PASSWORD_SALT
    npx wrangler secret put GITHUB_TOKEN
    npx wrangler secret put CALLBACK_SECRET

`GITHUB_OWNER`/`GITHUB_REPO` are declared in `wrangler.toml`'s `[vars]` block
directly rather than as secrets, since they're not sensitive and this avoids
them being wiped by plaintext-var overwrite on the next `wrangler deploy`.

Deploy:

    npx wrangler deploy

## GitHub secrets

The repository running the acquisition workflow needs:

    WORKER_BASE_URL
    CALLBACK_SECRET
    YTDLP_COOKIES_B64   (optional, reduces YouTube fallback bot-check failures)

`WORKER_BASE_URL` is your deployed Worker's URL (no trailing slash), e.g.
`https://dakshmusic3.<your-subdomain>.workers.dev`. `CALLBACK_SECRET` must
match the same value set as a Worker secret above.

## Password

Generate a PBKDF2 password hash:

    node serverless/scripts/make-password.mjs "your-password"

Set the resulting `PASSWORD_SALT` and `PASSWORD_HASH` as Worker secrets.

## Important

Do not put GitHub tokens or passwords into the repository.
Use Cloudflare Worker secrets and GitHub Actions secrets.

This design is on-demand: the API remains available through Cloudflare, while the
audio worker runs only when a song/album needs acquisition.
