# GitHub-only deployment

Your PC does not need Docker, Node.js, Python, PostgreSQL or Redis.

You can upload this repository to GitHub and use GitHub Actions to deploy the
Cloudflare Worker and run on-demand audio acquisition.

## Required accounts

- GitHub
- Cloudflare (with R2 enabled -- free tier is fine)
- No VPS
- No Google account needed

## 1. Put the project on GitHub

Create a repository and upload the project. A private repository is recommended.

Never commit:
- `.env`
- Cloudflare tokens
- GitHub tokens
- passwords

## 2. Cloudflare secrets

Create a Cloudflare API token with the minimum Workers/D1/R2 permissions
required for this project. Add these GitHub repository secrets:

    CLOUDFLARE_ACCOUNT_ID
    CLOUDFLARE_API_TOKEN

## 3. Bootstrap D1 and R2

Open:

    GitHub -> Actions -> Bootstrap Cloudflare -> Run workflow

This creates the D1 database, configures `serverless/wrangler.toml`, and
applies the database schema.

Separately, create the R2 bucket declared in `serverless/wrangler.toml`
(`dakshmusic3-audio` by default) either via the Cloudflare dashboard
(Workers & Pages -> R2) or:

    wrangler r2 bucket create dakshmusic3-audio

If repository branch protection prevents the workflow from committing the D1 ID,
copy the ID from the workflow log into `serverless/wrangler.toml` using GitHub's
web editor, then rerun the workflow.

## 4. Deploy

Open:

    GitHub -> Actions -> Deploy Cloudflare -> Run workflow

After the first successful deployment, pushes to `main` that change `serverless/`
or `frontend/` deploy automatically.

## 5. Worker secrets

In Cloudflare Worker settings, create:

    APP_SECRET
    PASSWORD_HASH
    PASSWORD_SALT
    GITHUB_TOKEN
    GITHUB_OWNER
    GITHUB_REPO
    CALLBACK_SECRET

The `GITHUB_TOKEN` needs Actions (read and write) and Contents (read) or
Workflows (read and write) permission to dispatch the acquisition workflow
in this repository.

## 6. GitHub Actions acquisition secrets

In GitHub:

    Settings -> Secrets and variables -> Actions

Create:

    WORKER_BASE_URL
    CALLBACK_SECRET

`WORKER_BASE_URL` is your Worker's URL, e.g.
`https://dakshmusic3.<your-subdomain>.workers.dev` (no trailing slash).
`CALLBACK_SECRET` must match the same value set as a Worker secret in step 5.

Optionally, also set `YTDLP_COOKIES_B64` (base64-encoded `cookies.txt` from a
logged-in browser session) to reduce YouTube fallback bot-check failures --
see `providers/README.md`.

## 7. Domain

Attach your domain/subdomain in:

    Cloudflare -> Workers & Pages -> your Worker -> Domains & Routes

For example:

    music.example.com

Then the application is available from any device.

## 8. Audio flow

    Device
      -> Cloudflare Worker
      -> D1
      -> GitHub workflow_dispatch
      -> SpotiFLAC primary (resolved via Apple Music search)
      -> YtFLAC fallback
      -> R2 (via an authenticated PUT to the Worker)
      -> D1

The GitHub runner exists only while an acquisition job runs. Audio is
streamed directly from R2 by the Worker on playback -- no OAuth token
refresh involved, unlike the old Google Drive-based flow.

## 9. Local requirements

None beyond a browser if you use GitHub's web UI. Git is optional.
