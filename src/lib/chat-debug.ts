// chat-debug.ts — namespaced chat-stream debug logger for hermes-mission-control-v2.
//
// PURPOSE: every state transition in the chat page (history load, SSE frame
// handling, tool chip settles, navigation, reattach, beat refreshes) emits a
// compact log line so a live browser session can be traced end-to-end.
//
// ENABLE: add `?dbg=1` to the URL, or run `localStorage.setItem('chat-debug','1')`
// (logger re-checks on an interval so it can be toggled live). Logs go to
// console.log AND a ring buffer at window.__chatDebug.buffer — the buffer is
// what browser automation reads back after driving a real session.
//
// FORMAT: `[chat-debug|AREA] message {detail}` — greppable by AREA.

declare global {
  interface Window {
    __chatDebug?: {
      enabled: boolean;
      buffer: string[];
      max: number;
      seq: number;
    };
  }
}

const MAX_BUFFER = 3000;

function ensureSink(): void {
  if (typeof window === "undefined") return;
  if (!window.__chatDebug) {
    window.__chatDebug = { enabled: false, buffer: [], max: MAX_BUFFER, seq: 0 };
  }
}

export function isDbgEnabled(): boolean {
  if (typeof window === "undefined") return false;
  ensureSink();
  const w = window.__chatDebug!;
  if (!w.enabled) {
    const fromUrl = new URLSearchParams(window.location.search).get("dbg");
    const fromStorage = (() => {
      try {
        return window.localStorage.getItem("chat-debug");
      } catch {
        return null;
      }
    })();
    w.enabled = fromUrl === "1" || fromUrl === "true" || fromStorage === "1";
  }
  return w.enabled;
}

/** Live toggle: set localStorage then re-check (used by the poll in dbgTick). */
export function refreshDbgEnabled(): boolean {
  if (typeof window === "undefined") return false;
  ensureSink();
  const w = window.__chatDebug!;
  const fromUrl = new URLSearchParams(window.location.search).get("dbg");
  const fromStorage = (() => {
    try {
      return window.localStorage.getItem("chat-debug");
    } catch {
      return null;
    }
  })();
  w.enabled = fromUrl === "1" || fromUrl === "true" || fromStorage === "1";
  return w.enabled;
}

/**
 * Emit a debug line. `area` is a short tag (e.g. 'loadMessages', 'sse',
 * 'tool', 'nav', 'reattach', 'settle', 'beat'). `msg` is the human line.
 * `detail` is any JSON-serializable value — compacted to keep the buffer small.
 */
export function dbg(area: string, msg: string, detail?: unknown): void {
  if (typeof window === "undefined") return;
  ensureSink();
  const w = window.__chatDebug!;
  if (!w.enabled) return;
  w.seq += 1;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  let detailStr = "";
  if (detail !== undefined) {
    try {
      detailStr = " " + JSON.stringify(detail, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v));
    } catch {
      detailStr = " [unserializable]";
    }
  }
  const line = `[chat-debug|${area}] #${w.seq} ${ts} ${msg}${detailStr}`;
  // eslint-disable-next-line no-console
  console.log(line);
  w.buffer.push(line);
  if (w.buffer.length > w.max) w.buffer.splice(0, w.buffer.length - w.max);
}

/** Compact snapshot of a tool event for logging (drops huge args/results). */
export function toolSnap(t: { name?: string; durationMs?: number; error?: boolean; interrupted?: boolean; preview?: string; startedAt?: number } | undefined | null): Record<string, unknown> | null {
  if (!t) return null;
  return {
    name: t.name,
    durMs: t.durationMs,
    err: t.error,
    intr: t.interrupted,
    prev: t.preview ? t.preview.slice(0, 80) : undefined,
    startedAt: t.startedAt ? new Date(t.startedAt).toISOString().slice(11, 19) : undefined,
  };
}

/** Compact live-phase snapshot. */
export function liveSnap(live: { phase?: string; toolCount?: number; failedCount?: number; reasoning?: string } | null | undefined): Record<string, unknown> | null {
  if (!live) return null;
  return {
    phase: live.phase,
    tools: live.toolCount,
    failed: live.failedCount,
    reasoningLen: live.reasoning?.length ?? 0,
  };
}

// Poll every 2s so toggling localStorage('chat-debug') works without a reload.
if (typeof window !== "undefined") {
  window.setInterval(() => {
    refreshDbgEnabled();
  }, 2000);
}
