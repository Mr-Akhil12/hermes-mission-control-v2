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


def load_sessions(limit: int = 25) -> list[dict]:
    if not STATE.exists():
        return []
    con = sqlite3.connect(STATE)
    rows = con.execute(
        "SELECT id, source, title, started_at, ended_at, end_reason, message_count, tool_call_count "
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
                "last_message": last,
            }
        )
    con.close()
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
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            path = self.path.split("?")[0]
            # Proxy the native Hermes dashboard (:9119) so the iframe can load
            # it over HTTPS (mixed-content safe) through the tunnel.
            if path.startswith("/native/"):
                self._proxy_native(path)
                return
            # Session sub-endpoints (messages, chat) come from the Hermes API
            # so the chat page gets real persisted conversation history.
            # Exact /api/sessions stays local (existing Sessions page shape).
            if path.startswith("/api/sessions/") and path != "/api/sessions":
                self._proxy_api_get(path)
                return
            if path == "/api/crons":
                self._json({"jobs": load_crons(), "source": "local"})
            elif path == "/api/runs":
                self._json({"runs": load_runs(), "source": "local"})
            elif path == "/api/sessions":
                limit = 25
                try:
                    q = self.path.split("?", 1)[1]
                    limit = min(int(dict(kv.split("=") for kv in q.split("&") if "=" in kv).get("limit", 25)), 100)
                except Exception:
                    limit = 25
                self._json({"sessions": load_sessions(limit), "source": "local"})
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
            elif path == "/api/health":
                self._json({"ok": True, "time": datetime.now(SAST).isoformat(), "port": PORT})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

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
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def _proxy_native(self, path: str) -> None:
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
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def do_POST(self):
        """Proxy chat completions + session endpoints + run starts to the
        local Hermes API (:8642) so one ngrok tunnel serves live state, chat,
        streaming, and approvals."""
        try:
            path = self.path.split("?")[0]
            # Session endpoints: create, chat, chat/stream, fork
            if path.startswith("/api/sessions"):
                self._proxy_api_stream(path, stream=path.endswith("/chat/stream"))
                return
            # Run approval resolution: POST /v1/runs/{run_id}/approval
            if "/v1/runs/" in path and path.endswith("/approval"):
                self._proxy_api_stream(path, stream=False)
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
            if path not in ("/v1/chat/completions", "/api/chat"):
                self._json({"error": "not found"}, 404)
                return
            self._proxy_api_stream(path, stream=False)
        except Exception as e:
            self._json({"error": str(e)}, 502)

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
        session_id = payload.get("session_id") or ""

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

    def do_PATCH(self) -> None:
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
                self.send_header("Access-Control-Allow-Origin", "*")
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
            self.send_header("Access-Control-Allow-Origin", "*")
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
        with u.urlopen(req, timeout=300) as resp:
            ctype = resp.headers.get("Content-Type", "application/json")
            self.send_response(resp.status)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            if stream:
                # SSE: no Content-Length, chunked transfer. Use read1() so we
                # return whatever bytes are available RIGHT NOW instead of
                # blocking until the 4096-byte buffer fills (read() blocks to
                # fill amt, which buffers small SSE events until the stream
                # ends — the "shimmer then full response" bug).
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    chunk = resp.read1(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            else:
                data = resp.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

    def log_message(self, format: str, *args):
        sys.stderr.write(f"[state-server {datetime.now(SAST).isoformat()}] {format % args}\n")


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"state server on :{PORT} (SAST {datetime.now(SAST).isoformat()})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
