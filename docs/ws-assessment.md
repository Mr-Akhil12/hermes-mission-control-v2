# Chat Streaming: WebSocket Fit Assessment

**Scope:** `hermes-mission-control-v2` chat page vs. real-time WebSockets.
**Grounding:** code-inspected across every hop (client → Vercel → ngrok → state server :8645 → Hermes API :8642, plus Tailscale funnel :9119).
**Bottom line up front:** A WebSocket channel is *feasible* and would shave a small, real amount of per-frame latency and proxy-buffer jitter — but it is **NOT the lever for the loading-state problems the team has been fighting.** Those are transport-independent rendering/state bugs, most already mitigated by shipped fixes. The decisive blocker is that **Vercel serverless functions cannot terminate a WebSocket upgrade**, so a browser↔WS path would have to bypass Vercel entirely and expose the local tunnel directly to the browser — a security and caching regression. Keep SSE.

---

## 1. Exact current data path for chat streaming

### Send path (client → server, one POST)

```
browser
  └─ send()                      src/app/chat/page.tsx  (fetch POST)
      POST /api/chat/sessions/{id}/stream  {message, model, profile}
      ├─ Vercel serverless       src/app/api/chat/sessions/[id]/stream/route.ts
      │   └─ bridgeFetch()       src/lib/bridge.ts  → apiBase() = NEXT_PUBLIC_DATA_URL (ngrok) or 127.0.0.1:8645
      │       adds "Authorization: Bearer STATE_BRIDGE_TOKEN"   (token NEVER leaves the serverless fn)
      │       reads upstream.body.getReader() → re-enqueues into a ReadableStream
      ├─ ngrok tunnel            refract-delicious-nearest.ngrok-free.dev  → 127.0.0.1:8645
      ├─ state server :8645      bridge/state_server.py  do_POST → _proxy_api_stream(stream=True)
      │       (http.server ThreadingHTTPServer; auth via STATE_BRIDGE_TOKEN; CORS check)
      │       urllib.request.urlopen(req, timeout=15) → resp.read1(4096) flush-loop + ": keepalive" on socket timeout
      └─ Hermes API :8642        gateway/platforms/api_server.py  POST /api/sessions/{id}/chat/stream
              _handle_session_chat_stream → _run_and_signal() → SSE frames back out
```

### Stream return path (server → client, SSE)

```
Hermes API :8642  _handle_session_chat_stream
   emit _sse_frame(payload, event=name) — event type on the "event:" line, payload has seq/ts/session_id/run_id
   keepalive every CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS (30s)
   └─ state server :8645  _proxy_api_stream: read1(4096) → wfile.write/flush (chunked, no Content-Length)
   └─ ngrok tunnel
   └─ Vercel stream/route.ts  pipes bytes through unchanged (headers: text/event-stream, Cache-Control no-cache no-transform, X-Accel-Buffering no)
   └─ browser send()  fetch reader → decoder → split("\n\n") → parse "event:"/"data:" lines
```

### Reattach path (`leave and come back` / device switch)

```
browser  reattachRun(sessionId)      src/app/chat/page.tsx
   GET /api/chat/sessions/{id}/events?since=<lastSeqState[sessionId]>
   → Vercel events/route.ts → ngrok → state server :8645 _proxy_api_get_stream
   → Hermes API :8642  GET /api/sessions/{id}/events?since=N
       replays every persisted event with seq>N from in-memory _session_events (cap 8000), then tails live
   → browser parses, restores live state from moduleLive (module-scope), sets busy only after 1st real frame
```

### Side channels (not part of the token stream)

- **Session list poll:** `setInterval(loadSessions, 15_000)` → Vercel → state server local DB (`load_sessions` reads `~/.hermes/state.db`). HTTP GET, 15s cadence.
- **Slash/steer/stop control:** `POST /api/chat/command` → state server `_exec_full_command` → `ws_bridge.get_bridge()` → **outbound** JSON-RPC WS to native dashboard `ws://127.0.0.1:9119/api/ws` (`slash.exec`/`command.dispatch`). This is the *only* WebSocket today, and it's a **client** (state_server→:9119), not a server.

---

## 2. Where a WebSocket channel would naturally live

The two candidate insertion points:

