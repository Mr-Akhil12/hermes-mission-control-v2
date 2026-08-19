# Hermes OS v2 — Feature Tracking & Roadmap

**Repo:** `Mr-Akhil12/hermes-mission-control-v2` · **Live:** https://hermes-mission-control-v2.vercel.app
**Started:** 6 Aug 2026 · **Status:** Phase 1 + Phase 2 complete, Phase 3 next · **Sprint:** Wed 19 → Sat 22 Aug (clone-ready + security)

This is the single source of truth for what's built, what broke, what's next, and how desktop vs mobile differ. Every feature, every bug, every decision — tracked here.

---

## 1. Feature-by-Feature Status

Legend: ✅ live · 🟡 partial/demo · ⬜ not started

### Core shell
| Feature | Status | Notes |
|---|---|---|
| Sidebar (desktop, 14 pages) | ✅ | Sticky, glass, active-state highlight |
| Topbar | ✅ | ⌘K palette trigger, theme toggle |
| Command palette (⌘K) | ✅ | Search + navigate all pages |
| Light/dark theme | ✅ | next-themes, agenticbiz palette both modes |
| Mobile bottom nav | ✅ | Scrollable, ALL 14 pages (fixed 6 Aug) |
| Particle background | ✅ | Lightweight canvas, cursor repulsion, connection lines |
| PWA manifest | ✅ | Installable, standalone |
| PIN + biometric auth | ✅ | WebAuthn fingerprint/FaceID + PIN hash (localStorage) |
| Lock now (Settings) | ✅ | Clears unlock token |

### Screens
| Screen | Status | Data source | Notes |
|---|---|---|---|
| Daily Brief (/) | ✅ | Turso briefs + jobs.json | One-thing card, real counts (36 crons / 6 failed / 28 ok), brief history — verified 8 Aug |
| Dispatch (/dispatch) | ✅ | :8642 via proxy + Turso fallback | Real Hermes responses, **queues to Turso when tunnel down**, task queue view |
| Approvals (/approvals) | ✅ | Real Hermes approval system | Run tracker captures `approval.request` (state server watcher), approve once/always/deny via `/v1/runs/{id}/approval`, history — verified 7 Aug |
| Cron Monitor (/crons) | ✅ | Turso + state.db | Run history, thinking viewer, output links |
| Agents (/agents) | ⬜ | — | Stub, Phase 3 (React Flow graph) |
| Sessions (/sessions) | ✅ | state.db | Real transcripts, stop reasons |
| Channels (/channels) | ✅ | gateway_state + channel_directory + delivery_obligations | Real platform states (discord/webhook/api connected, telegram/slack retrying), 35 channels, 30 delivery log — verified 8 Aug |
| Chat + Voice (/chat) | ✅ | ngrok tunnel → :8645 → :8642 | **v2: conversation history, SSE streaming, thinking stream, persisted sessions** — verified 7 Aug |
| Content Studio (/studio) | ✅ | Obsidian vault via state server | Kanban (idea→drafted→approved→scheduled→posted), calendar view, platform filters, status writes back to vault — verified 8 Aug |
| Trading (/trading) | ✅ | Turso (akhils-trading DB) | Net P&L, win rate, profit factor, risk meter, recent trades table — verified 8 Aug |
| Development (/dev) | ✅ | GitHub + artifacts | Artifact search real, **bridge auto-logs repos to Turso every ~2 min** |
| Personal (/personal) | ✅ | Hermes memory + Obsidian vault | Memory wiki (12+13 entries), vault folder grid → note list → full reader — verified 8 Aug |
| Native UI (/native) | ✅ | /native-proxy same-origin + WS via funnel | Full embed: login, dashboard, live WS — verified 7 Aug |
| Settings (/settings) | ✅ | — | Data source status, lock now, **push notifications enable/disable/test** |

