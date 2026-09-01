#!/usr/bin/env python3
"""WS RPC bridge — connects the state server to the native dashboard's
JSON-RPC WebSocket (/api/ws) so the dashboard chat can run the FULL Hermes
slash command surface (slash.exec / command.dispatch / complete.slash).

Auth chain (gated dashboard):
  POST /auth/password-login  -> session cookie
  POST /api/auth/ws-ticket   -> single-use ticket (TTL 30s)
  ws://127.0.0.1:9119/api/ws?ticket=...  -> JSON-RPC 2.0, newline-delimited

The connection is kept alive; tickets are minted on (re)connect only.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("ws_bridge")

DASH = os.environ.get("DASHBOARD_URL", "http://127.0.0.1:19119")
WS_URL = os.environ.get("DASHBOARD_WS_URL", "ws://127.0.0.1:19119/api/ws")
# 2026-09-01 FIX: was expanduser("~/.hermes/config.yaml") — the stale June-era
# WSL-migration copy. Read the LIVE config so basic-auth creds are current.
CONFIG = Path(
    os.environ.get("HERMES_HOME", str(Path.home() / "AppData" / "Local" / "hermes"))
) / "config.yaml"

# Read basic-auth credentials from config.yaml (dashboard.basic_auth).
def _basic_creds() -> tuple[str, str]:
    try:
        import yaml
        cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8")) or {}
        ba = (cfg.get("dashboard") or {}).get("basic_auth") or {}
        return str(ba.get("username") or "admin"), str(ba.get("password") or "")
    except Exception:
        return "admin", ""


class WsBridge:
    """One persistent WS connection with request/response correlation."""

    def __init__(self) -> None:
        self._ws = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._next_id = 0
        self._pending: dict[str, asyncio.Future] = {}
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.session_id: str = ""

    # ── lifecycle ──────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="ws-bridge")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._loop:
            try:
                self._loop.call_soon_threadsafe(self._loop.stop)
            except Exception:
                pass

    def _run_loop(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        while not self._stop.is_set():
            try:
                await self._connect_and_serve()
            except Exception as exc:
                log.warning("ws bridge error: %s", exc)
            await asyncio.sleep(3)

    # ── auth + connect ─────────────────────────────────────────────────
    def _mint_ticket(self) -> str:
        user, pw = _basic_creds()
        import http.cookiejar
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        login = urllib.request.Request(
            f"{DASH}/auth/password-login",
            data=json.dumps({"provider": "basic", "username": user, "password": pw}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with opener.open(login, timeout=10) as resp:
            resp.read()
        ticket_req = urllib.request.Request(f"{DASH}/api/auth/ws-ticket", data=b"{}", method="POST")
        with opener.open(ticket_req, timeout=10) as resp:
            data = json.loads(resp.read())
        return data["ticket"]

    async def _connect_and_serve(self) -> None:
        import websockets

        ticket = self._mint_ticket()
        self._loop = asyncio.get_running_loop()
        async with websockets.connect(f"{WS_URL}?ticket={ticket}", open_timeout=10) as ws:
            self._ws = ws
            log.info("ws bridge connected")
            # drain gateway.ready
            try:
                await asyncio.wait_for(ws.recv(), timeout=5)
            except Exception:
                pass
            # Start the recv loop as a background task FIRST — _request awaits
            # futures that only this loop resolves, so it must be running
            # before any RPC is issued.
            recv_task = asyncio.create_task(self._recv_loop(ws))
            # Create a persistent session for slash.exec (the tui_gateway
            # requires a session it knows about — API-server sessions don't
            # exist in its registry).
            try:
                result = await self._request("session.create", {}, timeout=10)
                if isinstance(result, dict):
                    self.session_id = result.get("session_id") or ""
                log.info("ws bridge session created: %s", self.session_id)
            except Exception as exc:
                log.warning("ws bridge session.create failed: %s", exc)
            try:
                await recv_task
            except asyncio.CancelledError:
                pass
            self._ws = None

    async def _recv_loop(self, ws) -> None:
        while not self._stop.is_set():
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=30)
            except asyncio.TimeoutError:
                continue
            except Exception:
                break
            try:
                frame = json.loads(raw)
            except Exception:
                continue
            rid = frame.get("id")
            if rid is not None:
                fut = self._pending.pop(str(rid), None)
                if fut and not fut.done():
                    if frame.get("error"):
                        fut.set_exception(RuntimeError(frame["error"].get("message", "RPC error")))
                    else:
                        fut.set_result(frame.get("result"))

    # ── RPC ────────────────────────────────────────────────────────────
    # Thread-safe: callers (HTTP handler threads) schedule the coroutine
    # onto the bridge's own event loop and block on the result. Never use
    # asyncio.run() here — the futures belong to the bridge loop.
    def _call(self, coro, timeout: float):
        if self._ws is None or self._loop is None:
            raise RuntimeError("ws bridge not connected")
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result(timeout=timeout)

    def slash_exec(self, command: str, session_id: str = "", timeout: float = 90.0):
        sid = session_id or self.session_id
        return self._call(self._request("slash.exec", {"command": command, "session_id": sid}), timeout)

    def command_dispatch(self, name: str, arg: str = "", session_id: str = ""):
        sid = session_id or self.session_id
        return self._call(self._request("command.dispatch", {"name": name, "arg": arg, "session_id": sid}), 30)

    def complete_slash(self, text: str):
        return self._call(self._request("complete.slash", {"text": text}), 10)

    async def _request(self, method: str, params: dict, timeout: float = 60.0):
        if self._ws is None:
            raise RuntimeError("ws bridge not connected")
        with self._lock:
            self._next_id += 1
            rid = f"b{self._next_id}"
            fut: asyncio.Future = self._loop.create_future()
            self._pending[rid] = fut
        await self._ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(rid, None)


_bridge: WsBridge | None = None


def get_bridge() -> WsBridge:
    global _bridge
    if _bridge is None:
        _bridge = WsBridge()
        _bridge.start()
    return _bridge
