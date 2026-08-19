# Hermes OS v2 — Mission Control

A PWA that wraps the native Hermes dashboard and adds a personalised operating layer: Daily Brief, Dispatch, Approvals, Cron Monitor (with run history + agent thinking), Chat + Voice (Jarvis mode), and the personal sections (Content Studio, Trading, Dev, Personal). Turso-only data layer, Tailscale remote access, PIN + biometric lock.

## Stack

- Next.js 16 + React 19 + TypeScript + Tailwind v4
- Turso (cloud SQLite) — single data layer: tasks, sync_cache, briefs, artifacts
- Python bridge (`bridge/bridge.py`) — polls task queue, mirrors :9119 state, generates briefs
- Python state server (`bridge/state_server.py`, :8645) — proxies to the Hermes API + native dashboard, serves crons/runs/sessions/push
- Tailscale — private access to the native dashboard embed
- next-themes — light + dark agenticbiz theme

## Architecture

```
Vercel (Next.js PWA) ──> /api/* (gated by proxy.ts, HttpOnly session cookie)
        │
        ├── Turso (cloud SQLite — durable layer)
        └── State server (:8645, STATE_BRIDGE_TOKEN, binds 127.0.0.1)
                └── Hermes API (:8642) + native dashboard (:9119)
```

- **Auth**: PIN (SHA-256 hash, server-side, `AUTH_PIN_HASH` env) + WebAuthn biometrics. All `/api/*` routes gated by `src/proxy.ts` (HMAC-signed HttpOnly session cookie, rate-limited login).
- **Security**: security headers (CSP, nosniff, referrer, frame), bridge binds localhost only, CORS locked to `ALLOWED_ORIGIN`.

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in all vars — see below
npm run dev                  # local dev on :3000
npm run build && npm start   # production
```

## Environment variables

| Var | Purpose | Required |
|---|---|---|
| `TURSO_URL` / `TURSO_TOKEN` | Turso cloud SQLite | Yes (data layer) |
| `NEXT_PUBLIC_DATA_URL` | Public URL of the state server (ngrok) | Yes (chat/approvals/dispatch) |
| `STATE_BRIDGE_TOKEN` | Bearer token the state server requires | Yes (must match bridge env) |
| `AUTH_PIN_HASH` | SHA-256 of `hermes-os:<pin>:v1` — the unlock PIN | Yes |
| `AUTH_SESSION_SECRET` | HMAC secret for session cookies | Yes |
| `ALLOWED_ORIGIN` | CORS origin for the state server | Yes |
| `GITHUB_TOKEN` | PAT with `repo` scope (dev workspace) | For /dev |
| `VERCEL_TOKEN` | Vercel API token (dev workspace deployments) | For /dev |
| `HERMES_API_URL` / `HERMES_API_MODEL` | Local Hermes API + model | Local dev |
| `NEXT_PUBLIC_NATIVE_URL` / `NEXT_PUBLIC_FUNNEL_URL` | Native dashboard URLs | Local dev |
| `NATIVE_URL` | State server → native dashboard proxy | Bridge host |

Never commit real values. Generate secrets with `openssl rand -hex 32`.

## Scripts

- `scripts/auth-test.sh` — 12-check auth/security suite against a live deployment. Run: `AUTH_PIN=<your pin> ./scripts/auth-test.sh`

## Repo conventions

- **Artifacts**: every produced file → `hermes-dump` (private) or its own repo. The `artifacts` table in Turso stores links.
- **Videos**: every HyperFrames video → `hyperframes` repo, folder per video, render ≤20MB via git LFS.
- **Hourly cron report**: `hourly-cron-report` sweeps all crons, commits uncommitted hermes-dump artifacts, delivers an agent summary.

## License

MIT