1. **Client ↔ state server :8645 (via ngrok or Tailscale funnel).** This is the *only* place a WS can reach the laptop without a serverless-function WS upgrade. It would replace BOTH the `stream/route.ts` proxy AND the `events/route.ts` reattach proxy with one persistent duplex socket. Control (steer/stop) could ride the same socket, eliminating the separate `POST /api/chat/command` round-trips.

2. **State server ↔ Hermes API :8642.** Replace the `urllib` HTTP GET/read1 loop with a WS client. This hop is fully under our control and trivially supports WS (aiohttp on :8642, `websockets` lib on :8645). But replacing it gains little — the API already streams SSE fine; the buffering pain is at the *public* proxies, not on loopback.

**The natural architecture if you insisted on WS:** browser ⇄ *ngrok-or-Tailscale* ⇄ state_server(:8645, adds WS listener) ⇄ ws client ⇄ Hermes API(:8642, adds WS handler). The browser must connect **directly to the tunnel**, because Vercel can't upgrade the socket.

---

## 3. What each hop must change to support WS

| Hop | Today | To support WS | Effort | Blocker? |
|---|---|---|---|---|
| **Browser** | `fetch` SSE reader + manual `\n\n` split | `new WebSocket("wss://<tunnel>/api/ws")`; JSON frames; seq-based replay on reconnect | Medium (rewrite send()/reattachRun read loops) | none |
| **Vercel serverless** (`stream`/`events` route.ts) | HTTP proxy → SSE | **Cannot terminate a WS upgrade on a serverless fn.** Would be dropped entirely from the chat data path | — | **YES — hard blocker** |
| **ngrok tunnel** | HTTP, skip-warning header | Supports WS passthrough over HTTP tunnels (needs verifying on free tier; keep `ngrok-skip-browser-warning`). No change needed if it passes `Upgrade` headers. | Low (verify) | low risk |
| **Tailscale funnel** :9119 | HTTP(S), **verified WS** | Already passes WS. Not used by chat today (only native iframe) — a viable fallback tunnel. | Low | none |
| **State server :8645** | `ThreadingHTTPServer` (http.server) — **no WS support** | Add a WS listener (aiohttp or `websockets` lib, v15.0.1 present in venv) on a separate port/route; do_GET/do_POST stay for all other REST. Auth token moves into the WS handshake (sec-websocket-protocol or query) — but the token then lives in the **client bundle** if browser connects directly. | High — biggest single change | auth/security |
| **Hermes API :8642** | aiohttp `web.Application`; SSE handlers `_handle_session_chat_stream` / `_handle_session_events` | Add `GET /api/sessions/{id}/ws` → `web.WebSocketResponse`; reuse the existing `_event_payload`/`_enqueue` → `_session_events` machinery and the waiter fan-out (`_session_event_waiters`). aiohttp WS is native and trivial. Route goes in `_http_route_table()` (line ~2093) + the `/p/<profile>` mirror loop. | Medium | none |
| **next.config.ts CSP** | `connect-src 'self' wss: https:` (already allows `wss:`) | Already permits `wss://<tunnel>`. No change needed. | none | — |

**Security regression to flag:** Today the `STATE_BRIDGE_TOKEN` and `API_SERVER_KEY` are read only inside the Vercel serverless fn. If the browser connects WS directly to ngrok/:8645, that bearer token must ship to the client — exposing the tunnel auth in the JS bundle. You'd need a separate short-lived WS ticket (like the native dashboard's `ws-ticket` flow in `ws_bridge.py`) minted by a serverless route. Non-trivial.

---

## 4. Event contract: WS vs SSE

The SSE contract is defined at `api_server.py:3944` (`_event_payload`) and mirrored in `src/lib/chat-types.ts` (`StreamEvent`). **The payloads are transport-agnostic** — the only transport coupling is (a) the event type riding the SSE `event:` line, and (b) the `seq` counter used for reattach replay.

**SSE (current):**
```
event: assistant.delta
data: {"session_id":"…","run_id":"…","seq":12,"ts":…,"message_id":"…","delta":"Hi"}
```
Client reconstructs the type with `if (!payload.event) payload = {..., event}` because the API puts it in `event:` not the JSON.

**WS (would carry the exact same JSON, framed as text):**
```
{"jsonrpc":"2.0","method":"event","params":{"event":"assistant.delta","session_id":"…","run_id":"…","seq":12,"delta":"Hi"}}
```
Or flat: `{"event":"assistant.delta","seq":12,"delta":"Hi"}`. The full event set is **identical** — `run.started, message.started, assistant.delta, tool.progress(_thinking), tool.started/completed/failed, assistant.completed, run.completed, done, error` — because both transports should emit from the same `_enqueue`/`_session_events` core.

