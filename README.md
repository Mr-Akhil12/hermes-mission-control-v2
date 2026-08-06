# Hermes OS v2 — Mission Control

A PWA that wraps the native Hermes dashboard and adds a personalised operating layer: Daily Brief, Dispatch, Approvals, Cron Monitor (with run history + agent thinking), Chat + Voice (Jarvis mode), and the personal sections (Content Studio, Trading, Dev, Personal). Turso-only data layer, Tailscale remote access, PIN + biometric lock.

## Stack

- Next.js 16 + React 19 + TypeScript + Tailwind v4
- Turso (cloud SQLite) — single data layer: tasks, sync_cache, briefs, artifacts
- Python bridge (`bridge/bridge.py`) — polls task queue, mirrors :9119 state, generates briefs
- Tailscale — private access to the native dashboard embed
- next-themes — light + dark agenticbiz theme

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in Turso + native URLs
npm run dev                  # local dev on :3000
npm run build && npm start   # production
```

## Repo conventions

- **Artifacts**: every produced file → `hermes-dump` (private) or its own repo. The `artifacts` table in Turso stores links.
- **Videos**: every HyperFrames video → `hyperframes` repo, folder per video, render ≤20MB via git LFS.
- **Hourly cron report**: `hourly-cron-report` sweeps all crons, commits uncommitted hermes-dump artifacts, delivers an agent summary.

## License

MIT
