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
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SAST = timezone(timedelta(hours=2))
HERMES = Path(os.path.expanduser("~/.hermes"))
JOBS = HERMES / "cron" / "jobs.json"
EXEC = HERMES / "cron" / "executions.db"
STATE = HERMES / "state.db"
PORT = int(os.environ.get("STATE_PORT", "8645"))


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
            elif path == "/api/health":
                self._json({"ok": True, "time": datetime.now(SAST).isoformat(), "port": PORT})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

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
        """Proxy chat completions to the local Hermes API (:8642) so one
        ngrok tunnel serves both live state and chat on the phone."""
        try:
            path = self.path.split("?")[0]
            if path not in ("/v1/chat/completions", "/api/chat"):
                self._json({"error": "not found"}, 404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"

            api = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
            api_key = os.environ.get("API_SERVER_KEY", "")
            import urllib.request as u
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            req = u.Request(f"{api}/v1/chat/completions", data=body, headers=headers)
            with u.urlopen(req, timeout=120) as resp:
                data = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json({"error": str(e)}, 502)

    def log_message(self, format: str, *args):
        sys.stderr.write(f"[state-server {datetime.now(SAST).isoformat()}] {format % args}\n")


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"state server on :{PORT} (SAST {datetime.now(SAST).isoformat()})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
