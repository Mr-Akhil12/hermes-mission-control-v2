#!/usr/bin/env python3
"""CDP browser screencast broadcaster — serves the headed browser as a live
MJPEG stream (multipart/x-mixed-replace) with zero polling.

Uses CDP's native Page.startScreencast (continuous JPEG frames from the
browser) and fans each frame out to every subscribed stream client. One
CDP connection, N viewers, no per-frame round-trips.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import queue
import threading
import time
import urllib.request

log = logging.getLogger("cdp_stream")

CDP_HTTP = os.environ.get("BROWSER_CDP_URL", "http://127.0.0.1:9222").replace("ws://", "http://")
_CDP_WS = os.environ.get("BROWSER_CDP_WS", "")


def _page_ws_url() -> str:
    """Return the first page tab's webSocketDebuggerUrl."""
    if _CDP_WS:
        return _CDP_WS
    with urllib.request.urlopen(f"{CDP_HTTP}/json/list", timeout=5) as r:
        tabs = json.loads(r.read())
    for tab in tabs:
        if tab.get("type") == "page":
            return tab.get("webSocketDebuggerUrl", "")
    return ""


class ScreencastBroadcaster:
    """Background asyncio thread: CDP screencast -> per-subscriber queues."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._subs: dict[int, queue.Queue] = {}
        self._next_id = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._latest: bytes | None = None
        self._active = False

    # ── lifecycle ──────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="cdp-screencast")
        self._thread.start()

    def _run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        import websockets
        while not self._stop.is_set():
            try:
                ws_url = _page_ws_url()
                if not ws_url:
                    await asyncio.sleep(2)
                    continue
                async with websockets.connect(ws_url, open_timeout=5, max_size=50 * 1024 * 1024) as ws:
                    await ws.send(json.dumps({"id": 1, "method": "Page.enable", "params": {}}))
                    await ws.send(json.dumps({
                        "id": 2,
                        "method": "Page.startScreencast",
                        # lighter frames: smaller canvas, lower quality,
                        # everyNthFrame 3 — keeps the stream lean on mobile.
                        "params": {"format": "jpeg", "quality": 45, "maxWidth": 720, "everyNthFrame": 3},
                    }))
                    self._set_active(True)
                    log.info("screencast started")
                    ack_id = 100
                    while not self._stop.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=15)
                        except asyncio.TimeoutError:
                            continue
                        except Exception:
                            break
                        try:
                            obj = json.loads(raw)
                        except Exception:
                            continue
                        if obj.get("method") == "Page.screencastFrame":
                            params = obj.get("params") or {}
                            data = params.get("data")
                            if data:
                                try:
                                    self._broadcast(base64.b64decode(data))
                                except Exception:
                                    pass
                            ack_id += 1
                            await ws.send(json.dumps({
                                "id": ack_id,
                                "method": "Page.screencastFrameAck",
                                "params": {"sessionId": params.get("sessionId", 0)},
                            }))
            except Exception as exc:
                log.warning("screencast error: %s", exc)
            finally:
                self._set_active(False)
            await asyncio.sleep(2)

    # ── subscription ───────────────────────────────────────────────────
    def subscribe(self) -> tuple[int, queue.Queue]:
        with self._lock:
            self._next_id += 1
            sid = self._next_id
            q: queue.Queue = queue.Queue(maxsize=3)
            self._subs[sid] = q
            return sid, q

    def unsubscribe(self, sid: int) -> None:
        with self._lock:
            self._subs.pop(sid, None)

    def _broadcast(self, jpg: bytes) -> None:
        # Throttle to ~5 fps so the stream stays lean on mobile; CDP
        # screencast sends at 30fps+ even for static pages.
        now = time.time()
        if now - getattr(self, "_last_send", 0) < 0.2:
            self._latest = jpg
            return
        self._last_send = now
        self._latest = jpg
        with self._lock:
            for q in list(self._subs.values()):
                try:
                    q.put_nowait(jpg)
                except queue.Full:
                    # drop oldest so slow clients never buffer weight
                    try:
                        q.get_nowait()
                        q.put_nowait(jpg)
                    except Exception:
                        pass

    def _set_active(self, active: bool) -> None:
        self._active = active
        if not active:
            self._latest = None

    def latest(self) -> tuple[bytes | None, bool]:
        return self._latest, self._active


_b: ScreencastBroadcaster | None = None


def get_broadcaster() -> ScreencastBroadcaster:
    global _b
    if _b is None:
        _b = ScreencastBroadcaster()
        _b.start()
    return _b
