#!/usr/bin/env python3
"""Hermes OS v2 — Live State Server

Serves real Hermes local state over HTTP so the Vercel-hosted dashboard can
show live data on the phone (via the ngrok tunnel) without needing Turso.

Endpoints (all read-only, local files only):
  GET /api/crons     -> jobs.json
  GET /api/cron-output -> cron output files
  GET /api/runs      -> executions.db (last 25h)
  GET /api/sessions  -> state.db sessions + last message
  GET /api/artifacts -> hermes-dump + hyperframes repos listing
  GET /api/health    -> { ok: true }

Run:  python3 bridge/state_server.py  (default port 8645)
Tunnel: ngrok http 8645  -> set NEXT_PUBLIC_DATA_URL to that URL on Vercel.
"""
import asyncio
import json
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import push  # noqa: E402

SAST = timezone(timedelta(hours=2))

# Sentinel: handler already wrote a response; caller must not fall through.
_RESPONDED = object()
HERMES = Path(
    os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
).expanduser()
JOBS = HERMES / "cron" / "jobs.json"
EXEC = HERMES / "cron" / "executions.db"
CRON_OUTPUT = HERMES / "cron" / "output"
STATE = HERMES / "state.db"
APPROVALS = HERMES / "approvals.json"
CHAT_PUSH_SEEN = HERMES / "push_seen_chat_runs.json"
GATEWAY_STATE = HERMES / "gateway_state.json"
CHANNEL_DIR = HERMES / "channel_directory.json"
VAULT_ROOT = Path(
    os.environ.get(
        "HERMES_VAULT_ROOT",
        str(Path.home() / "Vault" / "second-brain"),
    )
)
VAULT_CONTENT = VAULT_ROOT / "Content"
MEMORY_DIR = HERMES / "memories"
PORT = int(os.environ.get("STATE_PORT", "8645"))
BRIDGE_TOKEN = os.environ.get("STATE_BRIDGE_TOKEN", "")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://hermes-mission-control-v2.vercel.app")
_CHAT_PUSH_LOCK = threading.Lock()
_CHAT_PUSH_WATCHING: set[str] = set()


def load_approvals() -> list[dict]:
    """Load the local approval store (pending + recent history)."""
    if not APPROVALS.exists():
        return []
    try:
        return json.loads(APPROVALS.read_text())
    except Exception:
        return []


def save_approval(entry: dict) -> None:
    """Upsert one approval entry into the local store (keyed by run_id)."""
    entries = load_approvals()
    entries = [e for e in entries if e.get("run_id") != entry.get("run_id")]
    entries.insert(0, entry)
    # Keep the store bounded (200 entries max).
    APPROVALS.write_text(json.dumps(entries[:200], indent=1))


def _api_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("API_SERVER_KEY", "")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _api_base() -> str:
    return os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")


def load_crons() -> list[dict]:
    if not JOBS.exists():
        return []
    data = json.loads(JOBS.read_text())
    jobs = data if isinstance(data, list) else data.get("jobs", [])
    # normalize: expose id (and keep job_id for compat)
    out = []
    for j in jobs:
        j = dict(j)
        if "id" in j and "job_id" not in j:
            j["job_id"] = j["id"]
        out.append(j)
    return out


def load_runs() -> list[dict]:
    if not EXEC.exists():
        return []
    con = sqlite3.connect(EXEC)
    rows = con.execute(
        "SELECT job_id, status, claimed_at, started_at, finished_at, error FROM executions "
        "WHERE claimed_at > datetime('now','-25 hours') ORDER BY claimed_at DESC LIMIT 500"
    ).fetchall()
    con.close()
    return [
        {"job_id": r[0], "status": r[1], "claimed_at": r[2], "started_at": r[3], "finished_at": r[4], "error": r[5]}
        for r in rows
    ]


def load_cron_output(job_id: str, filename: str | None = None) -> dict:
    """List or read cron output files without allowing path traversal."""
    parts = [job_id] + ([filename] if filename is not None else [])
    if any(not part or ".." in part or "/" in part or "\\" in part for part in parts):
        raise ValueError("invalid job or file")

    output_root = CRON_OUTPUT.resolve()
    job_dir = (output_root / job_id).resolve()
    try:
        job_dir.relative_to(output_root)
    except ValueError as exc:
        raise ValueError("invalid job or file") from exc

    if not job_dir.is_dir():
        raise FileNotFoundError

    if filename is None:
        files = sorted(
            (
                path.name
                for path in job_dir.iterdir()
                if path.is_file() and path.suffix == ".md" and path.resolve().parent == job_dir
            ),
            reverse=True,
        )[:20]
        return {"files": files}

    if not filename.endswith(".md"):
        raise FileNotFoundError
    output_file = job_dir / filename
    if not output_file.is_file() or output_file.resolve().parent != job_dir:
        raise FileNotFoundError
    return {
        "content": output_file.read_text(encoding="utf-8", errors="replace"),
        "job": job_id,
        "file": filename,
    }


# ── Stream tickets ─────────────────────────────────────────────────────────
# The PWA's browser must NEVER hold STATE_BRIDGE_TOKEN. For direct-to-funnel
# streaming, Vercel mints a short-lived single-use ticket via this endpoint
# (Vercel authenticates with the bridge token; the browser only ever sees the
# ticket). Tickets are HMAC-signed, expire in 120s, bind one session_id, and
# are single-use (replay-safe: a stolen ticket is dead after first use).
STREAM_TICKETS_FILE = HERMES / "stream_tickets.json"
STREAM_TICKET_TTL = 120
# Active run registry: session_id -> run_id, maintained by the chat-stream
# proxy (set on run.start, cleared on stream close). Powers cross-device
# reattach: a NEW device opens the PWA, /events sees the live run_id and
# tails the REAL upstream /v1/runs/{run_id}/events instead of 404ing.
ACTIVE_RUNS_FILE = HERMES / "active_runs.json"
_ACTIVE_RUNS_LOCK = __import__("threading").Lock()


def _load_active_runs() -> dict:
    try:
        return json.loads(ACTIVE_RUNS_FILE.read_text())
    except Exception:
        return {}


def _save_active_runs(runs: dict) -> None:
    try:
        ACTIVE_RUNS_FILE.write_text(json.dumps(runs, indent=1))
    except Exception:
        pass


def _set_active_run(session_id: str, run_id: str) -> None:
    with _ACTIVE_RUNS_LOCK:
        runs = _load_active_runs()
        runs[session_id] = {"run_id": run_id, "started": int(time.time())}
        # Drop entries older than 30 min (no run legitimately lives that long)
        now = int(time.time())
        runs = {k: v for k, v in runs.items() if now - int(v.get("started", 0)) < 1800}
        _save_active_runs(runs)


def _clear_active_run(session_id: str) -> None:
    with _ACTIVE_RUNS_LOCK:
        runs = _load_active_runs()
        if runs.pop(session_id, None) is not None:
            _save_active_runs(runs)


def _get_active_run(session_id: str) -> str | None:
    runs = _load_active_runs()
    entry = runs.get(session_id)
    if not entry:
        return None
    if int(time.time()) - int(entry.get("started", 0)) >= 1800:
        return None
    return entry.get("run_id")


