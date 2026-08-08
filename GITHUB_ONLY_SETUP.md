# GitHub-only deployment

Your PC does not need Docker, Node.js, Python, PostgreSQL or Redis.

You can upload this repository to GitHub and use GitHub Actions to deploy the
Cloudflare Worker and run on-demand audio acquisition.

## Required accounts

- GitHub
- Cloudflare
- Google account/Drive
- No VPS

## 1. Put the project on GitHub

Create a repository and upload the project. A private repository is recommended.

Never commit:
- `.env`
- Google refresh tokens
- Cloudflare tokens
- GitHub tokens
- passwords

## 2. Cloudflare secrets

Create a Cloudflare API token with the minimum Workers/D1 permissions required
for this project. Add these GitHub repository secrets:

    CLOUDFLARE_ACCOUNT_ID
    CLOUDFLARE_API_TOKEN

## 3. Bootstrap D1

Open:

    GitHub -> Actions -> Bootstrap Cloudflare -> Run workflow

This creates `music-library`, configures `serverless/wrangler.toml`, and applies
the database schema.

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
    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET
    GOOGLE_REFRESH_TOKEN
    CALLBACK_SECRET

The `GITHUB_TOKEN` only needs enough permission to dispatch the acquisition
workflow in this repository.

## 6. GitHub Actions acquisition secrets

In GitHub:

    Settings -> Secrets and variables -> Actions

Create:

    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET
    GOOGLE_REFRESH_TOKEN
    GOOGLE_DRIVE_ROOT_FOLDER
    CALLBACK_URL
    CALLBACK_SECRET

## 7. Domain

Attach your domain/subdomain in:

    Cloudflare -> Workers & Pages -> your Worker -> Domains & Routes

For example:

    music.example.com

Then the application is available from any device.

## 8. Google OAuth

Use:

    https://music.example.com/api/v1/drive/oauth/callback

as the production OAuth redirect URI.

## 9. Audio flow

    Device
      -> Cloudflare Worker
      -> D1
      -> GitHub workflow_dispatch
      -> SpotiFLAC primary
      -> YtFLAC fallback
      -> Google Drive
      -> callback
      -> D1

The GitHub runner exists only while an acquisition job runs.

## 10. Local requirements

None beyond a browser if you use GitHub's web UI. Git is optional.
