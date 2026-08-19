"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AppWindow, RefreshCw, ExternalLink } from "lucide-react";

const NATIVE_URL = process.env.NEXT_PUBLIC_NATIVE_URL ?? "http://172.21.184.37:9119";
// Prefer the Tailscale funnel (real HTTPS, no ngrok interstitial) when set.
// Falls back to the ngrok state-server proxy, then the direct LAN URL.
const FUNNEL_URL = process.env.NEXT_PUBLIC_FUNNEL_URL ?? "https://akhils-pc.tail6d629e.ts.net";
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
const IFRAME_BASE = FUNNEL_URL || (DATA_URL ? `${DATA_URL}/native` : NATIVE_URL);
// Same-origin proxy: the iframe loads /native-proxy/* on THIS domain, and the
// route handler fetches the funnel + rewrites absolute paths so cookies are
// first-party and the SPA works inside the embed (no third-party cookie block).
const PROXY_BASE = "/native-proxy";

export default function NativePage() {
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [src, setSrc] = useState(`${PROXY_BASE}/login`);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Connection check: rely on the iframe's onLoad/onError instead of fetch —
  // fetch to the funnel is CORS-blocked even when the server is up (false positive).
  const handleLoad = useCallback(() => {
    setOffline(false);
    setLoading(false);
  }, []);

  const handleError = useCallback(() => {
    setOffline(true);
    setLoading(false);
  }, []);

  return (
    <div className="relative mx-auto w-full max-w-[1600px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <AppWindow className="h-6 w-6" style={{ color: "var(--accent)" }} /> Native UI
          </h1>
          <p className="text-sm" style={{ color: "var(--text-dim)" }}>
            The whole native Hermes dashboard. If the embed looks blank, open it in a new tab — that always works.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`${IFRAME_BASE}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          >
            <ExternalLink className="h-4 w-4" /> Open in new tab
          </a>
          <button
            onClick={() => {
              setLoading(true);
              setOffline(false);
              setSrc(`${PROXY_BASE}/login?ts=${Date.now()}`);
              setTimeout(() => setLoading(false), 1500);
            }}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
          >
            <RefreshCw className="h-4 w-4" /> Reload
          </button>
        </div>
      </div>

      {/* Frame */}
      <div className="relative h-[calc(100vh-190px)] min-h-[60vh] overflow-hidden rounded-xl border" style={{ borderColor: "var(--card-border)" }}>
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
          onLoad={handleLoad}
          onError={handleError}
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
