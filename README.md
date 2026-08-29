# DakshMusic3

Single Cloudflare Worker deployment containing:

- React/iPod frontend as static assets
- Queue API as Worker routes
- D1 as the persistent state/catalog
- Browser-side Deezer search
- Existing OCI/MDL system as the download executor
- R2 as persistent audio storage

## Architecture

```text
Browser / React
  ├── Search ───────────────► Deezer public search API
  │
  └── Queue / Acquisition ─► this Worker
                                │
                                ▼
                               D1
                                │
                                ▼
                          OCI /acquire
                                │
                                ▼
                               MDL
                                │
                                ▼
                                R2
```

The frontend and Worker are deployed together. `/api/*` is handled by the Worker; all other GET requests are served from the React SPA.

## Local development

Install:

```bash
npm install
```

Run the React UI:

```bash
npm run dev
```

Run the Worker:

```bash
npx wrangler dev
```

For full Worker + assets testing, build then run:

```bash
npm run build
npx wrangler dev
```

## Production / GitHub

1. Put this repository on GitHub.
2. In Cloudflare: Workers & Pages → Create application → Import a repository.
3. Select the repository.
4. Root directory: `/`.
5. Build command: `npm run build` (or leave the Wrangler configuration to supply it).
6. Deploy command: `npx wrangler deploy`.
7. Replace `REPLACE_WITH_EXISTING_D1_DATABASE_ID` in `wrangler.jsonc` with the ID of the existing DakshMusic3 D1 database.
8. Connect the Worker to the repository.

Cloudflare Workers Builds can deploy the Worker automatically on pushes.

Do not put R2/OCI secrets in this repository. Runtime secrets belong in Cloudflare Variables & Secrets.

## Important

`worker/schema.sql` is a reference schema for the current D1 layout. Do not run it against production blindly; the database already exists.

The current Worker implements queue/catalog state. OCI acquisition execution is represented by `acquisition_jobs`; the next integration step is to have the Worker dispatch queued jobs to the OCI `/acquire/{url}` API and update job state.