### Infrastructure
| Piece | Status | Notes |
|---|---|---|
| Turso data layer | ✅ | tasks/sync_cache/briefs/artifacts tables |
| Bridge (mirror → Turso) | ✅ | **systemd user unit `hermes-os-bridge.service`** (enabled, control-group kill, TERM trap). **Pitfall fixed:** a duplicate SYSTEM-level unit (`/etc/systemd/system/hermes-os-bridge.service`) was respawning orphan wrappers — removed; only the user unit runs |
| State server (:8645) | ✅ | systemd, serves crons/runs/sessions/artifacts + chat proxy |
| Tailscale funnel | ✅ | Permanent HTTPS → :9119; **does WebSocket** (verified cross-origin from Vercel) |
| ngrok tunnel | ✅ | systemd, skip-warning header, **reserved domain** (refract-delicious-nearest.ngrok-free.dev) — permanent URL, survives restarts |
| Vercel deploy | ✅ | Auto-deploy on push |
| Artifact pipeline | ✅ | hyperframes (public) + hermes-dump (private) |
| Hourly cron report | ✅ | Job 7a579ab29e93 |

---

## 2. Bug Log (during build)

| # | Bug | Root cause | Fix | Status |
|---|---|---|---|---|
| 1 | Blank page, shell renders but no content | Next.js 16 `allowedDevOrigins` blocked own JS from 127.0.0.1 | Added origins to next.config.ts | ✅ |
| 2 | Cron Monitor crash "unique key" | jobs.json uses `id`, code read `job_id` → all keys undefined | `cron.job_id ?? cron.id ?? "unknown"` | ✅ |
| 3 | Cron Monitor crash "object as React child" | `schedule` is `{kind,expr,display}` not string | Type guard + display fallback | ✅ |
| 4 | Thinking viewer never shows | `setThinkingFor(null)` in `finally` wiped state before render | Only null on error | ✅ |
| 5 | Native embed blank in iframe | Mixed content: HTTP iframe inside HTTPS page silently blocked | HTTPS proxy via state server `/native/*` | ✅ |
| 13 | Native embed white on mobile | Third-party cookie block: SameSite=Lax session cookies dropped in cross-origin iframe | Same-origin proxy `/native-proxy/*` (server-side fetch + path rewrite + first-party cookies) | ✅ |
| 14 | Chat 502 "Hermes API failed" | Dead condition in route: `DATA_URL && !apiBase.startsWith(...) && apiBase === "127.0.0.1:8642"` — impossible, always fell back to localhost on Vercel | Fixed condition: `DATA_URL && apiBase.startsWith("127.0.0.1") ? DATA_URL : apiBase` (commit 56a1a7e) | ✅ |
| 15 | `NEXT_PUBLIC_DATA_URL` empty in Vercel prod | Env var existed but value was `""` — chat had nothing to route through even after fix | Set to permanent ngrok URL, redeployed — chat verified "OK — I can hear you" | ✅ |
| 16 | Embed live features (events/WS) dead | SPA builds WS URL from `window.location.host` = Vercel origin (no WS on serverless) | Proxy rewrites host to funnel `akhils-pc.tail6d629e.ts.net` — WS verified cross-origin (gateway.ready received) | ✅ |
| 17 | Chat buffered, no history | State server `resp.read()` buffered full response; chat page had no session persistence | Chunked SSE proxy in state server + Vercel stream routes + session endpoints (create/list/messages) | ✅ |
| 6 | Turso 400 Bad Request | v2 API needs `requests` not `statements` + typed args | Rewrote client with `_typed_args` | ✅ |
| 7 | Production still "remote" not "turso" | `TURSO_URL` set to `libsql://` scheme, fetch needs `https://` | Fixed env var | ✅ |
| 8 | ngrok browser warning interstitial | Free-tier interstitial page | `--request-header-add ngrok-skip-browser-warning: true` | ✅ |
| 9 | ngrok URL collision (ERR_NGROK_334) | Old 8642 tunnel (user systemd service) held the URL | Updated `hermes-ngrok.service` → 8645 + header | ✅ |
| 10 | Mobile nav only 5 of 14 pages | Hardcoded `[NAV[0],NAV[3],NAV[7],NAV[12],NAV[13]]` | Scrollable nav, all pages | ✅ |
| 11 | Turso tokens expired | Cached tokens past expiry | Re-auth via fresh token | ✅ |
| 12 | Vercel env pull returned empty strings | CLI quirk on sensitive vars | Used Vercel API + direct env add | ✅ |

---

## 3. Desktop vs Mobile — Views & Decisions

### Desktop (md+)
- **Navigation:** full 60-width sidebar, all 14 pages, sticky
- **Command palette:** ⌘K, quick dispatch bar in topbar
- **Layout:** multi-column grids (2-4 cols), full tables
- **Native embed:** full-bleed iframe, side-by-side with shell

