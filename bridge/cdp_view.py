#!/usr/bin/env python3
"""CDP browser view proxy — captures live screenshots of the headed browser
so the dashboard chat can show what the agent is doing in real time.

Uses the CDP HTTP endpoints (/json/list, /json/version) + WebSocket for
Page.captureScreenshot. No external deps beyond websockets.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
import urllib.request

log = logging.getLogger("cdp_view")

CDP_HTTP = "http://127.0.0.1:9222"


def _list_pages() -> list[dict]:
    with urllib.request.urlopen(f"{CDP_HTTP}/json/list", timeout=5) as r:
        return json.loads(r.read())


def find_page_url() -> str:
    """Return the first page tab's webSocketDebuggerUrl."""
    for tab in _list_pages():
        if tab.get("type") == "page":
            return tab.get("webSocketDebuggerUrl", "")
    return ""


async def _capture_once(timeout: float = 8.0) -> bytes | None:
    import websockets
    ws_url = find_page_url()
    if not ws_url:
        return None
    async with websockets.connect(ws_url, open_timeout=5, max_size=50 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Page.captureScreenshot", "params": {"format": "jpeg", "quality": 70}}))
        while True:
            frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
            if frame.get("id") == 1:
                data = frame.get("result", {}).get("data")
                if data:
                    return base64.b64decode(data)
                return None


class CdpView:
    """Thread-safe screenshot capture wrapper."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._latest: bytes | None = None
        self._latest_ts: float = 0.0
        self._stop = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="cdp-view")
        self._thread.start()

    def _run(self) -> None:
        import time
        while not self._stop.is_set():
            try:
                shot = asyncio.run(_capture_once(timeout=8))
                if shot:
                    with self._lock:
                        self._latest = shot
                        self._latest_ts = time.time()
            except Exception as exc:
                log.debug("capture failed: %s", exc)
            # capture every ~1s while there's a browser
            import time as _t
            _t.sleep(1.0)

    def snapshot(self) -> tuple[bytes | None, float]:
        with self._lock:
            return self._latest, self._latest_ts


_view: CdpView | None = None


def get_view() -> CdpView:
    global _view
    if _view is None:
        _view = CdpView()
        _view.start()
    return _view