**Only real contract differences:**
- WS puts the event type *inside* the JSON frame (no `event:` line) → the client's `event` normalization hack (page.tsx:1042 and :1526) disappears.
- WS is full-duplex: the client can send `steer`/`stop`/`queue`/`since:N` control messages **on the same socket**, replacing `POST /api/chat/command` and the 15s `loadSessions` poll.
- WS has no `keepalive` comment frames needed for liveness — the protocol has built-in ping/pong. (But the run-liveness keepalive semantics in `_handle_session_events` — "session still has a live agent → keepalive" — still matter for knowing when to settle.)

**Replay/seq must be preserved over WS too.** A dropped WS frame has exactly the same duplicate/fragment risk as a dropped SSE frame; WS gives you ordering per-connection but not at-least-once delivery. You'd still need `since:N` replay on reconnect, reading from `_session_events`. So WS does **not** remove the `moduleFinalAppended`/`completedCleanly`/`assistantAppended` reconciliation logic — it only makes tail-drops less likely.

---

## 5. Latency / complexity comparison against the actual failure modes

| Failure mode seen | Root cause (from code) | Transport- dependent? | Does WS fix it? |
|---|---|---|---|
| **Duplicate final replies** | SSE tail (run.completed / assistant.completed) dropped through proxy chain → `!completedCleanly || !assistantAppended` triggers full `loadMessages()` reload that re-adds content; mitigated by `moduleFinalAppended` gate + settle | Partially — tail-drops are a proxy-buffer symptom | **Partially.** WS removes HTTP/chunked buffering so tails drop less often, but a dropped WS frame causes the *same* fallback reload. WS ≠ fix; the client gate is the real fix. |
| **Forever-spinning tool chips** | tool.completed raced behind assistant.completed or was dropped → settle-on-completion + chain reapply handles it | **No** — pure client state logic | **No.** WS irrelevant. Already fixed client-side. |
| **Fullscreen reasoning duplication / history fragments** | live-bubble vs final-bubble double render; persisted assistant rows split across fragments; fixed by ordered `ChainView` segments + `loadMessages` merging | **No** | **No.** Rendering logic, not transport. |
| **Edge-cached stale RSC on Vercel** | `cache: no-store` / Cache-Control headers on the RSC + route layer | **No** | **No.** WS bypasses Vercel entirely for chat, but caching is an HTTP/RSC concern unrelated to the streaming socket. |
| **Perceived lag on mobile** | (a) per-delta full-list re-render → now streams into `streamedText` only; (b) `read1()`-vs-`read()` buffering in state_server → already fixed with `read1`; (c) the 5-hop chain RTT; (d) model thinking/tool time | **Small part** — (c) framing overhead; (a)/(b)/(d) are not transport | **Marginally.** WS saves per-frame HTTP/chunked overhead and removes the Vercel↔ngrok HTTP buffering jitter ("shimmer then burst"), and eliminates the per-send HTTP handshake. But the dominant mobile lag is the model's own generation time + the physical RTT through ngrok — WS doesn't reduce those. |
| **Loading-state frequency / busy flicker** | `busy` is set on send/reattach and cleared on settle; reattach flicker comes from re-opening + replay | Small (reattach overhead) | **Marginal.** A persistent WS removes re-open+replay churn, but the *frequency* of `phase: initializing/thinking` states is run-lifecycle-driven, not transport-driven. |

**Honest verdict:** Of the six problems, **four are pure rendering/state bugs that no transport change touches** (spinners, reasoning duplication, history fragments, edge cache). **One is partially transport** (duplicate final reply — mitigated better by the existing gate than by WS). **One is marginally helped** (mobile lag — but mostly due to model time + RTT, not framing). WS does not reduce loading-state *frequency*; the loading states reflect genuine run lifecycle and would still render over WS.

