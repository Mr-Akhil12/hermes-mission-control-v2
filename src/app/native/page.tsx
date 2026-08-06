"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AppWindow, RefreshCw } from "lucide-react";

const NATIVE_URL = process.env.NEXT_PUBLIC_NATIVE_URL ?? "http://100.109.86.13:9119";

export default function NativePage() {
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [src, setSrc] = useState(`${NATIVE_URL}/`);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const checkTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkConnection = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${NATIVE_URL}/login`, { signal: controller.signal, mode: "no-cors" });
      clearTimeout(timer);
      setOffline(false);
      return true;
    } catch {
      setOffline(true);
      return false;
    }
  }, []);

  useEffect(() => {
    checkConnection();
    checkTimer.current = setInterval(checkConnection, 15000);
    return () => {
      if (checkTimer.current) clearInterval(checkTimer.current);
    };
  }, [checkConnection]);

  return (
    <div className="relative mx-auto max-w-[1600px]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <AppWindow className="h-6 w-6" style={{ color: "var(--accent)" }} /> Native UI
          </h1>
          <p className="text-sm" style={{ color: "var(--text-dim)" }}>
            The whole native Hermes dashboard, embedded via Tailscale ({NATIVE_URL.replace("http://", "")}). Works on your phone with the Tailscale app running.
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            setSrc(`${NATIVE_URL}/?ts=${Date.now()}`);
            setTimeout(() => setLoading(false), 1500);
            checkConnection();
          }}
          className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
        >
          <RefreshCw className="h-4 w-4" /> Reload
        </button>
      </div>

      {/* Frame */}
      <div className="relative h-[calc(100vh-190px)] min-h-[480px] overflow-hidden rounded-xl border" style={{ borderColor: "var(--card-border)" }}>
        {/* Crime-scene tape: shown when iframe can't connect */}
        {offline && (
          <div className="tape-banner">
            <span>Offline</span>
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: "var(--bg-2)" }}>
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-faint)" }}>
              <RefreshCw className="h-4 w-4 animate-spin" /> Connecting to native dashboard…
            </div>
          </div>
        )}

        <iframe
          ref={iframeRef}
          src={src}
          title="Native Hermes Dashboard"
          className="h-full w-full"
          style={{ border: "none" }}
          onLoad={() => setLoading(false)}
        />

        {offline && (
          <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center pb-14">
            <div className="rounded-lg px-4 py-2 text-sm font-medium" style={{ background: "color-mix(in srgb, var(--bg-2) 90%, transparent)", color: "var(--text-dim)" }}>
              Tailscale tunnel unreachable — check the app is on and the PC is awake.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