### Mobile (below md)
- **Navigation:** bottom nav bar — **scrollable, all 14 pages** (decision: no hamburger, swipe-able row beats hidden menu)
- **Command palette:** hidden (no ⌘K on touch) — Dispatch page is the entry
- **Layout:** single column, cards stack, attention queue first
- **Native embed:** full-screen iframe, works via Tailscale/LAN or HTTPS proxy
- **Auth:** biometric (fingerprint/FaceID) is the primary unlock — PIN fallback
- **PWA:** installable, standalone, offline shows crime-scene tape

### Decisions locked
- Mobile priorities: **responsiveness > theme > UI** — functionality identical to desktop
- No feature is desktop-only; everything reachable on phone
- Offline: view-only cached data + crime-scene tape (not full offline editing)

---

## 4. Full Roadmap — Feature by Feature

### Phase 1 — Foundation (✅ complete)
- [x] Repos: hyperframes (public) + hermes-dump (private)
- [x] git LFS + ≤20MB render rule
- [x] Turso single data layer (tables created)
- [x] Bridge + state server systemd-managed
- [x] ngrok tunnel systemd-managed, skip-warning
- [x] PWA shell (sidebar, topbar, palette, themes)
- [x] PIN + biometric auth
- [x] Native embed (whole UI) + offline tape
- [x] Core screens: Brief, Dispatch, Crons, Sessions, Channels, Settings
- [x] Cron Monitor: run history + thinking viewer + output links
- [x] Chat + Voice (Jarvis)
- [x] Deploy to Vercel + auto-deploy on push

### Phase 2 — Personal sections + real data everywhere (✅ complete 8 Aug)
- [x] **Turso token-expiry watchdog** — **REPLACED with never-expiring tokens** (7 Aug): minted `--expiration never` tokens for dashboard + budget app, updated secrets.md + Vercel envs + Bitwarden. No watchdog needed — tokens never expire.
- [x] **Approvals real** — state-server run tracker captures `approval.request` SSE events into `~/.hermes/approvals.json`; dispatch switched to `/v1/runs`; approve once/always/deny wired to `/v1/runs/{id}/approval`; 15s auto-refresh + history
- [x] **Content Studio** — kanban + calendar from Obsidian vault (153 pieces, status writes back to frontmatter) — verified 8 Aug
- [x] **Trading** — Turso trades/strategy read, net P&L, win rate, profit factor, risk meter — verified 8 Aug
- [x] **Personal** — memory wiki (MEMORY.md/USER.md entries) + Obsidian vault browser (folders → notes → reader) — verified 8 Aug
- [x] **Daily Brief generation cron** — hermes-os-daily-brief at 06:00 SAST; hero shows one-thing + real brief history — verified 8 Aug
- [x] **Channels real** — gateway_state.json platforms, channel directory (35), delivery_obligations log — verified 8 Aug
- [x] **Dispatch queue** — dispatch falls back to Turso `tasks` when tunnel down; bridge polls every 30s; queue view on Dispatch page — verified 8 Aug
- [x] **Artifacts auto-log** — bridge scans ~/repos/hermes-dump + hyperframes every ~2 min, inserts new files into Turso artifacts (dedup by URL) — verified 8 Aug

### Phase 3 — Agents + polish (next)
- [ ] **Agents live graph** — React Flow, subagent spawns, activity feed
- [ ] **Subagent chat** — dispatch to SOL/LUNA/DEEPSEEK profiles
- [x] **Push notifications** — Web Push (VAPID + SW), approvals + failed crons ping phone, Settings enable/disable/test — verified 8 Aug
- [ ] **Open-source release** — redaction pass, docs, MIT
- [ ] **PWA offline polish** — install prompts, offline shell
- [ ] **Performance pass** — bundle size, image optimization, lazy routes