**Complexity cost of WS:** new WS server in state_server (http.server can't do it — rewrite/co-listen with aiohttp or `websockets`), new WS handler + route in api_server, browser rewrite of both read loops, a client-side ticket-auth scheme to keep the tunnel token out of the bundle, and bypassing Vercel (losing its CDN edge + the server-side token boundary). That's a large, risky change for a marginal perceived-latency gain.

---

## 6. Recommended architecture

**Keep SSE as the chat streaming transport. Do NOT introduce WS for token streaming.** The shipped fixes already address the real bugs; the remaining issues are not transport-bound.

- **SSE kept for:** the assistant token stream (`stream/route.ts`), the reattach replay (`events/route.ts`), and anything that must route through Vercel (so `STATE_BRIDGE_TOKEN` and `API_SERVER_KEY` stay server-side and the CDN edge stays in front of RSC). SSE is already working, has seq+replay semantics, and matches the `StreamEvent` contract.
- **WS used (only) where it already exists and adds value — do NOT extend:** `ws_bridge.py` already uses WS as the outbound control plane to the native dashboard for slash/steer. Keep that. It is the *right* use of WS: a low-volume, request/response control channel where full-duplex and connection reuse genuinely help — not a high-rate token fan-out.

**If you ever do want a WS streaming path (not recommended now), the only viable shape** is browser ⇄ Tailscale-funnel-or-ngrok ⇄ state_server(WS) ⇄ Hermes API(WS) — which abandons Vercel for chat. Given the security and caching costs, that only makes sense if (a) you move the dashboard off Vercel entirely, or (b) you accept a LAN/Tailscale-only chat that talks to :8645 directly while Vercel serves everything else.

### Instead of WS, the concrete file-level changes that WILL move the remaining needle

1. **`src/app/chat/page.tsx`** — The remaining duplicate-fragment risk is the `finally { if (!completedCleanly || !assistantAppended) await loadMessages() }` full reload. Prefer a *targeted* reconcile (fetch messages and merge only the tail) over replacing the whole array, so even the fallback never flashes a full-screen refresh. (The `bumpLive`/module scope is already correct — leave it.)
2. **`bridge/state_server.py` `_proxy_api_stream` / `_proxy_api_get_stream`** — These already `read1` + keepalive. Verify the keepalive comment frames actually traverse ngrok+Vercel to the browser (they're the guard against the "shimmer then burst" tail-drop). If Vercel is stripping them, that's the last real streaming-jitter culprit.
3. **`src/lib/chat-types.ts`** — No change needed; the contract is transport-clean already. Optionally add `seq`/`ts` as first-class fields to stop the client-side `event` normalization, but that's cosmetic.
4. **`src/lib/bridge.ts` + `apiBase()`** — Keep. This is the server-side token boundary; do not leak it to the client.
5. **`next.config.ts` CSP** — already allows `wss:`; nothing to do.
6. **Hermes API `api_server.py`** — Only if a future WS stream is wanted, add `GET /api/sessions/{id}/ws` (aiohttp `WebSocketResponse`) in `_http_route_table()` (~:2093) wired to the same `_session_events`/`_session_event_waiters` machinery. **Not needed today.**

### Verification of the "does WS help" question — one experiment worth running
Before any WS work, measure where mobile lag actually goes: instrument `page.tsx` to log, per run, (a) first-byte-to-first-delta wall time and (b) total model time. If (b) dominates (it will — model thinking + tool exec), WS is provably not the lever. If (a) is large and dominated by proxy buffering, then a WS *direct to state server on LAN* is the only thing that would help — not a Vercel-hosted WS.

---

## Summary of findings

- **Transport today:** SSE end-to-end, with seq-based reattach replay and an HTTP-only 5-hop chain (browser→Vercel→ngrok→:8645→:8642). The only existing WS is an *outbound* JSON-RPC client (state_server→:9119) for slash control — not a streaming channel.
- **WS would live** browser⇄tunnel⇄:8645⇄:8642, bypassing Vercel (which can't upgrade serverless sockets).
- **Every hop changes**, but the two big ones are state_server (http.server has no WS — needs aiohttp/`websockets` listener) and api_server (trivial aiohttp WS handler + route). ngrok/Tailscale pass WS.
- **Event contract is identical** payloads; only framing differs (event type moves into the JSON, control becomes full-duplex, seq/replay still required).
- **WS fixes none of the four rendering/state bugs and only marginally helps duplicate-reply tail-drops and mobile framing jitter.** It does not reduce loading-state frequency.
- **Recommendation:** keep SSE for token streaming, keep WS only as the existing control plane. The remaining wins are client-side reconcile/merge refinements and verifying the keepalive survives to the browser — not a transport change.