def _get_active_run_by_any_key(session_id: str) -> str | None:
    """Resolve a run id for a session that isn't a direct key in
    active_runs.json. Handles the dashboard's visible session id
    (2026…/2026…) vs the lineage root key (api_*) that the chat-stream
    proxy writes. Resolution: SQLite parent_session_id lookup, then a
    suffix/startswith match over registry keys."""
    import sqlite3 as _sq

    runs = _load_active_runs()
    if not runs:
        return None

    # 1) DB parent lookup: the visible session's parent IS the lineage root
    try:
        con = sqlite3.connect(str(STATE), timeout=5)
        row = con.execute(
            "SELECT parent_session_id FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        con.close()
    except Exception:
        row = None
    if row and row[0] and row[0] in runs:
        entry = runs[row[0]]
        if int(time.time()) - int(entry.get("started", 0)) < 1800:
            return entry.get("run_id")

    # 2) Fuzzy key match: same suffix or one key contains the other
    for key, entry in runs.items():
        if session_id.endswith(key) or key.endswith(session_id):
            if int(time.time()) - int(entry.get("started", 0)) < 1800:
                return entry.get("run_id")
    return None


def _ticket_key() -> str:
    """HMAC key for tickets — derived from STATE_BRIDGE_TOKEN (never leaves)."""
    import hashlib

    tok = os.environ.get("STATE_BRIDGE_TOKEN", "")
    if not tok:
        tok = "dev-only"
    return hashlib.sha256(("stream-ticket:" + tok).encode()).hexdigest()


def _sign_ticket(payload: str) -> str:
    import hashlib
    import hmac as _hmac

    return _hmac.new(_ticket_key().encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]


def _new_ticket(session_id: str) -> dict:
    import secrets as _secrets
    import time as _time

    nonce = _secrets.token_hex(12)
    exp = int(_time.time()) + STREAM_TICKET_TTL
    payload = f"{session_id}:{exp}:{nonce}"
    ticket = f"{payload}:{_sign_ticket(payload)}"
    tickets = _load_tickets()
    tickets[nonce] = {"exp": exp, "session_id": session_id}
    # Prune expired + cap size (oldest first by exp)
    now = int(_time.time())
    tickets = {k: v for k, v in tickets.items() if v.get("exp", 0) > now}
    if len(tickets) > 200:
        keep = sorted(tickets.items(), key=lambda kv: kv[1]["exp"])[-200:]
        tickets = dict(keep)
    STREAM_TICKETS_FILE.write_text(json.dumps(tickets, indent=1))
    return {"ticket": ticket, "expires_in": STREAM_TICKET_TTL}


def _load_tickets() -> dict:
    try:
        return json.loads(STREAM_TICKETS_FILE.read_text())
    except Exception:
        return {}


def _consume_ticket(ticket: str) -> str | None:
    """Return session_id if valid+unused, else None. Marks used atomically."""
    try:
        session_id, exp, nonce, sig = ticket.split(":")
        payload = f"{session_id}:{exp}:{nonce}"
        if _sign_ticket(payload) != sig:
            return None
        if int(exp) < int(__import__("time").time()):
            return None
    except Exception:
        return None
    tickets = _load_tickets()
    entry = tickets.get(nonce)
    if not entry or entry.get("used"):
        return None
    entry["used"] = True
    STREAM_TICKETS_FILE.write_text(json.dumps(tickets, indent=1))
    return entry.get("session_id") or session_id


def default_model() -> str:
    """The gateway's active default model (config.yaml model.default).

    The dashboard reads this so new chat sessions pin the REAL brain —
    never a hardcoded name (the PWA hardcoded deepseek-v4-flash:0731 until
    2026-08-28, so new sessions kept stamping deepseek after the switch to
    glm). Returns "" when config.yaml is unreadable; clients fall back.
    """
    try:
        text = (HERMES / "config.yaml").read_text()
        import re as _re

        m = _re.search(r"^model:\s*\n\s*default:\s*(\S+)", text, _re.M)
        if m:
            return m.group(1)
    except Exception:
        pass
    return ""


def load_profiles() -> list[dict]:
    """List multiplex profiles (dirs under ~/.hermes/profiles/) with their
    metadata — model, description, whether they're in the gateway allowlist.
    This powers the chat profile dropdown AND the Agents screen: any profile
    created via `hermes profile create` shows up automatically."""
    profiles_dir = HERMES / "profiles"
    if not profiles_dir.is_dir():
        return []
    # Gateway allowlist (if set) tells us which profiles are actually served
    # by the multiplexer /p/<profile>/ mirrors.
    allowlist = set()
    try:
        import yaml  # noqa: F401 — only used here; venv has it
        import re
        cfg_text = (HERMES / "config.yaml").read_text()
        # Lightweight parse: gateway.multiplex_profile_allowlist or top-level
        allow = re.search(r"multiplex_profile_allowlist:\s*(.*?)(?:\n\s*\w|\n\s*#|\Z)", cfg_text, re.S)
        if allow:
            import ast
            # YAML list "  - breaker" — gather entries
            entries = re.findall(r"^\s*-\s*([\w-]+)", allow.group(1), re.M)
            allowlist = {e for e in entries if e and e != "default"}
    except Exception:
        allowlist = set()

    profiles = []
    for entry in sorted(profiles_dir.iterdir()):
        if not entry.is_dir():
            continue
        name = entry.name
        model = ""
        provider = ""
        # model + provider from config.yaml
        try:
            cfg = json.loads("{}")
            import re as _re
            text = (entry / "config.yaml").read_text() if (entry / "config.yaml").exists() else ""
            m = _re.search(r"^\s*model:\s*\n\s*default:\s*(\S+)", text, _re.M)
            if m:
                model = m.group(1)
            m = _re.search(r"^\s*provider:\s*(\S+)", text, _re.M)
            if m:
                provider = m.group(1)
        except Exception:
            pass
        # profile.yaml metadata
        desc = ""
        try:
            meta = json.loads((entry / "profile.yaml").read_text()) if (entry / "profile.yaml").exists() else {}
            desc = str(meta.get("description") or "").strip()
        except Exception:
            desc = ""
        profiles.append(
            {
                "name": name,
                "model": model,
                "provider": provider,
                "description": desc,
                "served": name in allowlist,
                "path": str(entry),
            }
        )
    return profiles


def load_delegations(limit: int = 50) -> list[dict]:
    """Recent subagent delegations from async_delegations — the live log of
    what subagents were spawned to do, who they report to, and their outcome.
    Used by the Agents screen to show real subagent activity."""
    if not STATE.exists():
        return []
    con = sqlite3.connect(STATE)
    try:
        rows = con.execute(
            "SELECT delegation_id, state, dispatched_at, completed_at, parent_session_id, task_json, result_json "
            "FROM async_delegations ORDER BY dispatched_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    except Exception:
        return []
    out = []
    for r in rows:
        tid, state, disp, done, parent, task, result = r
        goal = ""
        model = ""
        role = ""
        toolsets = None
        try:
            tj = json.loads(task) if task else {}
            if isinstance(tj, dict):
                g = tj.get("goal") or tj.get("goals") or ""
                if isinstance(g, list):
                    g = "; ".join(str(x) for x in g)
                goal = str(g)[:300]
                model = str(tj.get("model") or "")
                role = str(tj.get("role") or "")
                toolsets = tj.get("toolsets")
        except Exception:
            pass
        out.append(
            {
                "id": tid,
                "state": state,
                "role": role or None,
                "model": model or None,
                "parent_session": parent or None,
                "goal": goal,
                "dispatched_at": disp,
                "completed_at": done,
                "toolsets": toolsets,
            }
        )
    con.close()
    return out


def load_sessions(limit: int = 25, source: str | None = None) -> list[dict]:
    if not STATE.exists():
        return []
    con = sqlite3.connect(STATE)
    if source == "dashboard":
        # Chat list: only real conversations (dashboard + legacy empty source),
        # never cron/subagent/dispatch noise — otherwise the top-N is flooded
        # by cron runs and real chats vanish from the list.
        rows = con.execute(
            "SELECT id, source, title, started_at, ended_at, end_reason, message_count, tool_call_count, "
            "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count, "
            "last_activity_at, last_activity_description "
            "FROM sessions WHERE source = 'dashboard' OR source = '' OR source IS NULL "
            "ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    elif source == "all":
        # "All" = every CONVERSATION source (dashboard, subagent, cli, api_server,
        # tui, discord). Cron runs are explicitly excluded — there are ~19k of
        # them and they drown real chats out of the top-N (they're on the Crons
        # page where they belong). Without this the two real conversations
        # vanish from the ALL tab because 19,408 cron rows sit ahead of them.
        rows = con.execute(
            "SELECT id, source, title, started_at, ended_at, end_reason, message_count, tool_call_count, "
            "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count, "
            "last_activity_at, last_activity_description "
            "FROM sessions WHERE source != 'cron' "
            "ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT id, source, title, started_at, ended_at, end_reason, message_count, tool_call_count, "
            "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count, "
            "last_activity_at, last_activity_description "
            "FROM sessions ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    sessions = []
    for r in rows:
        last = None
        try:
            m = con.execute(
                "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content != '' "
                "ORDER BY id DESC LIMIT 1",
                (r[0],),
            ).fetchone()
            if m and isinstance(m[0], str):
                last = m[0][:200]
        except Exception:
            last = None
        # A session is "active" if it has any message within the last minute —
        # the agent is mid-run (thinking, tool calls, streaming) even if the
        # session row itself never "ends" (dashboard sessions are resumable).
        is_active = False
        try:
            recent = con.execute(
                "SELECT 1 FROM messages WHERE session_id = ? AND timestamp > ? LIMIT 1",
                (r[0], time.time() - 60),
            ).fetchone()
            is_active = recent is not None
        except Exception:
            is_active = False
        sessions.append(
            {
                "id": r[0],
                "source": r[1],
                "title": r[2],
                "started_at": r[3],
                "ended_at": r[4],
                "end_reason": r[5],
                "message_count": r[6],
                "tool_call_count": r[7],
                # REAL cumulative usage for the whole session (not per-run):
                # these columns are maintained by Hermes on every API call, so
                # input/output/total reflect the actual context that has been
                # sent to the model across the session's life — the number the
                # footer pie should show, not the last run's usage.
                "input_tokens": r[8] or 0,
                "output_tokens": r[9] or 0,
                "cache_read_tokens": r[10] or 0,
                "cache_write_tokens": r[11] or 0,
                "reasoning_tokens": r[12] or 0,
                "api_call_count": r[13] or 0,
                "last_message": last,
                "last_activity_at": r[14],
                "last_activity_description": r[15] or "",
                "is_active": is_active,
            }
        )
    con.close()
    # Merge the Hermes API's authoritative live-session list (agents with an
    # in-flight run RIGHT NOW) so the sidebar Working… indicator reflects the
    # real live run — the 60s message heuristic above goes stale during long
    # reasoning/tool-call stretches where no new message rows land.
    try:
        import urllib.request as _u
        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        _h = {}
        if api_key:
            _h["Authorization"] = f"Bearer {api_key}"
        _req = _u.Request(f"{api}/api/live/sessions", headers=_h)
        with _u.urlopen(_req, timeout=2) as _resp:
            _live = json.loads(_resp.read() or b"{}").get("session_ids") or []
        _by_id = {s["id"]: s for s in sessions}
        for _sid in _live:
            if _sid in _by_id:
                _by_id[_sid]["is_active"] = True
    except Exception:
        pass
    return sessions


def load_artifacts() -> list[dict]:
    """List files in ~/repos/hermes-dump + hyperframes as artifact links."""
    artifacts = []
    for repo in ("hermes-dump", "hyperframes"):
        base = Path(os.path.expanduser(f"~/repos/{repo}"))
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and ".git" not in p.parts:
                rel = p.relative_to(base).as_posix()
                if rel.startswith(".git"):
                    continue
                artifacts.append(
                    {
                        "title": p.name,
                        "path": rel,
                        "repo": repo,
                        "url": f"https://github.com/Mr-Akhil12/{repo}/blob/main/{rel}",
                    }
                )
    return artifacts[:200]


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse YAML-ish frontmatter (--- delimited) from a markdown file.

    Returns (meta, body). Meta values are strings; lists are joined with
    commas. Falls back to {} if no frontmatter.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    fm = text[3:end].strip()
    body = text[end + 4 :]
    meta: dict[str, str] = {}
    for line in fm.splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if val.startswith("[") and val.endswith("]"):
            val = ", ".join(v.strip() for v in val[1:-1].split(",") if v.strip())
        meta[key] = val
    return meta, body


def load_content() -> list[dict]:
    """List vault Content/ files as studio cards (kanban + calendar)."""
    if not VAULT_CONTENT.exists():
        return []
    cards = []
    for p in sorted(VAULT_CONTENT.glob("*.md"), reverse=True):
        if p.name == "Content Calendar.md":
            continue
        # Only real content pieces: YYYY-MM-DD - ... filename taxonomy.
        # Skip planning/calendar files and anything without a date prefix.
        name = p.stem
        if len(name) < 10 or name[4] != "-" or name[7] != "-":
            continue
        # Skip trading-pipeline artifacts (TWP/Trading/Trade Journal) — those
        # live in the Trading screen, not the content studio.
        lower = name.lower()
        if any(skip in lower for skip in ("twp ", "trading plan", "trade journal", "twp-", "twp_")):
            continue
        try:
            text = p.read_text(errors="replace")
        except Exception:
            continue
        meta, _ = _parse_frontmatter(text)
        date = meta.get("date", name[:10])
        platform = meta.get("platform", "")
        # Infer platform from filename when frontmatter is missing
        if not platform:
            parts = name.split(" - ", 2)
            if len(parts) > 1:
                platform = parts[1]
        # Normalize platform names to a canonical set
        pl = platform.lower()
        if "linkedin" in pl:
            platform = "linkedin"
        elif "youtube" in pl:
            platform = "youtube"
        elif "x" in pl or "twitter" in pl:
            platform = "x"
        elif "tiktok" in pl:
            platform = "tiktok"
        elif "blog" in pl:
            platform = "blog"
        title = meta.get("title", "")
        if not title:
            parts = name.split(" - ", 2)
            title = parts[-1] if len(parts) > 1 else name
        status = meta.get("status", "idea")
        # Normalize status to the kanban set
        status_map = {
            "drafted": "drafted",
            "ready": "approved",
            "approved": "approved",
            "scheduled": "scheduled",
            "posted": "posted",
            "published": "posted",
            "rejected": "rejected",
            "idea": "idea",
        }
        status = status_map.get(status.lower(), "idea")
        cards.append(
            {
                "id": p.name,
                "file": p.name,
                "date": date,
                "platform": platform,
                "title": title,
                "status": status,
                "tags": meta.get("tags", ""),
                "viral_score": meta.get("viral_score", ""),
                "scheduled_for": meta.get("scheduled_for", ""),
                "posted_at": meta.get("posted_at", ""),
                "path": str(p),
            }
        )
    return cards


def update_content_status(file: str, status: str) -> dict:
    """Rewrite the status: line in a vault file's frontmatter."""
    if not file or "/" in file or "\\" in file:
        return {"error": "invalid filename"}
    p = VAULT_CONTENT / file
    if not p.exists():
        return {"error": "file not found"}
    text = p.read_text(errors="replace")
    if not text.startswith("---"):
        return {"error": "no frontmatter"}
    end = text.find("\n---", 3)
    if end == -1:
        return {"error": "no frontmatter"}
    fm = text[3:end]
    body = text[end + 4 :]
    if "status:" in fm:
        import re

        fm = re.sub(r"(?m)^status:.*$", f"status: {status}", fm)
    else:
        fm = fm.rstrip() + f"\nstatus: {status}"
    p.write_text(f"---{fm}---{body}")
    return {"ok": True, "file": file, "status": status}


def load_memory() -> list[dict]:
    """Read Hermes memory files (MEMORY.md + USER.md) as wiki entries."""
    out = []
    for name in ("MEMORY.md", "USER.md"):
        p = MEMORY_DIR / name
        if not p.exists():
            continue
        text = p.read_text(errors="replace")
        # Split on § separators into entries
        entries = [e.strip() for e in text.split("§") if e.strip()]
        out.append({"file": name, "entries": entries, "size": len(text)})
    return out


def load_channels() -> dict:
    """Real gateway platform states + channel directory + recent deliveries."""
    platforms = []
    if GATEWAY_STATE.exists():
        try:
            gs = json.loads(GATEWAY_STATE.read_text())
        except Exception:
            gs = {}
        for name, info in gs.get("platforms", {}).items():
            state = info.get("state", "unknown")
            platforms.append(
                {
                    "id": name,
                    "name": name.replace("_", " ").title(),
                    "state": state,
                    "connected": state == "connected",
                    "error": info.get("error_message") or info.get("error_code") or None,
                    "updated_at": info.get("updated_at", ""),
                }
            )
    channels = []
    if CHANNEL_DIR.exists():
        try:
            cd = json.loads(CHANNEL_DIR.read_text())
        except Exception:
            cd = {}
        for platform, chans in cd.get("platforms", {}).items():
            for ch in chans[:50]:
                channels.append(
                    {
                        "id": ch.get("id", ""),
                        "name": ch.get("name", ""),
                        "guild": ch.get("guild", ""),
                        "platform": platform,
                        "type": ch.get("type", "channel"),
                    }
                )
    # Recent delivery log from state.db delivery_obligations
    deliveries = []
    if STATE.exists():
        try:
            con = sqlite3.connect(STATE)
            rows = con.execute(
                "SELECT platform, state, attempts, created_at, updated_at, last_error, substr(content,1,120) "
                "FROM delivery_obligations ORDER BY updated_at DESC LIMIT 30"
            ).fetchall()
            con.close()
            deliveries = [
                {
                    "platform": r[0],
                    "state": r[1],
                    "attempts": r[2],
                    "created_at": r[3],
                    "updated_at": r[4],
                    "last_error": r[5],
                    "preview": r[6],
                }
                for r in rows
            ]
        except Exception:
            deliveries = []
    return {
        "gateway": {
            "state": (json.loads(GATEWAY_STATE.read_text()).get("gateway_state") if GATEWAY_STATE.exists() else "unknown"),
            "active_agents": (json.loads(GATEWAY_STATE.read_text()).get("active_agents") if GATEWAY_STATE.exists() else 0),
        }
        if GATEWAY_STATE.exists()
        else {"state": "unknown", "active_agents": 0},
        "platforms": platforms,
        "channels": channels,
        "deliveries": deliveries,
        "source": "gateway",
    }


def load_vault_tree() -> list[dict]:
    """List vault folders + note counts (browse view)."""
    if not VAULT_ROOT.exists():
        return []
    folders = []
    for d in sorted(VAULT_ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        count = sum(1 for p in d.rglob("*.md") if ".obsidian" not in p.parts)
        folders.append({"name": d.name, "count": count})
    return folders


def load_vault_notes(folder: str, limit: int = 100) -> list[dict]:
    """List notes in a vault folder (newest first)."""
    if not folder or "/" in folder or "\\" in folder or folder.startswith("."):
        return []
    d = VAULT_ROOT / folder
    if not d.is_dir():
        return []
    notes = []
    for p in sorted(d.glob("*.md"), reverse=True):
        try:
            text = p.read_text(errors="replace")
        except Exception:
            continue
        meta, body = _parse_frontmatter(text)
        notes.append(
            {
                "name": p.stem,
                "file": p.name,
                "folder": folder,
                "date": meta.get("date", ""),
                "tags": meta.get("tags", ""),
                "preview": body.strip()[:200],
                "size": len(text),
            }
        )
        if len(notes) >= limit:
            break
    return notes


def load_vault_note(folder: str, file: str) -> dict:
    """Read one vault note's full content."""
    if not folder or "/" in folder or "\\" in folder or folder.startswith("."):
        return {"error": "invalid folder"}
    if not file or "/" in file or "\\" in file:
        return {"error": "invalid filename"}
    p = VAULT_ROOT / folder / file
    if not p.exists():
        return {"error": "note not found"}
    text = p.read_text(errors="replace")
    meta, body = _parse_frontmatter(text)
    return {"name": p.stem, "file": p.name, "folder": folder, "meta": meta, "body": body, "size": len(text)}


class Handler(BaseHTTPRequestHandler):
    def _authorized(self) -> bool:
        if not BRIDGE_TOKEN:
            return False
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {BRIDGE_TOKEN}":
            return True
        if self.headers.get("X-Bridge-Token", "") == BRIDGE_TOKEN:
            return True
        # Stream tickets ("Bearer ticket <ticket>") pass the gate here and are
        # FULLY validated (signature, expiry, single-use, session binding) at
        # the chat/stream route — never treat this prefix as a bridge token.
        if auth.startswith("Bearer ticket "):
            return True
        return False

    def _cors_headers(self) -> dict:
        return {
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        }

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        if not self._authorized():
            self._json({"error": "unauthorized"}, 401)
            return
        try:
            full_path = self.path.split("?")[0]
            path = full_path
            # Profile-multiplexed paths arrive as /p/<profile>/api/... —
            # LOCAL data handlers strip the prefix (crons/sessions list/push
            # are machine-wide, not profile-scoped); upstream-forwarding
            # handlers use the FULL path so the Hermes API /p/<profile>/…
            # mirrors route to the right profile.
            profile_prefix = ""
            if path.startswith("/p/"):
                parts = path.split("/")
                if len(parts) >= 4:
                    profile_prefix = "/" + "/".join(parts[1:3])  # /p/<profile>
                    path = "/" + "/".join(parts[3:])
            # Proxy the native Hermes dashboard (:9119) so the iframe can load
            # it over HTTPS (mixed-content safe) through the tunnel.
            if path.startswith("/native/"):
                self._proxy_native(path)
                return
            # Session sub-endpoints (messages, chat) come from the Hermes API
            # so the chat page gets real persisted conversation history.
            # Exact /api/sessions stays local (existing Sessions page shape).
            # The /events endpoint is a long-lived SSE reattach stream — must
            # be chunked, not buffered, or the client never sees live frames.
            if path.startswith("/api/sessions/") and path != "/api/sessions":
                if path.endswith("/events"):
                    self._proxy_api_get_stream(path)
                    return
                self._proxy_api_get(path)
                return
            if path == "/api/crons":
                self._json({"jobs": load_crons(), "source": "local"})
            elif path == "/api/cron-output":
                from urllib.parse import parse_qs, urlsplit

                params = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                job_id = (params.get("job") or [""])[0]
                filename = (params.get("file") or [None])[0]
                try:
                    self._json(load_cron_output(job_id, filename))
                except ValueError:
                    self._json({"error": "invalid job or file"}, 400)
                except FileNotFoundError:
                    self._json({"error": "not found"}, 404)
            elif path == "/api/runs":
                self._json({"runs": load_runs(), "source": "local"})
            elif path == "/api/profiles":
                self._json(
                    {"profiles": load_profiles(), "default_model": default_model(), "source": "local"}
                )
            elif path == "/api/delegations":
                self._json({"delegations": load_delegations(), "source": "local"})
            elif path == "/api/sessions":
                if profile_prefix:
                    # Profile-multiplexed session list — each profile has its
                    # OWN state.db, so the local loader (default profile) can't
                    # answer. Forward upstream so the Hermes API /p/<profile>/
                    # mirror lists that profile's sessions.
                    self._proxy_api_get(path)
                    return
                limit = 25
                source = None
                try:
                    q = self.path.split("?", 1)[1]
                    params = dict(kv.split("=") for kv in q.split("&") if "=" in kv)
                    limit = min(int(params.get("limit", 25)), 100)
                    source = params.get("source")
                except Exception:
                    limit = 25
                self._json({"sessions": load_sessions(limit, source), "source": "local"})
            elif path == "/api/artifacts":
                self._json({"artifacts": load_artifacts(), "source": "local"})
            elif path == "/api/content":
                self._json({"cards": load_content(), "source": "vault"})
            elif path == "/api/memory":
                self._json({"memory": load_memory(), "source": "local"})
            elif path == "/api/channels":
                self._json(load_channels())
            elif path == "/api/vault":
                self._json({"folders": load_vault_tree(), "source": "vault"})
            elif path.startswith("/api/vault/notes/"):
                folder = path[len("/api/vault/notes/") :]
                from urllib.parse import unquote

                folder = unquote(folder)
                self._json({"notes": load_vault_notes(folder), "folder": folder, "source": "vault"})
            elif path.startswith("/api/vault/note/"):
                rest = path[len("/api/vault/note/") :]
                from urllib.parse import unquote

                if "/" in rest:
                    folder, file = rest.split("/", 1)
                    folder, file = unquote(folder), unquote(file)
                    self._json(load_vault_note(folder, file))
                else:
                    self._json({"error": "folder/file required"}, 400)
            elif path == "/api/approvals":
                self._json({"approvals": load_approvals(), "source": "local"})
            elif path == "/api/push/vapid":
                self._json({"public_key": push.public_vapid(), "available": push.available()})
            elif path == "/api/stream-ticket":
                # GET with ?session=<id> — actually minted via POST (secret in
                # URL would leak); keep GET rejected for clarity.
                self._json({"error": "use POST"}, 405)
            elif path == "/api/push/status":
                self._json({"enabled": push.available(), "subscriptions": len(push._load_subs())})
            elif path == "/v1/models":
                self._proxy_api_get(path)
            elif path == "/api/model/options":
                self._proxy_api_get(path)
            elif path == "/api/usage":
                self._usage_analytics()
                return
            elif path == "/api/browser/shot":
                self._browser_shot()
                return
            elif path == "/api/health":
                self._json({"ok": True, "time": datetime.now(SAST).isoformat(), "port": PORT})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _proxy_api_get_stream(self, path: str) -> None:
        """Forward a GET to the Hermes API (:8642) with chunked SSE streaming.

        Used by /api/sessions/{id}/events reattach. Cross-device live view:
        this endpoint never existed upstream (404), so a NEW device could
        never attach to a run started elsewhere. Now: if the session has an
        ACTIVE run (registered by the chat-stream proxy via the run.started
        frame), tail the REAL upstream /v1/runs/{run_id}/events — same event
        frames as the original stream. If there's no active run, answer an
        immediate terminal SSE frame so the client settles instead of
        polling a 404 forever.
        """
        import socket as _socket
        import urllib.request as u

        # path = /api/sessions/{session_id}/events?since=N
        parts = path.split("/")
        session_id = parts[3] if len(parts) > 3 else ""
        run_id = _get_active_run(session_id)

        if not run_id:
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.end_headers()
                err = json.dumps({"event": "done", "reason": "no live run"})
                self.wfile.write(f"data: {err}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = u.Request(f"{api}/v1/runs/{run_id}/events", headers=headers)
        try:
            # 45s socket read budget. CRITICAL (2026-08-28): with 15s this died
            # at exactly T+15s during quiet reasoning stretches — after ONE
            # socket timeout the urllib response is poisoned ("cannot read
            # from timed out object") and every later read raises. Upstream
            # sends ": keepalive" every 30s while a run is alive, so 45s only
            # ever fires when the upstream is truly gone.
            with u.urlopen(req, timeout=45) as resp:
                # 404 => the run just ended upstream; settle the client.
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "text/event-stream")
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.end_headers()
                while True:
                    try:
                        chunk = resp.read1(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        if b"event: run.completed" in chunk or b"event: done" in chunk:
                            _clear_active_run(session_id)
                    except _socket.timeout:
                        # Quiet upstream: heartbeat so proxies + browser
                        # keepalive and never see a dead-looking connection.
                        try:
                            self.wfile.write(b": keepalive\n\n")
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                    except (BrokenPipeError, ConnectionResetError):
                        break
        except Exception as e:
            # Run ended upstream (404/410) or connection error: settle with a
            # terminal frame, NOT a JSON 502 (the client's loop reads SSE).
            try:
                with open(r"C:/Users/pilla/AppData/Local/hermes/logs/attach-events-debug.log", "a") as _f:
                    _f.write(f"{time.strftime('%H:%M:%S')} attach-fail run={run_id[:20]} err={type(e).__name__}: {e}\n")
            except Exception:
                pass
            try:
                _clear_active_run(session_id)
            except Exception:
                pass
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.end_headers()
                err = json.dumps({"event": "done", "reason": "run ended"})
                self.wfile.write(f"data: {err}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _proxy_api_get(self, path: str) -> None:
        """Forward a GET to the Hermes API (:8642) — session list/messages."""
        import urllib.request as u
        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = u.Request(f"{api}{self.path}", headers=headers)
        try:
            with u.urlopen(req, timeout=30) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
            self.send_response(resp.status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def _session_control(self, action: str, session_id: str, arg: str = "") -> dict:
        """Control the session's LIVE run on the Hermes API (:8642).

        2026-08-29: the session-scoped routes (/api/sessions/{id}/steer) never
        existed upstream — every steer returned {"error": "HTTP Error 404"}.
        The real endpoints are run-scoped: /v1/runs/{run_id}/steer|stop.
        Resolve the session's active run_id from active_runs.json (maintained
        by the chat-stream proxy) and target that; fall back to no_active_run.
        """
        import urllib.request as u
        import json as _json
        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:18642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # 2026-09-01 FIX: active_runs.json is keyed by the LINEAGE ROOT id
        # (api_*) written by the chat-stream proxy, but the dashboard sends
        # the visible session id (2026…, whose parent_session_id IS the
        # lineage root). Try exact, then resolve via parent_session_id.
        run_id = _get_active_run(session_id)
        if not run_id:
            run_id = _get_active_run_by_any_key(session_id)
        if not run_id:
            return {"ok": False, "status": "no_active_run"}
        if action == "steer":
            body = _json.dumps({"text": arg}).encode()
        elif action == "stop":
            body = b"{}"
        elif action == "goal":
            body = _json.dumps({"arg": arg}).encode()
        else:
            return {"ok": False, "error": f"unknown action {action}"}
        req = u.Request(
            f"{api}/v1/runs/{run_id}/{action}",
            data=body,
            headers=headers,
            method="POST",
        )
        # 2026-09-01 FIX: the API only accepts steers while the run is
        # INSIDE a tool call. Between calls (30-90s of thinking with
        # long-context models) it 409s — a first-try steer usually bounced
        # and the failure was masked. Retry for up to ~35s on 409/404 before
        # reporting no_active_run.
        import time as _time
        attempts = 8 if action == "steer" else 1
        last_err = None
        for attempt in range(attempts):
            try:
                with u.urlopen(req, timeout=20) as resp:
                    data = _json.loads(resp.read() or b"{}")
                if action == "steer" and data.get("accepted"):
                    return {"status": "queued"}
                if action == "stop" and (data.get("interrupted") or data.get("status") == "interrupted"):
                    return {"status": "interrupted"}
                return {"ok": True, **data}
            except u.HTTPError as e:
                try:
                    err_data = _json.loads(e.read() or b"{}")
                except Exception:
                    err_data = {}
                code = err_data.get("error", {}).get("code", "") if isinstance(err_data.get("error"), dict) else ""
                if action == "steer" and (code == "run_not_accepting_steer" or e.code in (409, 404)):
                    if attempt + 1 < attempts:
                        _time.sleep(5)
                        continue
                    return {"ok": False, "status": "no_active_run"}
                return {"ok": False, "error": str(e), **err_data}
            except Exception as e:
                last_err = e
                break
        if last_err:
            return {"ok": False, "error": str(last_err)}
        return {"ok": False, "status": "no_active_run"}

    def _session_steer(self, session_id: str, text: str) -> str:
        result = self._session_control("steer", session_id, text)
        status = result.get("status")
        if status == "queued":
            return f"⏩ Steer queued — arrives after the next tool call: {text[:80]}{'...' if len(text) > 80 else ''}"
        if status == "rejected":
            return "Steer rejected (empty payload)."
        if status == "no_active_run":
            return "No live agent for this conversation right now — send it as a normal message instead."
        if result.get("error"):
            return f"⚠️ Steer failed: {result['error']}"
        return "Steer accepted."

    def _session_stop(self, session_id: str) -> str:
        result = self._session_control("stop", session_id)
        if result.get("status") == "interrupted":
            return "⏹ Stopped the current run."
        if result.get("status") == "no_active_run":
            return "No active run to stop."
        if result.get("error"):
            return f"⚠️ Stop failed: {result['error']}"
        return "Stop requested."

    def _session_goal(self, session_id: str, arg: str) -> str:
        result = self._session_control("goal", session_id, arg)
        out = result.get("output")
        if out:
            return out
        if result.get("error"):
            return f"⚠️ Goal failed: {result['error']}"
        return "Goal updated."

    def _handle_attach(self) -> None:
        """POST /api/chat/attach — save a chat attachment to disk.

        Body: JSON {name, mime, b64} (the browser sends base64 via the Next
        route, keeping the state server free of multipart parsing). Files land
        in ~/.hermes/attachments/<ts>_<safe-name> so the agent's file tools
        can read them on the next turn. A session_id is stored alongside the
        file so the conversation can reference it.
        """
        import json as _json
        import base64 as _b64
        import re as _re
        import uuid as _uuid
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            payload = _json.loads(body or b"{}")
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return
        name = str(payload.get("name") or "attachment").strip()
        name = _re.sub(r"[^\w.\- ]", "_", name)[:120] or "attachment"
        mime = str(payload.get("mime") or "application/octet-stream")
        b64 = str(payload.get("b64") or "")
        session_id = str(payload.get("session_id") or "")
        if not b64:
            self._json({"error": "b64 payload required"}, 400)
            return
        try:
            raw = _b64.b64decode(b64)
        except Exception as exc:
            self._json({"error": f"bad base64: {exc}"}, 400)
            return
        # ~20MB cap — attachments are read into agent context, keep them sane.
        if len(raw) > 20 * 1024 * 1024:
            self._json({"error": "attachment too large (max 20MB)"}, 413)
            return
        att_dir = Path(os.path.expanduser("~/.hermes/attachments"))
        att_dir.mkdir(parents=True, exist_ok=True)
        fname = f"{_uuid.uuid4().hex[:8]}_{name}"
        path = att_dir / fname
        try:
            path.write_bytes(raw)
        except Exception as exc:
            self._json({"error": f"write failed: {exc}"}, 500)
            return
        self._json({
            "ok": True,
            "path": str(path),
            "name": name,
            "mime": mime,
            "size": len(raw),
            "session_id": session_id,
        })

    def _proxy_native(self, path: str) -> None:
        if not self._authorized():
            self._json({"error": "unauthorized"}, 401)
            return
        """Proxy a request to the native Hermes dashboard (:9119)."""
        import urllib.request as u
        native = os.environ.get("NATIVE_URL", "http://127.0.0.1:9119")
        target = f"{native}{path}"
        try:
            req = u.Request(target)
            with u.urlopen(req, timeout=15) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "text/html")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def _profile_create(self) -> None:
        """POST /api/profiles/create — create a new Hermes multiplex profile
        via `hermes profile create`. Body: {name, description?, clone_from?,
        model?}. Runs on the host so the dashboard can spawn specialized
        bots (the "Bots" tab) without SSH."""
        import subprocess as _sp
        import re as _re
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body or b"{}")
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return
        name = str(payload.get("name") or "").strip().lower()
        if not _re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", name):
            self._json({"error": "profile name must be lowercase alphanumeric (2-32 chars)"}, 400)
            return
        desc = str(payload.get("description") or "").strip()
        clone_from = str(payload.get("clone_from") or "").strip()
        model = str(payload.get("model") or "").strip()
        existing = HERMES / "profiles" / name
        if existing.is_dir():
            self._json({"error": f"profile '{name}' already exists"}, 409)
            return
        cmd = ["hermes", "profile", "create", name, "--no-skills"]
        if desc:
            cmd += ["--description", desc]
        if clone_from:
            cmd += ["--clone-from", clone_from]
        try:
            res = _sp.run(cmd, capture_output=True, text=True, timeout=120)
        except Exception as exc:
            self._json({"error": f"create failed: {exc}"}, 502)
            return
        if res.returncode != 0:
            self._json({"error": res.stderr.strip() or res.stdout.strip() or "create failed"}, 502)
            return
        # If a model was requested, write it into the new profile's config
        # (model.default + provider). Only when the user specified one.
        if model and existing.is_dir():
            cfg_path = existing / "config.yaml"
            try:
                lines = cfg_path.read_text().splitlines() if cfg_path.exists() else []
                provider = str(payload.get("provider") or "").strip() or "openrouter"
                # Ensure a `model:` block at the top with default + provider.
                block = f"model:\n  default: {model}\n  provider: {provider}\n"
                rest = "\n".join(lines) if lines else ""
                cfg_path.write_text(block + rest)
            except Exception:
                pass
        self._json({"ok": True, "name": name, "description": desc, "model": model or None})

    def do_POST(self):
        if not self._authorized():
            self._json({"error": "unauthorized"}, 401)
            return
        """Proxy chat completions + session endpoints + run starts to the
        local Hermes API (:8642) so one ngrok tunnel serves live state, chat,
        streaming, and approvals."""
        try:
            full_path = self.path.split("?")[0]
            path = full_path
            # Profile-multiplexed paths: strip /p/<profile> for LOCAL dispatch
            # (the upstream proxy uses self.path = full path so the Hermes API
            # /p/<profile>/… mirrors route to the right profile).
            if path.startswith("/p/"):
                parts = path.split("/")
                if len(parts) >= 4:
                    path = "/" + "/".join(parts[3:])
            # Session endpoints: create, chat, chat/stream, fork
            if path.startswith("/api/sessions"):
                # Ticket-authenticated direct stream: POST /api/sessions/{id}/chat/stream
                # with `Authorization: Bearer ticket <ticket>` — a browser
                # holding a short-lived single-use stream ticket. The ticket
                # binds the session, so a stolen ticket only ever replays a
                # message into that one conversation, and dies in 120s.
                auth = self.headers.get("Authorization", "")
                if auth.startswith("Bearer ticket "):
                    ticket = auth[len("Bearer ticket "):].strip()
                    ticket_session = _consume_ticket(ticket)
                    if not ticket_session or ticket_session != path.split("/")[3]:
                        self._json({"error": "invalid or expired stream ticket"}, 403)
                        return
                self._proxy_api_stream(full_path, stream=full_path.endswith("/chat/stream"))
                return
            # Stream ticket minting (bridge-token auth only — the browser asks
            # the Vercel route, which holds the real token).
            if path == "/api/stream-ticket":
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length else b"{}"
                try:
                    data = json.loads(body)
                except Exception:
                    self._json({"error": "invalid JSON"}, 400)
                    return
                session_id = str(data.get("session_id") or "").strip()
                if not session_id or len(session_id) > 160:
                    self._json({"error": "session_id required"}, 400)
                    return
                self._json(_new_ticket(session_id))
                return
            # Run approval resolution: POST /v1/runs/{run_id}/approval
            if "/v1/runs/" in path and path.endswith("/approval"):
                self._proxy_api_stream(full_path, stream=False)
                return
            # Run start: POST /v1/runs — returns run_id; immediately subscribe
            # to the run's event stream to capture approval.request events.
            if path == "/v1/runs":
                self._start_tracked_run()
                return
            # Web Push: subscribe / unsubscribe / test
            if path == "/api/push/subscribe":
                self._push_subscribe()
                return
            if path == "/api/push/unsubscribe":
                self._push_unsubscribe()
                return
            if path == "/api/push/test":
                self._push_test()
                return
            if path == "/api/push/watch":
                self._push_watch()
                return
            # Content Studio: update a card's status (writes vault frontmatter)
            if path == "/api/content/status":
                self._content_status()
                return
            # Slash command execution — runs registry-owned Hermes executors
            # server-side (same venv as the gateway) so the dashboard chat has
            # real /help, /version, /status-style commands, not just prompts.
            if path == "/api/chat/slash":
                self._exec_slash_command()
                return
            # Full command bridge — runs ANY slash command through the native
            # dashboard's JSON-RPC WebSocket (slash.exec / command.dispatch),
            # giving the dashboard chat the complete Hermes command surface.
            if path == "/api/chat/command":
                self._exec_full_command()
                return
            # Chat attachment upload — saves the file to ~/.hermes/attachments
            # so the agent can read it with its file tools in the next turn.
            if path == "/api/chat/attach":
                self._handle_attach()
                return
            # Profile creation — spawns a new multiplex bot profile.
            if path == "/api/profiles/create":
                self._profile_create()
                return
            if path not in ("/v1/chat/completions", "/api/chat"):
                self._json({"error": "not found"}, 404)
                return
            self._proxy_api_stream(path, stream=False)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def _usage_analytics(self) -> None:
        """GET /api/usage?bucket=day|week|month&days=90&from=&to=

        TWO real data sources, clearly labelled:

        1. "live" — Ollama's own account meter (GET https://ollama.com/api/usage
           with the account's OLLAMA_API_KEY): authoritative dollars + request
           counts for the current monthly window, plus account identity via
           POST /api/me. No daily breakdown exists on Ollama's API (verified
           against docs.ollama.com 2026-09-02) — this is a snapshot, not a series.

        2. "ledger" — the gateway's session_model_usage table: the agent core
           upserts a TRUE DELTA per API call (ON CONFLICT adds), keyed by
           (session, model, base-url, task). This powers the date-range series.
           first_seen/last_seen are window bounds of accumulation, NOT call
           timestamps — tokens sum exactly.

        Costs are computed from Ollama's published per-M prices at the
        cached-input rate for input (Hermes resends conversation prefixes, so
        input is dominantly cache-hits on ollama.com).
        """
        import sqlite3 as _sq
        from urllib.parse import urlparse, parse_qs, unquote

        q = parse_qs(unquote(urlparse(self.path).query))
        provider = (q.get("provider", ["ollama-cloud"])[0] or "ollama-cloud").strip().lower()
        bucket = (q.get("bucket", ["day"])[0] or "day").strip().lower()
        try:
            days = max(1, min(int(q.get("days", ["90"])[0] or 90), 400))
        except Exception:
            days = 90
        date_from = (q.get("from", [""])[0] or "").strip()
        date_to = (q.get("to", [""])[0] or "").strip()

        # Ollama Cloud PUBLISHED metered prices ($/M tokens), keyed by model
        # prefix: (input, cached-input, output). From ollama.com/pricing
        # (2026-09-02). Input is priced at the CACHED rate because Hermes
        # resends conversation prefixes every call and ollama.com's prompt
        # cache serves those — the uncached rate would overstate cost ~3-5x.
        PRICES = {
            "glm-5.3-flash": (0.15, 0.03, 0.5),
            "glm-5.3": (1.4, 0.26, 4.4),
            "glm-5.2": (1.4, 0.26, 4.4),
            "glm-5.1": (1.0, 0.2, 3.2),
            "deepseek-v4-flash": (0.44, 0.014, 1.32),
            "deepseek-v4-pro": (1.32, 0.044, 3.96),
            "gemma4": (0.14, 0.05, 0.4),
            "gpt-oss:120b": (0.15, 0.014, 0.6),
            "gpt-oss:20b": (0.07, 0.035, 0.3),
            "nemotron-3-super": (0.015, 0.015, 0.6),
            "nemotron-3-ultra": (0.1, 0.1, 3.0),
            "kimi-k3": (3.0, 0.3, 15.0),
            "qwen3.5:397b": (0.6, 0.6, 3.6),
        }

        def _price(model: str):
            m = (model or "").lower()
            for prefix, p in PRICES.items():
                if m.startswith(prefix):
                    return p
            return PRICES["glm-5.3-flash"]

        # ── Ledger series (date-range data) ──
        # Window: explicit from/to (SAST dates) wins; else trailing `days`.
        # Bucket by the row's ACCUMULATION START day (first_seen, SAST) —
        # upserts keep first_seen fixed per billing key, so each call's tokens
        # land in the day its billing key was opened. Good enough at daily
        # granularity; exact per-call times aren't stored in this table.
        where = ["LOWER(COALESCE(billing_provider,'')) = ?"]
        params = [provider]
        if date_from:
            # 'from' is a SAST date: Jul 1 00:00 SAST = Jun 30 22:00 UTC =
            # strftime(from,'-1 day','+22 hours').
            where.append("first_seen >= strftime('%s', ?, '-1 day', '+22 hours')")
            params.append(date_from)
        if date_to:
            # Inclusive of the whole `to` day in SAST: end bound = to-day
            # 23:59:59 SAST = to+1day 00:00 SAST minus 1s = to+1day 21:59:59 UTC
            # = strftime(to,'-2 hours','+1 day') as an exclusive upper bound.
            where.append("first_seen < strftime('%s', ?, '-2 hours', '+1 day')")
            params.append(date_to)
        if not date_from:
            where.append("first_seen >= strftime('%s','now','-{days} days')".replace("{days}", str(days)))

        sql = f"""
            SELECT strftime('%Y-%m-%d', first_seen, 'unixepoch', '+2 hours') AS d,
                   model,
                   CASE WHEN task='' THEN 'main' ELSE task END AS task_kind,
                   SUM(COALESCE(input_tokens,0)) AS tin,
                   SUM(COALESCE(output_tokens,0)) AS tout,
                   SUM(COALESCE(cache_read_tokens,0)) AS cache_read,
                   SUM(COALESCE(reasoning_tokens,0)) AS reasoning,
                   SUM(COALESCE(api_call_count,0)) AS calls,
                   SUM(COALESCE(estimated_cost_usd,0)) AS est_cost,
                   MIN(first_seen) AS win_start
            FROM session_model_usage
            WHERE {' AND '.join(where)}
            GROUP BY d, model, task_kind
            ORDER BY d
        """
        try:
            con = _sq.connect(str(STATE), timeout=10)
            rows = con.execute(sql, params).fetchall()
            con.close()
        except Exception as e:
            self._json({"error": f"usage query failed: {e}"}, 500)
            return

        # Aggregate by bucket + per-model + per-task
        import datetime as _dt
        series: dict = {}
        per_model: dict = {}
        per_task: dict = {}
        totals = {"tokens_in": 0, "tokens_out": 0, "cache_read": 0, "reasoning": 0,
                  "requests": 0, "cost_usd": 0.0, "sessions": set()}
        session_keys = set()
        for d, model, task_kind, tin, tout, cache, reasoning, calls, est, win_start in rows:
            key = d
            if bucket == "week":
                try:
                    y, m, dd = map(int, d.split("-"))
                    iso = _dt.date(y, m, dd).isocalendar()
                    key = f"{iso[0]}-W{iso[1]:02d}"
                except Exception:
                    key = d
            elif bucket == "month":
                key = d[:7]
            pin, pcache, pout = _price(model)
            cost = (tin * pcache + cache * pcache + tout * pout) / 1e6
            b = series.setdefault(key, {"bucket": key, "tokens_in": 0, "tokens_out": 0,
                                        "requests": 0, "cost_usd": 0.0})
            b["tokens_in"] += tin or 0
            b["tokens_out"] += tout or 0
            b["requests"] += calls or 0
            b["cost_usd"] += cost
            pm = per_model.setdefault(model, {"model": model, "tokens_in": 0, "tokens_out": 0,
                                              "requests": 0, "cost_usd": 0.0})
            pm["tokens_in"] += tin or 0
            pm["tokens_out"] += tout or 0
            pm["requests"] += calls or 0
            pm["cost_usd"] += cost
            pt = per_task.setdefault(task_kind, {"task": task_kind, "requests": 0,
                                                 "tokens_in": 0, "tokens_out": 0})
            pt["requests"] += calls or 0
            pt["tokens_in"] += tin or 0
            pt["tokens_out"] += tout or 0
            totals["tokens_in"] += tin or 0
            totals["tokens_out"] += tout or 0
            totals["cache_read"] += cache or 0
            totals["reasoning"] += reasoning or 0
            totals["requests"] += calls or 0
            totals["cost_usd"] += cost
            session_keys.add(win_start)

        out_series = sorted(series.values(), key=lambda x: x["bucket"])
        models_out = sorted(per_model.values(), key=lambda x: -x["requests"])
        for m in models_out:
            m["cost_usd"] = round(m["cost_usd"], 4)
        for b in out_series:
            b["cost_usd"] = round(b["cost_usd"], 4)

        # ── Live Ollama account meter (real API, real key) ──
        live = None
        try:
            import urllib.request as _u
            key = ""
            env_path = str(HERMES / ".env")
            if os.path.exists(env_path):
                for line in open(env_path, encoding="utf-8", errors="ignore"):
                    if line.strip().startswith("OLLAMA_API_KEY="):
                        key = line.split("=", 1)[1].strip()
            if key:
                headers = {"Authorization": f"Bearer {key}"}
                with _u.urlopen(_u.Request("https://ollama.com/api/usage", headers=headers), timeout=10) as r:
                    meter = json.loads(r.read() or b"{}")
                me = {}
                try:
                    req = _u.Request("https://ollama.com/api/me", method="POST",
                                     headers={**headers, "Content-Type": "application/json"}, data=b"{}")
                    with _u.urlopen(req, timeout=10) as r:
                        me = json.loads(r.read() or b"{}")
                except Exception:
                    me = {}
                monthly = (meter.get("limits") or {}).get("monthly", {})
                period = ((meter.get("activity") or {}).get("period") or {})
                live = {
                    "email": me.get("Email"),
                    "name": me.get("Name"),
                    "plan": me.get("Plan"),
                    "monthly_usage": float(monthly.get("usage", 0) or 0),
                    "monthly_window": period,
                    "models": [
                        {"model": m.get("name"), "requests": m.get("request_count", 0)}
                        for m in (monthly.get("models") or [])
                    ],
                }
        except Exception as e:
            live = {"error": str(e)[:160]}

        self._json({
            "provider": provider,
            "bucket": bucket,
            "series": out_series,
            "per_model": models_out,
            "per_task": sorted(per_task.values(), key=lambda x: -x["requests"]),
            "totals": {**totals, "cost_usd": round(totals["cost_usd"], 4),
                       "sessions": len(session_keys)},
            "live": live,
        })

    def _exec_dashboard_command(self, name: str, arg: str) -> str | object:
        """Run a read-only dashboard command server-side, backed by real data.

        These run in the state server process (same venv/machine as the
        gateway) — no WS bridge, no orphan session, no error bubbles. Covers
        the commands the picker surfaces that have no registry executor.
        """
        import json as _json
        import sqlite3 as _sqlite3

        # 2026-09-01 FIX: was os.path.expanduser("~/.hermes") — a stale
        # June-era WSL-migration leftover. /cron list showed 19 June jobs,
        # /status showed a Jun 9 session. Use the LIVE Hermes home (module
        # HERMES constant already resolves HERMES_HOME env correctly).
        home = str(HERMES)

        if name == "cron" and (not arg or arg.split()[0] in ("list", "ls")):
            try:
                data = _json.load(open(f"{home}/cron/jobs.json"))
                jobs = data.get("jobs", [])
                if not jobs:
                    return "No cron jobs scheduled."
                lines = [f"**Cron jobs ({len(jobs)})**", ""]
                for j in sorted(jobs, key=lambda x: x.get("name", "")):
                    sched = (j.get("schedule") or {}).get("display") or j.get("schedule_display") or "?"
                    lines.append(
                        f"- `{j.get('name')}` — `{sched}` — "
                        f"{'script: ' + (j.get('script') or '') if j.get('script') else (j.get('model') or 'agent')}"
                    )
                return "\n".join(lines)
            except Exception as e:
                return f"⚠️ Cron read failed: {e}"

        if name == "skills" and (not arg or arg.split()[0] in ("list", "ls", "browse")):
            try:
                skills_dir = f"{home}/skills"
                if not os.path.isdir(skills_dir):
                    return "No skills directory."
                cats = sorted(d for d in os.listdir(skills_dir) if os.path.isdir(os.path.join(skills_dir, d)))
                lines = [f"**Skills ({len(cats)} categories)**", ""]
                for c in cats:
                    sub = os.path.join(skills_dir, c)
                    items = [d for d in os.listdir(sub) if os.path.isdir(os.path.join(sub, d))]
                    lines.append(f"- **{c}** — {', '.join(items) if items else '(loose files)'}")
                return "\n".join(lines)
            except Exception as e:
                return f"⚠️ Skills read failed: {e}"

        if name == "usage":
            try:
                path = f"{home}/cron/usage_audit.jsonl"
                if not os.path.exists(path):
                    return "No usage audit data yet."
                total = prompts = 0
                for line in open(path):
                    try:
                        e = _json.loads(line)
                        total += e.get("total_tokens", 0) or 0
                        prompts += 1
                    except Exception:
                        pass
                return f"**Token usage**\n\n- Runs audited: {prompts}\n- Total tokens: {total:,}"
            except Exception as e:
                return f"⚠️ Usage read failed: {e}"

        if name == "insights":
            try:
                db = f"{home}/state.db"
                con = _sqlite3.connect(db)
                row = con.execute(
                    "select count(*), coalesce(sum(message_count),0), coalesce(sum(tool_call_count),0), "
                    "coalesce(sum(input_tokens),0)+coalesce(sum(output_tokens),0) from sessions"
                ).fetchone()
                con.close()
                return (
                    f"**Insights (all sessions)**\n\n"
                    f"- Sessions: {row[0]:,}\n- Messages: {row[1]:,}\n"
                    f"- Tool calls: {row[2]:,}\n- Tokens (in+out): {row[3]:,}"
                )
            except Exception as e:
                return f"⚠️ Insights read failed: {e}"

        if name == "agents" or name == "tasks":
            try:
                db = f"{home}/state.db"
                con = _sqlite3.connect(db)
                rows = con.execute(
                    "select id, source, started_at, message_count from sessions "
                    "where ended_at is null order by started_at desc limit 10"
                ).fetchall()
                con.close()
                if not rows:
                    return "No active sessions right now."
                lines = ["**Active sessions**", ""]
                for sid, source, started, count in rows:
                    lines.append(
                        f"- `{sid[:20]}…` ({source}) — {count} msgs — {time.strftime('%b %d %H:%M', time.localtime(started))}"
                    )
                return "\n".join(lines)
            except Exception as e:
                return f"⚠️ Agents read failed: {e}"

        if name == "status":
            db = f"{home}/state.db"
            try:
                con = _sqlite3.connect(db)
                row = con.execute(
                    "select id, model, source, message_count, tool_call_count from sessions "
                    "order by started_at desc limit 1"
                ).fetchone()
                con.close()
                if not row:
                    return "No sessions yet."
                return (
                    f"**Latest session**\n\n"
                    f"- Id: `{row[0]}`\n- Model: {row[1] or 'default'}\n- Source: {row[2]}\n"
                    f"- Messages: {row[3]} · Tools: {row[4]}"
                )
            except Exception as e:
                return f"⚠️ Status read failed: {e}"

        if name == "memory" and (not arg or arg.split()[0] in ("pending",)):
            try:
                pending_dir = f"{home}/pending_messages"
                if not os.path.isdir(pending_dir):
                    return "No pending memory writes."
                files = os.listdir(pending_dir)
                if not files:
                    return "No pending memory writes."
                lines = [f"**Pending memory writes ({len(files)})**", ""]
                for f in files[:20]:
                    lines.append(f"- `{f}`")
                return "\n".join(lines)
            except Exception as e:
                return f"⚠️ Memory read failed: {e}"

        if name == "curator" and arg.split()[0] in ("status",):
            try:
                state = _json.load(open(f"{home}/skills/.curator_state"))
                return (
                    f"**Curator status**\n\n"
                    f"- Last run: {state.get('last_run_at', 'never')}\n"
                    f"- Duration: {state.get('last_run_duration_seconds', 0):.1f}s\n"
                    f"- Summary: {state.get('last_run_summary', '—')}"
                )
            except Exception as e:
                return f"⚠️ Curator read failed: {e}"

        if name == "diff":
            # Read-only git status + diff stat in the dashboard repo.
            repo = os.getcwd()
            try:
                st = subprocess.run(
                    ["git", "-C", repo, "status", "--short"],
                    capture_output=True, text=True, timeout=20,
                )
                df = subprocess.run(
                    ["git", "-C", repo, "diff", "--stat"],
                    capture_output=True, text=True, timeout=20,
                )
                status_out = (st.stdout or "").strip()
                diff_out = (df.stdout or "").strip()
                lines = [f"**Git status — `{repo}`**", ""]
                lines += status_out.splitlines()[:25] if status_out else ["(clean working tree)"]
                if diff_out:
                    lines += ["", "**Uncommitted diff**", ""] + diff_out.splitlines()[:15]
                return "\n".join(lines)
            except Exception as e:
                return f"⚠️ Diff failed: {e}"

        if name == "kanban":
            # Read-only kanban views only. Mutating subcommands need a terminal.
            sub = arg.split()[0] if arg else "list"
            read_only = {"list", "ls", "boards", "show", "stats", "diagnostics", "diag", "context"}
            if sub not in read_only:
                return (
                    f"`/kanban {sub}` is a write operation — run it in a terminal "
                    f"(`hermes kanban {sub}`) so you can review before it changes the board."
                )
            try:
                hermes_bin = os.path.expanduser("~/.hermes/hermes-agent/venv/bin/hermes")
                if not os.path.exists(hermes_bin):
                    hermes_bin = "hermes"
                r = subprocess.run(
                    [hermes_bin, "kanban", sub, *arg.split()[1:]],
                    capture_output=True, text=True, timeout=30,
                )
                out = (r.stdout or r.stderr or "").strip()
                if not out:
                    return f"/kanban {sub}: no output (board may be empty)."
                return out[:4000]
            except Exception as e:
                return f"⚠️ Kanban read failed: {e}"

        if name == "reload-skills":
            # Rescan skills on disk and report what changed. This process-local
            # rescan shows newly added/removed skills; the gateway's own skill
            # cache picks up changes on its next scan/reload.
            import sys as _sys
            try:
                agent_root = os.path.expanduser("~/.hermes/hermes-agent")
                if agent_root not in _sys.path:
                    _sys.path.insert(0, agent_root)
                from agent.skill_commands import reload_skills as _rs
                result = _rs()
                lines = ["**Skills rescan**", ""]
                lines.append(f"- Total skills: {result.get('total', 0)}")
                added = result.get("added", [])
                removed = result.get("removed", [])
                if added:
                    lines.append(f"- Added: {', '.join(a.get('name','?') for a in added)}")
                if removed:
                    lines.append(f"- Removed: {', '.join(a.get('name','?') for a in removed)}")
                if not added and not removed:
                    lines.append("- No changes since last scan.")
                return "\n".join(lines)
            except Exception as e:
                return f"⚠️ Skills rescan failed: {e}"

        if name == "reload-mcp":
            return (
                "`/reload-mcp` can't be run cleanly from the dashboard — it needs the "
                "gateway's own MCP clients to reconnect. Run `hermes gateway restart` "
                "or `/reload-mcp` in Discord instead."
            )

        if name == "topup":
            return "`/topup` needs the Nous billing portal — open it in a browser (desktop app) or run it in a terminal."

        if name == "restart":
            # Confirmed by the gate above. Restart the gateway as a background
            # process so the HTTP response flushes before the gateway dies.
            self._json({"ok": True, "name": "restart", "output": "🔄 Restarting the Hermes gateway — chat will reconnect in a few seconds."})
            import threading
            threading.Timer(1.0, self._restart_gateway).start()
            return _RESPONDED

        if name == "update":
            # Confirmed by the gate. Run the ritual script detached — it pulls,
            # reapplies auth patches, migrates config, restarts the gateway.
            self._json({"ok": True, "name": "update", "output": "🔄 Updating Hermes — pulling latest, reinstalling deps, restarting the gateway. Back in a minute."})
            import threading
            threading.Timer(1.5, self._run_update).start()
            return _RESPONDED

        if name == "platform":
            # Read-only status view of the messaging platforms (like Discord's
            # /platform list — shows live state, nothing destructive).
            try:
                hermes_bin = os.path.expanduser("~/.hermes/hermes-agent/venv/bin/hermes")
                r = subprocess.run(
                    [hermes_bin, "gateway", "list"],
                    capture_output=True, text=True, timeout=30,
                )
                return (r.stdout or r.stderr or "").strip()
            except Exception as e:
                return f"⚠️ Platform status failed: {e}"

        if name == "debug" and arg.split()[0] == "local":
            # Local debug report — no upload, just the system/log snapshot.
            try:
                hermes_bin = os.path.expanduser("~/.hermes/hermes-agent/venv/bin/hermes")
                r = subprocess.run(
                    [hermes_bin, "debug", "share", "--local"],
                    capture_output=True, text=True, timeout=60,
                )
                out = (r.stdout or r.stderr or "").strip()
                return out[:4000] or "/debug: no output"
            except Exception as e:
                return f"⚠️ Debug report failed: {e}"
        if name == "debug":
            return "Usage: `/debug local` — prints the report locally. (`/debug nous` uploads — not from chat.)"

        # 2026-09-01: native command.dispatch has no executor for these
        # (they 502'd "not a quick/plugin command"). Serve with real data.
        if name == "help":
            return (
                "**Dashboard chat commands**\n\n"
                "- `/cron list` — scheduled jobs (live)\n"
                "- `/status` — latest session + model\n"
                "- `/agents` `/tasks` — active sessions\n"
                "- `/usage` `/insights` — token totals\n"
                "- `/model <name>` — switch this session's brain\n"
                "- `/steer <text>` — live correction to the running agent\n"
                "- `/queue <text>` — send after the current run finishes\n"
                "- `/stop` — stop the current run\n"
                "- `/new` `/title` `/retry` `/fork` — session control\n"
                "- `/context` — token/context stats\n"
                "- `/restart confirm` `/update confirm` — gateway lifecycle\n"
            )
        if name == "sessions":
            try:
                con = _sqlite3.connect(f"{home}/state.db")
                rows = con.execute(
                    "select id, source, model, message_count, started_at from sessions "
                    "order by started_at desc limit 10"
                ).fetchall()
                con.close()
                if not rows:
                    return "No sessions found."
                lines = ["**Recent sessions**", ""]
                for sid_, src, mdl, cnt, started in rows:
                    import time as _t
                    lines.append(f"- `{sid_[:22]}…` ({src}) — {cnt} msgs — {mdl or '?'} — {_t.strftime('%b %d %H:%M', _t.localtime(started))}")
                return "\n".join(lines)
            except Exception as e:
                return f"⚠️ Sessions read failed: {e}"
        if name == "model" and not arg:
            try:
                con = _sqlite3.connect(f"{home}/state.db")
                row = con.execute(
                    "select model, model_config from sessions where ended_at is null "
                    "order by last_active desc limit 1"
                ).fetchone()
                con.close()
                if row:
                    import json as _j
                    eff = "?"
                    try:
                        eff = (_j.loads(row[1]) or {}).get("model") or row[0]
                    except Exception:
                        eff = row[0]
                    return f"**Model**\n\n- Latest active session: `{row[0]}`\n- Usage: `/model <name>` to switch"
            except Exception:
                pass
            return "Usage: `/model <name>` — e.g. `/model glm-5.3-flash`"

        return ""  # not handled — caller falls back to bridge

    def _restart_gateway(self) -> None:
        """Restart the systemd gateway service (confirmed earlier)."""
        try:
            hermes_bin = os.path.expanduser("~/.hermes/hermes-agent/venv/bin/hermes")
            r = subprocess.run(
                [hermes_bin, "gateway", "restart"],
                capture_output=True, text=True, timeout=120,
            )
            log_tail = (r.stdout or r.stderr or "").strip()
            self._log_ops(f"gateway restart: {log_tail[:200]}")
        except Exception as e:
            self._log_ops(f"gateway restart failed: {e}")

    def _run_update(self) -> None:
        """Run the update ritual script detached (confirmed earlier)."""
        try:
            script = os.path.expanduser("~/.hermes/scripts/gateway-update.sh")
            if not os.path.exists(script):
                self._log_ops("update failed: script missing")
                return
            subprocess.Popen(
                ["bash", script],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            self._log_ops("update script started detached")
        except Exception as e:
            self._log_ops(f"update failed to start: {e}")

    def _log_ops(self, msg: str) -> None:
        """Append a line to the ops log so restarts/updates are auditable."""
        try:
            with open(os.path.expanduser("~/.hermes/logs/dashboard-ops.log"), "a") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
        except Exception:
            pass

    def _exec_slash_command(self) -> None:
        """POST /api/chat/slash — run a slash command via hermes_cli.slash_exec.

        Body: {"command": "/version"} or {"name": "version", "arg": ""}
        Only informational/registry-owned commands execute here; interactive
        commands (/model, /new) are handled client-side against the API.
        """
        import sys as _sys
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body or b"{}")
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return

        raw = payload.get("command") or ""
        name = (payload.get("name") or raw.lstrip("/").split()[0] if isinstance(payload.get("name"), str) else "") or raw.lstrip("/").split(" ", 1)[0]
        arg = payload.get("arg") or (raw.lstrip("/").split(" ", 1)[1] if " " in raw.lstrip("/") else "")

        # Hard allowlist — commands that are safe to run server-side and
        # useful in the dashboard. Everything else is refused client-side.
        allowlist = {"help", "version", "commands", "profile", "bundles", "skills"}
        if name not in allowlist:
            self._json({"error": f"command /{name} not available in dashboard chat", "name": name}, 400)
            return

        try:
            agent_root = os.path.expanduser("~/.hermes/hermes-agent")
            if agent_root not in _sys.path:
                _sys.path.insert(0, agent_root)
            from hermes_cli.slash_exec import CommandContext, execute_command
            reply = execute_command(name, CommandContext(surface="gateway", options={"page_size": 40}))
            text = reply.text if hasattr(reply, "text") else str(reply)
            self._json({"ok": True, "name": name, "output": text})
        except LookupError:
            self._json({"ok": True, "name": name, "output": f"/{name}: not available in this build"}, 200)
        except Exception as e:
            self._json({"error": str(e), "name": name}, 500)

    def _exec_full_command(self) -> None:
        """POST /api/chat/command — run ANY slash command via the WS bridge.

        Body: {"command": "/cron list"} or {"name": "cron", "arg": "list"}
        Uses the native dashboard's JSON-RPC WebSocket (slash.exec first,
        command.dispatch fallback) so the full Hermes command surface works
        from the dashboard chat.
        """
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body or b"{}")
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return

        raw = payload.get("command") or ""
        name = payload.get("name") or raw.lstrip("/").split(" ", 1)[0]
        arg = payload.get("arg") or (raw.lstrip("/").split(" ", 1)[1] if " " in raw.lstrip("/") else "")
        # Session-scoped commands target the ACTUAL conversation's live agent
        # on the Hermes API server (:8642) — NOT the ws_bridge's throwaway
        # tui_gateway session. The old bridge routing silently dropped steers
        # (2026-08-16 orphan-session incident): /steer on a session with no
        # live agent fell back to a queue nobody drained, and the text was
        # never persisted. These endpoints call agent.steer()/interrupt()/goal
        # directly on the agent serving this session.
        session_id = payload.get("session_id") or ""
        if name == "live":
            # 2026-09-02 (unattached-run steer): does this session have a LIVE
            # run right now? The PWA probes this before sending so a message
            # typed into an unattached tab steers instead of queueing a second
            # turn. Resolution: active_runs.json (chat-stream proxy), then the
            # API's pollable run status (agent actually mid-turn).
            if not session_id:
                self._json({"ok": True, "name": "live", "live": False})
                return
            run_id = _get_active_run(session_id) or _get_active_run_by_any_key(session_id)
            if not run_id:
                # active_runs.json is proxy-stream-scoped; a run started by a
                # client that later disconnected may still be executing. Ask
                # the API's run status registry before answering "no".
                import urllib.request as _u
                api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:18642")
                api_key = os.environ.get("API_SERVER_KEY", "")
                try:
                    req = _u.Request(f"{api}/api/runs/live", headers=(
                        {"Authorization": f"Bearer {api_key}"} if api_key else {}))
                    with _u.urlopen(req, timeout=6) as resp:
                        data = _json.loads(resp.read() or b"{}")
                    for r in (data.get("runs") or []):
                        if (r.get("session_id") in (session_id, payload.get("session_id"))
                                and r.get("status") == "running"):
                            import time as _time
                            if _time.time() - float(r.get("updated_at", 0) or 0) < 900:
                                self._json({"ok": True, "name": "live", "live": True, "run_id": r.get("run_id")})
                                return
                except Exception:
                    pass
                self._json({"ok": True, "name": "live", "live": False})
                return
            self._json({"ok": True, "name": "live", "live": True, "run_id": run_id})
            return
        if name == "steer" and session_id:
            self._json({"ok": True, "name": "steer", "output": self._session_steer(session_id, arg)})
            return
        if name in ("stop", "interrupt") and session_id:
            self._json({"ok": True, "name": name, "output": self._session_stop(session_id)})
            return
        if name == "goal" and session_id:
            self._json({"ok": True, "name": "goal", "output": self._session_goal(session_id, arg)})
            return

        # Confirmation gate: destructive/lifecycle commands need a second,
        # explicit confirm (Discord-style) — typing `/restart confirm` (or
        # `/update confirm`) is the confirmation. A bare command only
        # explains what will happen.
        first_arg = arg.split()[0] if arg else ""
        if name in ("restart", "update") and first_arg != "confirm":
            what = "restart the Hermes gateway" if name == "restart" else "pull latest Hermes and restart the gateway"
            self._json({
                "ok": True,
                "name": name,
                "requires_confirm": True,
                "preview": f"⚠️ This will {what}. Your chat will disconnect and reconnect.",
                "instructions": f"Type `/{name} confirm` to execute, or anything else to cancel.",
            })
            return

        # Destructive / gateway-lifecycle commands — now with confirmation
        # handled above. Only /yolo and /approvals stay hard-blocked (config
        # mutation with no chat-visible effect).
        blocked = {"yolo", "approvals"}
        if name in blocked:
            self._json({
                "ok": True,
                "output": f"/{name} is blocked from the dashboard chat for safety — run it in a terminal or Discord.",
            })
            return

        # Read-only dashboard commands run server-side, backed by real data
        # (no WS bridge, no orphan-session confusion). Unhandled names return
        # "" and fall through to the bridge below. _RESPONDED means the
        # handler already wrote a response (async lifecycle ops).
        local_out = self._exec_dashboard_command(name, arg)
        if local_out is _RESPONDED:
            return
        if local_out:
            self._json({"ok": True, "name": name, "output": local_out, "via": "server"})
            return

        try:
            import ws_bridge
            bridge = ws_bridge.get_bridge()
            # Wait up to ~8s for the bridge to connect (login → ticket → WS).
            for _ in range(16):
                if bridge._ws is not None:
                    break
                time.sleep(0.5)
            # Try slash.exec first (covers registry + worker-routed commands).
            try:
                result = bridge.slash_exec(f"{name} {arg}".strip(), session_id)
                output = result.get("output") if isinstance(result, dict) else str(result)
                if output:
                    self._json({"ok": True, "name": name, "output": output, "via": "slash.exec"})
                    return
            except Exception as exc:
                # Fall through to command.dispatch for quick/plugin commands.
                pass
            try:
                result = bridge.command_dispatch(name, arg, session_id)
                if isinstance(result, dict) and result.get("type") in ("exec", "plugin"):
                    self._json({"ok": True, "name": name, "output": result.get("output", ""), "via": "command.dispatch"})
                    return
                self._json({"ok": True, "name": name, "output": json.dumps(result, default=str), "via": "command.dispatch"})
                return
            except Exception as exc:
                self._json({"error": str(exc), "name": name}, 502)
        except Exception as exc:
            self._json({"error": str(exc), "name": name}, 500)

    def _browser_shot(self) -> None:
        """GET /api/browser/shot — live MJPEG stream of the headed browser.

        multipart/x-mixed-replace: every CDP screencast frame is written as
        a boundary-delimited JPEG. The browser <img> plays it directly —
        no polling, no per-frame fetch, no bloat.
        """
        try:
            import cdp_view
            bcast = cdp_view.get_broadcaster()
            sid, q = bcast.subscribe()
        except Exception as e:
            self._json({"error": str(e)}, 500)
            return

        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            # Wait up to ~8s for the first frame (browser may be cold).
            first = None
            deadline = time.time() + 8
            while time.time() < deadline:
                try:
                    first = q.get(timeout=1)
                    break
                except queue.Empty:
                    continue
            if not first:
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 0\r\n\r\n")
                return
            self._write_frame(first)
            while True:
                try:
                    jpg = q.get(timeout=10)
                    self._write_frame(jpg)
                except queue.Empty:
                    # keepalive comment frame so proxies don't drop the stream
                    self.wfile.write(b"--frame\r\nContent-Type: text/plain\r\n\r\n.\r\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            bcast.unsubscribe(sid)

    def _write_frame(self, jpg: bytes) -> None:
        self.wfile.write(b"--frame\r\n")
        self.wfile.write(b"Content-Type: image/jpeg\r\n")
        self.wfile.write(f"Content-Length: {len(jpg)}\r\n\r\n".encode())
        self.wfile.write(jpg)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def do_PATCH(self) -> None:
        if not self._authorized():
            self._json({"error": "unauthorized"}, 401)
            return
        """Forward PATCH to the Hermes API — session title updates etc."""
        try:
            path = self.path.split("?")[0]
            if path.startswith("/api/sessions"):
                import urllib.request as u
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length else b"{}"
                api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
                api_key = os.environ.get("API_SERVER_KEY", "")
                headers = {"Content-Type": "application/json"}
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                req = u.Request(f"{api}{self.path}", data=body, headers=headers, method="PATCH")
                with u.urlopen(req, timeout=30) as resp:
                    data = resp.read()
                    ctype = resp.headers.get("Content-Type", "application/json")
                self.send_response(resp.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.end_headers()
                self.wfile.write(data)
                return
            self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def do_DELETE(self) -> None:
        if not self._authorized():
            self._json({"error": "unauthorized"}, 401)
            return
        """Forward DELETE to the Hermes API — session deletion."""
        try:
            path = self.path.split("?")[0]
            if path.startswith("/api/sessions"):
                import urllib.request as u
                api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
                api_key = os.environ.get("API_SERVER_KEY", "")
                headers = {}
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                req = u.Request(f"{api}{self.path}", headers=headers, method="DELETE")
                with u.urlopen(req, timeout=30) as resp:
                    data = resp.read()
                    ctype = resp.headers.get("Content-Type", "application/json")
                self.send_response(resp.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.end_headers()
                self.wfile.write(data)
                return
            self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def _start_tracked_run(self) -> None:
        """Start a run via POST /v1/runs, then subscribe to its event stream
        and record any approval.request into the local store."""
        import threading
        import urllib.request as u
        import urllib.error

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"

        api = _api_base()
        headers = _api_headers()
        try:
            req = u.Request(f"{api}/v1/runs", data=body, headers=headers)
            with u.urlopen(req, timeout=30) as resp:
                data = resp.read()
            ctype = resp.headers.get("Content-Type", "application/json")
            self.send_response(resp.status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json({"error": str(e)}, 502)
            return

        # Parse run_id from the response; if missing, nothing to track.
        try:
            run_id = json.loads(data).get("run_id")
        except Exception:
            run_id = None
        if not run_id:
            return

        def _watch() -> None:
            """SSE-subscribe to the run and persist approval.request events."""
            import urllib.request as uu
            try:
                req = uu.Request(f"{api}/v1/runs/{run_id}/events", headers=headers)
                with uu.urlopen(req, timeout=300) as resp:
                    buf = b""
                    while True:
                        chunk = resp.read(2048)
                        if not chunk:
                            break
                        buf += chunk
                        while b"\n\n" in buf:
                            frame, buf = buf.split(b"\n\n", 1)
                            text = frame.decode(errors="replace")
                            data_line = None
                            event_line = None
                            for line in text.split("\n"):
                                if line.startswith("data:"):
                                    data_line = line[5:].strip()
                                elif line.startswith("event:"):
                                    event_line = line[6:].strip()
                            if not data_line:
                                continue
                            try:
                                ev = json.loads(data_line)
                            except Exception:
                                continue
                            if ev.get("event") == "approval.request" or event_line == "approval.request":
                                save_approval({
                                    "run_id": run_id,
                                    "status": "pending",
                                    "command": ev.get("command", ""),
                                    "what": ev.get("command", ""),
                                    "why": ev.get("reason", ev.get("detail", "Dangerous command requires approval")),
                                    "risk": "high" if ev.get("risk") == "high" else "medium",
                                    "choices": ev.get("choices", ["once", "session", "always", "deny"]),
                                    "created_at": datetime.now(SAST).isoformat(),
                                })
                                # Push a notification so the phone pings even
                                # when the dashboard isn't open.
                                try:
                                    push.send_notification(
                                        "⚠️ Approval needed",
                                        f"{ev.get('command', 'Dangerous command')[:120]} — tap to approve or deny",
                                        url="/approvals",
                                        tag=f"approval-{run_id}",
                                    )
                                except Exception as pe:
                                    print(f"[state-server] push error: {pe}", flush=True)
                            elif ev.get("event") in ("run.completed", "run.cancelled", "run.failed"):
                                # Mark any pending approval for this run resolved.
                                entries = load_approvals()
                                for e in entries:
                                    if e.get("run_id") == run_id and e.get("status") == "pending":
                                        e["status"] = "resolved"
                                        e["resolved_at"] = datetime.now(SAST).isoformat()
                                APPROVALS.write_text(json.dumps(entries[:200], indent=1))
                                break
            except Exception as e:
                print(f"[state-server] run watcher error for {run_id}: {e}", flush=True)

        threading.Thread(target=_watch, daemon=True).start()

    def _push_subscribe(self) -> None:
        """Store a browser push subscription (PushManager.subscribe payload)."""
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            sub = json.loads(body)
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return
        if not sub.get("endpoint") or not sub.get("keys"):
            self._json({"error": "endpoint and keys required"}, 400)
            return
        count = push.subscribe(sub)
        self._json({"ok": True, "subscriptions": count})

    def _push_unsubscribe(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return
        endpoint = data.get("endpoint", "")
        if not endpoint:
            self._json({"error": "endpoint required"}, 400)
            return
        count = push.unsubscribe(endpoint)
        self._json({"ok": True, "subscriptions": count})

    def _push_test(self) -> None:
        """Send a test notification to all subscriptions."""
        result = push.send_notification(
            "🔔 Hermes OS",
            "Push notifications are live — approvals and failed crons will ping you here.",
            url="/approvals",
            tag="hermes-test",
        )
        self._json(result)

    def _push_watch(self) -> None:
        """Watch one Hermes run and push its finished reply while the PWA is away."""
        import re
        import urllib.request as u

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return

        run_id = str(data.get("run_id") or "").strip()
        session_id = str(data.get("session_id") or "").strip()
        title = str(data.get("title") or "Hermes replied").strip()[:80]
        url = str(data.get("url") or "/chat").strip()
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{6,160}", run_id) or not session_id:
            self._json({"error": "valid run_id and session_id required"}, 400)
            return
        if not url.startswith("/") or url.startswith("//"):
            url = "/chat"

        try:
            seen = set(json.loads(CHAT_PUSH_SEEN.read_text())) if CHAT_PUSH_SEEN.exists() else set()
        except Exception:
            seen = set()
        with _CHAT_PUSH_LOCK:
            if run_id in seen or run_id in _CHAT_PUSH_WATCHING:
                self._json({"ok": True, "watching": False, "deduplicated": True})
                return
            _CHAT_PUSH_WATCHING.add(run_id)

        api = _api_base()
        headers = _api_headers()
        # Preserve the caller's mirror prefix (/p/<profile>/… when multiplexed)
        # so the watcher polls the same profile that owns the session. self.path
        # here is the full state-server path (minus query); everything after
        # "/api/push/watch" belongs to the profile mirror, so the prefix is
        # simply whatever precedes "/api/push/watch".
        mirror_prefix = ""
        watch_path_idx = self.path.find("/api/push/watch")
        if watch_path_idx > 0:
            mirror_prefix = self.path[:watch_path_idx]

        def _fetch_recent_messages() -> list[dict]:
            poll_req = u.Request(
                f"{api}{mirror_prefix}/api/sessions/{session_id}/messages?limit=10",
                headers=headers,
            )
            with u.urlopen(poll_req, timeout=15) as poll_resp:
                payload = json.loads(poll_resp.read().decode(errors="replace"))
            rows = payload.get("data") if isinstance(payload, dict) else payload
            return rows if isinstance(rows, list) else []

        def _watch_completion() -> None:
            # Session-chat streams (POST /api/sessions/{id}/chat/stream — the
            # primary Chat + Voice path) never register in the Hermes API's
            # /v1/runs event registry, so GET /v1/runs/{run_id}/events returns
            # run_not_found for them (verified live 2026-08-27). Instead of
            # subscribing to a stream that may never exist, poll the session's
            # persisted messages for a terminal assistant row that arrived
            # after registration. finish_reason 'stop' marks the final turn
            # row; 'tool_calls' rows are intermediate tool-loop rows.
            baseline_ts = 0.0
            try:
                for row in _fetch_recent_messages():
                    try:
                        ts = float(row.get("timestamp") or 0)
                    except (TypeError, ValueError):
                        continue
                    baseline_ts = max(baseline_ts, ts)
            except Exception:
                baseline_ts = 0.0
            # 3s grace: a run that finishes between registration and this
            # baseline fetch would otherwise swallow its own completion row.
            baseline_ts = max(0.0, baseline_ts - 3.0)

            final_text = ""
            deadline = time.time() + 1800  # 30 min cap, 5s poll
            while time.time() < deadline:
                time.sleep(5)
                try:
                    rows = _fetch_recent_messages()
                except Exception:
                    continue
                for row in rows:
                    if row.get("role") != "assistant":
                        continue
                    if row.get("finish_reason") not in ("stop", "length", "content_filter"):
                        continue
                    try:
                        ts = float(row.get("timestamp") or 0)
                    except (TypeError, ValueError):
                        continue
                    if ts <= baseline_ts:
                        continue
                    content = row.get("content")
                    if isinstance(content, str) and content.strip():
                        final_text = content
                        break
                if final_text:
                    break

            if final_text:
                preview = " ".join(final_text.replace("\n", " ").split())
                body_text = preview[:180] if preview else "Your response is ready — tap to open the conversation."
                push.send_notification(
                    title,
                    body_text,
                    url=url,
                    tag=f"chat-complete-{run_id}",
                    only_when_away=True,
                )
                with _CHAT_PUSH_LOCK:
                    try:
                        persisted = set(json.loads(CHAT_PUSH_SEEN.read_text())) if CHAT_PUSH_SEEN.exists() else set()
                    except Exception:
                        persisted = set()
                    persisted.add(run_id)
                    CHAT_PUSH_SEEN.write_text(json.dumps(sorted(persisted)[-2000:], indent=1), encoding="utf-8")
            else:
                print(f"[state-server] chat push watcher ended without completion for {run_id}", flush=True)
            with _CHAT_PUSH_LOCK:
                _CHAT_PUSH_WATCHING.discard(run_id)

        threading.Thread(target=_watch_completion, daemon=True).start()
        self._json({"ok": True, "watching": True, "run_id": run_id})

    def _content_status(self) -> None:
        """Update a content card's status (writes vault frontmatter)."""
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return
        file = data.get("file", "")
        status = data.get("status", "")
        if not file or status not in ("idea", "drafted", "approved", "scheduled", "posted", "rejected"):
            self._json({"error": "file and valid status required"}, 400)
            return
        result = update_content_status(file, status)
        if "error" in result:
            self._json(result, 400)
            return
        self._json(result)

    def _proxy_api_stream(self, path: str, stream: bool = False) -> None:
        """Forward a request to the Hermes API (:8642).

        When ``stream`` is True (SSE chat), write chunks as they arrive so the
        client sees tokens/thinking in real time instead of one buffered blob.

        Uses http.client with a read budget LONGER than the API server's SSE
        keepalive interval (30s) — a shorter timeout fires mid-silence, and
        after the first socket timeout http.client's connection is never
        healthy again: the next read raises a fatal error, the proxy closes,
        and the API server reads that as "client disconnected" and INTERRUPTS
        the live run (2026-08-28: every stream died at ~T+22s with 1 keepalive).
        timeout=45 > keepalive 30 means the timeout path is only reachable
        when the upstream is truly gone.
        """
        import http.client as _hc
        from urllib.parse import urlsplit

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"

        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        parts = urlsplit(api)
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            conn = _hc.HTTPConnection(parts.hostname, parts.port, timeout=45)
            conn.request("POST", path, body=body, headers=headers)
            resp = conn.getresponse()
            ctype = resp.headers.get("Content-Type", "application/json")
            self.send_response(resp.status)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.send_header("Cache-Control", "no-cache")
            if stream:
                # SSE: no Content-Length, chunked transfer. read1() returns
                # whatever bytes are available RIGHT NOW instead of blocking
                # to fill the buffer (the "shimmer then full response" bug).
                # Also: track session -> run_id in active_runs.json so a NEW
                # device can reattach via /api/sessions/{id}/events (which
                # tails the real /v1/runs/{run_id}/events upstream).
                import socket as _socket

                # session_id from path: /api/sessions/{id}/chat/stream
                path_parts = path.split("/")
                session_for_run = path_parts[3] if len(path_parts) > 3 else ""
                seen_done = False
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    try:
                        chunk = resp.read1(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        if session_for_run:
                            # run.started frame carries "run_id": "run_..."
                            m = re.search(rb'"run_id":\s*"(run_[0-9a-f]+)"', chunk)
                            if m:
                                _set_active_run(session_for_run, m.group(1).decode())
                            else:
                                # 2026-09-02 FIX (tracker miss): the run_id can
                                # sit in the SAME chunk as any other frame —
                                # the API server wraps run_id into EVERY event
                                # payload, and SSE frames can straddle 4096-
                                # byte read boundaries. Keep a rolling tail so
                                # a run_id split across chunks still matches;
                                # without this, active_runs.json stays empty
                                # and steer/stop/reattach all report
                                # "no_active_run" while the run is live.
                                if not getattr(self, "_rr_tail", None):
                                    self._rr_tail = b""
                                scan = self._rr_tail + chunk
                                m2 = re.search(rb'"run_id":\s*"(run_[0-9a-f]+)"', scan)
                                if m2:
                                    _set_active_run(session_for_run, m2.group(1).decode())
                                    self._rr_tail = b""
                                else:
                                    self._rr_tail = scan[-512:]
                            if b"event: run.completed" in chunk or b"event: done" in chunk:
                                _clear_active_run(session_for_run)
                                seen_done = True
                    except _socket.timeout:
                        # Quiet upstream: heartbeat so proxies + browser
                        # keepalive and never see a dead-looking connection.
                        try:
                            self.wfile.write(b": keepalive\n\n")
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    except Exception:
                        # http.client connections don't recover from read
                        # errors — close cleanly instead of 502-after-headers.
                        break
                try:
                    conn.close()
                except Exception:
                    pass
            else:
                data = resp.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                try:
                    conn.close()
                except Exception:
                    pass
        except Exception as e:
            # Connection-level failure BEFORE headers went out.
            try:
                self._json({"error": str(e)}, 502)
            except Exception:
                pass

    def log_message(self, format: str, *args):
        sys.stderr.write(f"[state-server {datetime.now(SAST).isoformat()}] {format % args}\n")


def main():
    # Bind 0.0.0.0 so the Tailscale funnel (running on the Windows host) can
    # reach us via the WSL IP. Requests are bearer-token-gated; this is the
    # same exposure class as the dashboard on 0.0.0.0:9119.
    bind_host = os.environ.get("STATE_HOST", "0.0.0.0")
    server = ThreadingHTTPServer((bind_host, PORT), Handler)
    print(f"state server on {bind_host}:{PORT} (SAST {datetime.now(SAST).isoformat()})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