### Phase 4 — Powerhouse (the upgrade loop)
- [ ] **Voice-first mode** — full Jarvis: wake word, continuous listening
- [x] **AI daily brief** — Hermes writes the morning brief, not template (13 Aug): cron agent gathers real state (cron health, approvals, git log, content), composes a chief-of-staff brief (one_thing + attention + shipped + next_actions), persists via `bridge.py brief-write` → Turso `briefs`. Verified live: today's brief caught copy-trade-daily-scan never-run + content shipped. Also removed 4 dead twp-deadline-*-aug2 one-shot jobs → cron health 36 jobs / 0 errors.
- [ ] **Predictive alerts** — "cron X will fail" from drift patterns
- [ ] **Trading automation hooks** — strategy signals → alerts (never auto-trade)
- [ ] **Content pipeline AI** — draft → approve → schedule → post loop
- [ ] **Memory wiki** — browse/edit Hermes memory from the dashboard
- [ ] **Multi-device sync** — phone + PC + Mac mini (Tailscale mesh)
- [ ] **Cost dashboard** — token spend per cron/session
- [ ] **Skill health** — curator data, stale skill alerts
- [ ] **CodeGraph integration** — hyperframes repo indexed, impact analysis

### Phase 5 — Consistent upgrading (the loop)
- [ ] Monthly: new screens from real usage (what Akhil actually opens)
- [ ] Quarterly: performance + security audit
- [ ] Every release: bug log reviewed, lessons folded into skills
- [ ] The rule: every feature must pass the 4-question card test or it gets cut

---

## 5. Sprint — Wed Aug 19 → Sat Aug 22 (clone-ready + security)

**Goal:** a dashboard someone can clone, run, and trust. Security closed, stubs real, every page ≥80%.

**Where we are (audit 18 Aug):** 10/14 pages already ≥80% (Home 90, Approvals 90, Dispatch 88, Channels 88, Trading 88, Personal 88, Studio 85, Crons 85, Settings 85, Native 80). Broken: Agents 15 (pure stub), Dev 30 (hardcoded, never calls working `/api/artifacts`), Chat 60 (two 404 dangling fetches), Sessions 70 (dead Resume). Plus zero server-side auth, bridge open on `0.0.0.0:8645` with CORS `*`, PIN in client bundle.

### Wed Aug 19 — Security foundation (the heavy lift)
- [ ] Server session auth: login route, HttpOnly cookie, middleware gate on API routes
- [ ] `STATE_BRIDGE_TOKEN` on the bridge; bind `127.0.0.1`; kill CORS `*`
- [ ] PIN → Vercel secret (`AUTH_PIN_HASH`), server-side verify, no hardcoded fallback, no comments, history scrubbed
- [ ] Rate limiting + security headers (CSP, X-Content-Type-Options, Referrer-Policy)
- [ ] Verify every existing flow still works through the new auth (chat, approvals, push, dispatch)

### Thu Aug 20 — Security completion + chat fixes
- [ ] Tests: unauthenticated rejection, authenticated access, bridge token accept/reject
- [ ] Fix the two 404s: add `/api/chat/sessions/{id}/fork` + `/model` routes (slash commands start working)
- [ ] Config normalization: single source for `deepseek-v4-flash:0731`, reconcile `.env.example`
- [ ] Start chat god-file extraction (session state → hook, stream state → hook)

### Fri Aug 21 — Make the stubs real
- [ ] `/agents` live: real agent state from the Hermes API (sessions, model, status) — kills the 15/100
- [ ] `/dev` real: wire `/api/artifacts` (5-min fix, biggest bang) + git status via GitHub API + deployments via Vercel REST API — kills the 30/100
- [ ] `/sessions` Resume button wired + `/crons` Output link fixed
- [ ] Mobile pass on `/native` (relax fixed heights for small phones)

### Sat Aug 22 — Clone-ready polish + ship
- [ ] Dead buttons cleanup (studio/channels/approvals), offline SW fetch handler
- [ ] README + docs + ROADMAP rewrite (what's done, how to run, env vars)
- [ ] `lint` + `typecheck` + `build` clean, fix anything that breaks
- [ ] Deploy to Vercel, verify live end-to-end (login, chat, approvals, push)
- [ ] Handoff: clone-ready dashboard, security closed, stubs real

---

## 6. How to update this file

- **After every build session:** mark features done, log new bugs, note decisions
- **Bug log:** add row with root cause + fix — never delete, it's the lesson record
- **Roadmap:** check off items as they land; add new ideas to the right phase
- Commit to `hermes-mission-control-v2/ROADMAP.md` + mirror to `hermes-dump/2026-08-06/`
