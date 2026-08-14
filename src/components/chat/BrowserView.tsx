"use client";

// Live browser view — shows what the agent is doing in the headed browser.
// Refreshes the screenshot every 1.5s while mounted.

import { useEffect, useRef, useState } from "react";
import { Monitor, RefreshCw, EyeOff } from "lucide-react";

export function BrowserView() {
  const [url, setUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ts, setTs] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tick = async () => {
      if (cancelled || !mounted.current || paused) return;
      try {
        const res = await fetch(`/api/browser/shot?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) {
          setError(`browser: ${res.status}`);
          setLoading(false);
          return;
        }
        const blob = await res.blob();
        if (cancelled || !mounted.current) return;
        setUrl(URL.createObjectURL(blob));
        setError(null);
        setLoading(false);
        setTs(Date.now());
      } catch (e) {
        setError(`browser: ${e instanceof Error ? e.message : String(e)}`);
        setLoading(false);
      }
      timer = setTimeout(tick, 1500);
    };

    tick();
    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [paused]);

  return (
    <div className="mb-2 overflow-hidden rounded-xl border" style={{ borderColor: "var(--card-border)", background: "var(--bg)" }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-semibold" style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--card-border)" }}>
        <Monitor className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
        Browser view
        {loading && !url && <RefreshCw className="h-3 w-3 animate-spin" />}
        <span className="ml-auto flex items-center gap-2">
          {!paused && url && (
            <span className="flex items-center gap-1 font-mono text-[10px] opacity-60">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "var(--green)" }} />
              live
            </span>
          )}
          <button
            onClick={() => setPaused((p) => !p)}
            className="rounded px-1.5 py-0.5 hover:bg-white/10"
            style={{ color: "var(--text-faint)" }}
            title={paused ? "Resume live view" : "Pause live view"}
          >
            {paused ? <EyeOff className="h-3 w-3" /> : "pause"}
          </button>
        </span>
      </div>
      <div className="relative" style={{ aspectRatio: "16/9", minHeight: 140 }}>
        {url ? (
          <img
            src={url}
            alt="Live browser"
            className="h-full w-full object-contain"
            style={{ background: "#fff" }}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-xs" style={{ color: "var(--text-faint)" }}>
            {loading ? (
              <>
                <RefreshCw className="h-5 w-5 animate-spin" />
                Connecting to browser…
              </>
            ) : (
              <>
                <EyeOff className="h-5 w-5" />
                {error ?? "No browser feed"}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
