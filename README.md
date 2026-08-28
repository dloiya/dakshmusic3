# DakshMusic3

A fresh rebuild focused on a Windows web-controlled local worker.

## Architecture

- **web/** — browser dashboard
- **node/** — local Windows worker API and acquisition runtime
- **coordinator/** — Cloudflare-compatible control plane

The existing Cloudflare resources are intentionally preserved; this commit replaces repository code only.
