"use client";

// Live browser view — the <img> plays the MJPEG stream (multipart/x-mixed-
// replace) straight from the state server. One connection, zero polling,
// zero bloat. The browser tab itself is also visible on Akhil's desktop.

import { useState } from "react";
import { Monitor, EyeOff } from "lucide-react";

export function BrowserView() {
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(() => Math.random().toString(36).slice(2));

  if (paused) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}>
        <EyeOff className="h-3.5 w-3.5" />
        Browser view paused
        <button
          onClick={() => setPaused(false)}
          className="ml-auto rounded px-1.5 py-0.5 font-semibold"
          style={{ color: "var(--accent)" }}
        >
          resume
        </button>
      </div>
    );
  }

  return (
    <div className="mb-2 overflow-hidden rounded-xl border" style={{ borderColor: "var(--card-border)", background: "var(--bg)" }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-semibold" style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--card-border)" }}>
        <Monitor className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
        Browser view
        <span className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1 font-mono text-[10px] opacity-60">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "var(--green)" }} />
            live
          </span>
          <button
            onClick={() => setPaused(true)}
            className="rounded px-1.5 py-0.5 hover:bg-white/10"
            style={{ color: "var(--text-faint)" }}
            title="Pause live view"
          >
            pause
          </button>
        </span>
      </div>
      <div className="relative" style={{ aspectRatio: "16/9", minHeight: 140 }}>
        {failed ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-xs" style={{ color: "var(--text-faint)" }}>
            <EyeOff className="h-5 w-5" />
            Browser stream unavailable
            <button
              onClick={() => {
                setFailed(false);
                setNonce(Math.random().toString(36).slice(2));
              }}
              className="rounded px-2 py-1 font-semibold"
              style={{ color: "var(--accent)" }}
            >
              retry
            </button>
          </div>
        ) : (
          <img
            src={`/api/browser/shot?n=${nonce}`}
            alt="Live browser"
            className="h-full w-full object-contain"
            style={{ background: "#fff" }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
