#!/usr/bin/env python3
"""Hermes OS v2 — Live State Server

Serves real Hermes local state over HTTP so the Vercel-hosted dashboard can
show live data on the phone (via the ngrok tunnel) without needing Turso.

Endpoints (all read-only, local files only):
  GET /api/crons     -> jobs.json
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
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import push  # noqa: E402

SAST = timezone(timedelta(hours=2))
HERMES = Path(os.path.expanduser("~/.hermes"))
JOBS = HERMES / "cron" / "jobs.json"
EXEC = HERMES / "cron" / "executions.db"
STATE = HERMES / "state.db"
APPROVALS = HERMES / "approvals.json"
GATEWAY_STATE = HERMES / "gateway_state.json"
CHANNEL_DIR = HERMES / "channel_directory.json"
VAULT_CONTENT = Path("/mnt/c/Users/pilla/Vault/second-brain/Content")
VAULT_ROOT = Path("/mnt/c/Users/pilla/Vault/second-brain")
MEMORY_DIR = HERMES / "memories"
PORT = int(os.environ.get("STATE_PORT", "8645"))
BRIDGE_TOKEN = os.environ.get("STATE_BRIDGE_TOKEN", "")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://hermes-mission-control-v2.vercel.app")


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
        return self.headers.get("X-Bridge-Token", "") == BRIDGE_TOKEN

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
            elif path == "/api/runs":
                self._json({"runs": load_runs(), "source": "local"})
            elif path == "/api/profiles":
                self._json({"profiles": load_profiles(), "source": "local"})
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
            elif path == "/api/push/status":
                self._json({"enabled": push.available(), "subscriptions": len(push._load_subs())})
            elif path == "/v1/models":
                self._proxy_api_get(path)
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
        """Forward a GET to the Hermes API (:8642) with chunked SSE streaming
        (used by /api/sessions/{id}/events reattach).

        Uses a short socket timeout so quiet reasoning stretches (no bytes for
        a while) never kill the reattach stream: on every socket timeout we
        write an SSE keepalive comment frame — which keeps Vercel/ngrok and
        the browser's fetch from idling out — then keep reading. The stream
        only ends when the upstream actually closes.
        """
        import socket as _socket
        import urllib.request as u
        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = u.Request(f"{api}{self.path}", headers=headers)
        try:
            # 15s socket read budget: long enough to not spam, short enough
            # that a healthy upstream that is quiet >15s gets a keepalive.
            with u.urlopen(req, timeout=15) as resp:
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "text/event-stream")
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.end_headers()
                while True:
                    try:
                        # read1() returns whatever bytes are available RIGHT
                        # NOW instead of blocking to fill 4096 — sparse SSE
                        # frames (reasoning deltas, tool.completed) flush to
                        # the client immediately instead of buffering up to
                        # the 15s socket budget. Same fix as the chat-stream
                        # path (line ~1365).
                        chunk = resp.read1(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
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
            self._json({"error": str(e)}, 502)

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
        """Call a session-scoped control endpoint on the Hermes API (:8642).

        These hit the API server's /api/sessions/{id}/steer|stop|goal routes,
        which operate on the ACTUAL conversation's live agent — never the
        ws_bridge's throwaway tui_gateway session.
        """
        import urllib.request as u
        import json as _json
        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if action == "steer":
            body = _json.dumps({"text": arg}).encode()
        elif action == "stop":
            body = b"{}"
        elif action == "goal":
            body = _json.dumps({"arg": arg}).encode()
        else:
            return {"ok": False, "error": f"unknown action {action}"}
        req = u.Request(
            f"{api}/api/sessions/{session_id}/{action}",
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with u.urlopen(req, timeout=20) as resp:
                data = _json.loads(resp.read() or b"{}")
            return data
        except u.HTTPError as e:
            try:
                err_data = _json.loads(e.read() or b"{}")
            except Exception:
                err_data = {}
            return {"ok": False, "error": str(e), **err_data}
        except Exception as e:
            return {"ok": False, "error": str(e)}

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
                self._proxy_api_stream(full_path, stream=full_path.endswith("/chat/stream"))
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

    def _exec_dashboard_command(self, name: str, arg: str) -> str:
        """Run a read-only dashboard command server-side, backed by real data.

        These run in the state server process (same venv/machine as the
        gateway) — no WS bridge, no orphan session, no error bubbles. Covers
        the commands the picker surfaces that have no registry executor.
        """
        import json as _json
        import sqlite3 as _sqlite3

        home = os.path.expanduser("~/.hermes")

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

        if name == "memory" and arg.split()[0] in ("pending",):
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

        return ""  # not handled — caller falls back to bridge

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
        if name == "steer" and session_id:
            self._json({"ok": True, "name": "steer", "output": self._session_steer(session_id, arg)})
            return
        if name in ("stop", "interrupt") and session_id:
            self._json({"ok": True, "name": name, "output": self._session_stop(session_id)})
            return
        if name == "goal" and session_id:
            self._json({"ok": True, "name": "goal", "output": self._session_goal(session_id, arg)})
            return

        # Destructive / gateway-lifecycle commands are refused from the
        # dashboard — they need a real terminal (Hermes blocks them from
        # inside the gateway process tree anyway).
        blocked = {"restart", "update", "stop", "platform", "yolo", "approvals", "debug"}
        if name in blocked:
            self._json({
                "ok": True,
                "output": f"/{name} is blocked from the dashboard chat for safety — run it in a terminal or Discord.",
            })
            return

        # Read-only dashboard commands run server-side, backed by real data
        # (no WS bridge, no orphan-session confusion). Unhandled names return
        # "" and fall through to the bridge below.
        local_out = self._exec_dashboard_command(name, arg)
        if local_out:
            self._json({"ok": True, "name": name, "output": local_out, "via": "server"})
            return
        if local_out == "":  # explicitly handled but empty? treat as handled-no-op
            pass

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
        """
        import urllib.request as u
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"

        api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        api_key = os.environ.get("API_SERVER_KEY", "")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = u.Request(f"{api}{path}", data=body, headers=headers)
        # 15s socket read budget (see keepalive loop below) — a quiet
        # upstream gets a heartbeat every ~15s so the stream never looks dead.
        with u.urlopen(req, timeout=15) as resp:
            ctype = resp.headers.get("Content-Type", "application/json")
            self.send_response(resp.status)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.send_header("Cache-Control", "no-cache")
            if stream:
                # SSE: no Content-Length, chunked transfer. Use read1() so we
                # return whatever bytes are available RIGHT NOW instead of
                # blocking until the 4096-byte buffer fills (read() blocks to
                # fill amt, which buffers small SSE events until the stream
                # ends — the "shimmer then full response" bug).
                # 15s socket budget + keepalive: a long quiet reasoning stretch
                # must not look dead to Vercel/ngrok/browser.
                import socket as _socket
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    try:
                        chunk = resp.read1(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except _socket.timeout:
                        try:
                            self.wfile.write(b": keepalive\n\n")
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                    except (BrokenPipeError, ConnectionResetError):
                        break
            else:
                data = resp.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

    def log_message(self, format: str, *args):
        sys.stderr.write(f"[state-server {datetime.now(SAST).isoformat()}] {format % args}\n")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"state server on :{PORT} (SAST {datetime.now(SAST).isoformat()})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
