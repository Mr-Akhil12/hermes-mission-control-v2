#!/usr/bin/env python3
"""Hermes OS v2 — Local Bridge (Python, systemd)

The bridge is the local worker that connects the cloud shell (Turso) to the
Hermes core. It runs on the WSL machine where Hermes lives.

Jobs:
1. Poll the Turso `tasks` queue → run Hermes CLI → write result back.
2. Mirror native :9119 state (crons, approvals, sessions, channels, cron_runs)
   to Turso `sync_cache` every 30s so the PWA works when the tunnel is down.
3. Generate the Daily Brief each morning and store it in `briefs`.

Phase 1: local-only mode (reads local files, no Turso writes) so the dashboard
works immediately; Turso hooks activate when TURSO_URL/TURSO_TOKEN are set.
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SAST = timezone(timedelta(hours=2))
HERMES = Path(os.path.expanduser("~/.hermes"))
JOBS = HERMES / "cron" / "jobs.json"
EXEC = HERMES / "cron" / "executions.db"
STATE = HERMES / "state.db"

TURSO_URL = os.environ.get("TURSO_URL", "")
TURSO_TOKEN = os.environ.get("TURSO_TOKEN", "")
NATIVE_URL = os.environ.get("NATIVE_URL", "http://127.0.0.1:9119")
API_URL = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")


def log(msg: str) -> None:
    print(f"[bridge {datetime.now(SAST).isoformat()}] {msg}", flush=True)


def turso_enabled() -> bool:
    return bool(TURSO_URL and TURSO_TOKEN)


def _typed_args(params: list | None) -> list[dict]:
    """Convert plain Python values to Turso v2 typed args."""
    out = []
    for p in params or []:
        if p is None:
            out.append({"type": "null", "value": None})
        elif isinstance(p, bool):
            out.append({"type": "integer", "value": "1" if p else "0"})
        elif isinstance(p, int):
            out.append({"type": "integer", "value": str(p)})
        elif isinstance(p, float):
            out.append({"type": "float", "value": str(p)})
        else:
            out.append({"type": "text", "value": str(p)})
    return out


def turso_query(sql: str, params: list | None = None) -> list[dict]:
    """Execute a read query against Turso HTTP API (v2 pipeline format)."""
    if not turso_enabled():
        return []
    body = json.dumps({
        "requests": [{"type": "execute", "stmt": {"sql": sql, "args": _typed_args(params)}}]
    }).encode()
    req = urllib.request.Request(
        f"{TURSO_URL}/v2/pipeline",
        data=body,
        headers={"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    rows = []
    for result in data.get("results", []):
        if result.get("type") != "ok":
            continue
        resp = result.get("response", {})
        if resp.get("type") != "execute":
            continue
        res = resp.get("result", {})
        cols = [c["name"] for c in res.get("cols", [])]
        for row in res.get("rows", []):
            rows.append({c: v.get("value") for c, v in zip(cols, row)})
    return rows


def turso_execute(sql: str, params: list | None = None) -> None:
    """Execute a write statement against Turso HTTP API (v2 pipeline format)."""
    if not turso_enabled():
        return
    body = json.dumps({
        "requests": [{"type": "execute", "stmt": {"sql": sql, "args": _typed_args(params)}}]
    }).encode()
    req = urllib.request.Request(
        f"{TURSO_URL}/v2/pipeline",
        data=body,
        headers={"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


# ── 1. Mirror native state ────────────────────────────────────────────

def mirror_state() -> None:
    """Mirror :9119 + local cron state into Turso sync_cache (or print when local-only)."""
    state: dict[str, object] = {}

    # Local cron jobs + executions
    if JOBS.exists():
        state["crons"] = json.loads(JOBS.read_text())
    if EXEC.exists():
        con = sqlite3.connect(EXEC)
        rows = con.execute(
            "SELECT job_id, status, claimed_at, finished_at, error FROM executions "
            "WHERE claimed_at > datetime('now','-25 hours') ORDER BY claimed_at DESC LIMIT 1000"
        ).fetchall()
        con.close()
        state["cron_runs"] = [
            {"job_id": r[0], "status": r[1], "claimed_at": r[2], "finished_at": r[3], "error": r[4]}
            for r in rows
        ]

    if turso_enabled():
        for key, payload in state.items():
            turso_execute(
                "INSERT INTO sync_cache (key, payload, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
                [key, json.dumps(payload), datetime.now(SAST).isoformat()],
            )
        log(f"mirrored {list(state.keys())} → Turso")
    else:
        log(f"local-only mode — would mirror {list(state.keys())}")


# ── 2. Poll task queue → run Hermes ──────────────────────────────────

def poll_tasks(once: bool = False) -> None:
    """Poll Turso tasks queue; run each queued task via Hermes API."""
    if not turso_enabled():
        log("local-only mode — no task queue to poll")
        return

    tasks = turso_query(
        "SELECT id, prompt, profile FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 5"
    )
    for task in tasks:
        task_id = task["id"]
        turso_execute("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?",
                      [datetime.now(SAST).isoformat(), task_id])
        log(f"running task {task_id}: {task['prompt'][:80]}")

        profile = task.get("profile") or "default"
        body = json.dumps({
            "model": os.environ.get("HERMES_API_MODEL", "deepseek-v4-flash:0731"),
            "messages": [{"role": "user", "content": f"[dispatch:{profile}] {task['prompt']}"}],
            "stream": False,
        }).encode()
        req = urllib.request.Request(
            f"{API_URL}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            result = data["choices"][0]["message"]["content"]
            turso_execute(
                "UPDATE tasks SET status = 'done', result = ?, finished_at = ? WHERE id = ?",
                [result, datetime.now(SAST).isoformat(), task_id],
            )
            log(f"task {task_id} done")
        except Exception as e:
            turso_execute(
                "UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
                [str(e)[:500], datetime.now(SAST).isoformat(), task_id],
            )
            log(f"task {task_id} failed: {e}")

        if once:
            break


# ── 3. Daily brief ────────────────────────────────────────────────────

def generate_brief() -> None:
    """Collect failed crons, stopped sessions, approvals → write a brief."""
    brief: dict[str, object] = {"attention": [], "shipped": [], "next_actions": [], "one_thing": None}

    if JOBS.exists():
        jobs = json.loads(JOBS.read_text())
        jobs_list = jobs if isinstance(jobs, list) else jobs.get("jobs", [])
        failed = [j for j in jobs_list if j.get("last_status") == "error"]
        brief["attention"] = [{"type": "failed_cron", "name": j.get("name"), "id": j.get("id")} for j in failed]
        brief["one_thing"] = f"Review {len(failed)} failed cron(s)" if failed else None

    if turso_enabled():
        turso_execute(
            "INSERT INTO briefs (id, date, content, created_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET content = excluded.content, created_at = excluded.created_at",
            [
                datetime.now(SAST).strftime("%Y-%m-%d"),
                datetime.now(SAST).strftime("%Y-%m-%d"),
                json.dumps(brief),
                datetime.now(SAST).isoformat(),
            ],
        )
        log("brief generated → Turso")
    else:
        log(f"local-only mode — brief would be: {json.dumps(brief)[:200]}")


# ── Main ──────────────────────────────────────────────────────────────

def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "loop"
    if mode == "mirror":
        mirror_state()
    elif mode == "brief":
        generate_brief()
    elif mode == "poll-once":
        poll_tasks(once=True)
    elif mode == "loop":
        log(f"bridge started (turso={'on' if turso_enabled() else 'off'})")
        while True:
            try:
                mirror_state()
                poll_tasks()
                time.sleep(30)
            except KeyboardInterrupt:
                log("bridge stopped")
                break
            except Exception as e:
                log(f"bridge error: {e}")
                time.sleep(10)
    else:
        print(f"usage: {sys.argv[0]} [loop|mirror|brief|poll-once]")
        sys.exit(1)


if __name__ == "__main__":
    main()
