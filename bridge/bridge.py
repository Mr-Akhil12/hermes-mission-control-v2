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

sys.path.insert(0, str(Path(__file__).parent))
import push  # noqa: E402

SAST = timezone(timedelta(hours=2))
HERMES = Path(os.path.expanduser("~/.hermes"))
JOBS = HERMES / "cron" / "jobs.json"
EXEC = HERMES / "cron" / "executions.db"
STATE = HERMES / "state.db"
SEEN_FAILS = HERMES / "push_seen_fails.json"

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


# ── 1b. Push alerts for failed crons ─────────────────────────────────

def _load_seen_fails() -> set:
    if not SEEN_FAILS.exists():
        return set()
    try:
        return set(json.loads(SEEN_FAILS.read_text()))
    except Exception:
        return set()


def _save_seen_fails(seen: set) -> None:
    SEEN_FAILS.write_text(json.dumps(sorted(seen)))


def push_failed_crons() -> None:
    """Detect NEW failed cron runs and push a notification (once each)."""
    if not EXEC.exists():
        return
    con = sqlite3.connect(EXEC)
    rows = con.execute(
        "SELECT job_id, status, claimed_at, error FROM executions "
        "WHERE status = 'error' AND claimed_at > datetime('now','-2 hours') "
        "ORDER BY claimed_at DESC LIMIT 20"
    ).fetchall()
    con.close()
    if not rows:
        return
    seen = _load_seen_fails()
    fresh = []
    for job_id, status, claimed_at, error in rows:
        key = f"{job_id}:{claimed_at}"
        if key in seen:
            continue
        seen.add(key)
        fresh.append((job_id, claimed_at, error))
    if not fresh:
        return
    _save_seen_fails(seen)
    for job_id, claimed_at, error in fresh:
        try:
            push.send_notification(
                "❌ Cron failed",
                f"{job_id} failed at {claimed_at} — {str(error or '')[:100]}",
                url="/crons",
                tag=f"cron-fail-{job_id}",
            )
        except Exception as e:
            log(f"push failed for {job_id}: {e}")


# ── 1c. Artifacts auto-log (hermes-dump / hyperframes) ───────────────

REPOS_ROOT = Path(os.path.expanduser("~/repos"))

# Folders/files in a repo that are NOT user artifacts (skip noise).
_SKIP_DIRS = {".git", "node_modules", ".next", "__pycache__", ".obsidian", ".vercel"}
_SKIP_EXTS = {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".lock", ".tmp"}


def _artifact_kind(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".mp4", ".mov", ".webm"):
        return "video"
    if ext in (".html", ".htm"):
        return "html"
    if ext in (".md", ".txt", ".rst"):
        return "text"
    if ext in (".pdf",):
        return "research"
    if ext in (".py", ".js", ".ts", ".tsx", ".sh", ".json", ".yaml", ".yml", ".sql"):
        return "code"
    if ext in (".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"):
        return "image"
    if ext in (".mp3", ".wav", ".ogg", ".m4a"):
        return "audio"
    return "text"


def auto_log_artifacts() -> None:
    """Scan ~/repos/hermes-dump + hyperframes for files not yet in Turso
    `artifacts` and insert them as links (never blobs)."""
    if not turso_enabled():
        return
    try:
        existing = {
            r["url"]
            for r in turso_query(
                "SELECT url FROM artifacts WHERE repo IN ('hermes-dump', 'hyperframes')"
            )
        }
    except Exception as e:
        log(f"artifacts: could not read existing: {e}")
        return

    inserted = 0
    for repo in ("hermes-dump", "hyperframes"):
        base = REPOS_ROOT / repo
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(base).as_posix()
            if any(part in _SKIP_DIRS for part in p.parts):
                continue
            if p.suffix.lower() in _SKIP_EXTS:
                continue
            if rel.startswith(".git"):
                continue
            url = f"https://github.com/Mr-Akhil12/{repo}/blob/main/{rel}"
            if url in existing:
                continue
            try:
                turso_execute(
                    "INSERT OR IGNORE INTO artifacts (title, kind, repo, path, url, source, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [
                        p.name,
                        _artifact_kind(p),
                        repo,
                        rel,
                        url,
                        "bridge",
                        datetime.now(SAST).isoformat(),
                    ],
                )
                inserted += 1
            except Exception as e:
                log(f"artifacts: insert failed for {rel}: {e}")
    if inserted:
        log(f"artifacts: logged {inserted} new file(s) → Turso")


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

    write_brief(brief)


def write_brief(brief: dict) -> None:
    """Persist a brief dict to Turso `briefs` (id = date)."""
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


def brief_write_from_file(path: str) -> None:
    """Read an AI-composed brief JSON file and persist it (cron agent path)."""
    p = Path(path)
    if not p.exists():
        log(f"brief-write: file not found: {path}")
        sys.exit(1)
    try:
        brief = json.loads(p.read_text())
    except Exception as e:
        log(f"brief-write: invalid JSON: {e}")
        sys.exit(1)
    # Normalize shape so the home page never crashes on missing keys.
    brief.setdefault("attention", [])
    brief.setdefault("shipped", [])
    brief.setdefault("next_actions", [])
    brief.setdefault("one_thing", None)
    write_brief(brief)
    log(f"brief-write: persisted {len(brief['attention'])} attention, {len(brief['shipped'])} shipped, {len(brief['next_actions'])} next_actions")


# ── Main ──────────────────────────────────────────────────────────────

def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "loop"
    if mode == "mirror":
        mirror_state()
    elif mode == "brief":
        generate_brief()
    elif mode == "brief-write":
        brief_write_from_file(sys.argv[2] if len(sys.argv) > 2 else "")
    elif mode == "poll-once":
        poll_tasks(once=True)
    elif mode == "loop":
        log(f"bridge started (turso={'on' if turso_enabled() else 'off'})")
        tick = 0
        while True:
            try:
                mirror_state()
                push_failed_crons()
                poll_tasks()
                # Artifacts scan is heavier — every 4th cycle (~2 min).
                tick += 1
                if tick % 4 == 0:
                    auto_log_artifacts()
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
