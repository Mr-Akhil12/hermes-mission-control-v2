"use server";

/**
 * Data layer for Hermes OS v2.
 *
 * Two sources, tried in order:
 *  1. LOCAL — Hermes's own files on this machine (jobs.json, executions.db,
 *     state.db). Works when the dashboard runs on the same box as Hermes.
 *  2. REMOTE — the state server exposed through the ngrok tunnel
 *     (NEXT_PUBLIC_DATA_URL). Lets the Vercel-hosted PWA show the same live
 *     data on the phone. Falls back gracefully to empty when unreachable.
 *
 * When Turso creds are configured, this becomes the primary source and the
 * bridge mirrors into it — the modular swap the plan calls for.
 */

const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

export async function fetchState(endpoint: "crons" | "runs" | "sessions" | "artifacts", limit = 25) {
  const localPaths: Record<string, string> = {
    crons: "/api/crons",
    runs: "/api/runs",
    sessions: `/api/sessions?limit=${limit}`,
    artifacts: "/api/artifacts",
  };

  // 1. Try local first (same-machine dev / localhost)
  try {
    const res = await fetch(`http://127.0.0.1:8645${localPaths[endpoint]}`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (data && !Array.isArray(data.error)) return { ...data, source: "local" };
    }
  } catch {
    // fall through
  }

  // 2. Try remote state server (phone / Vercel)
  if (DATA_URL) {
    try {
      const res = await fetch(`${DATA_URL}${localPaths[endpoint]}`, {
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        if (data && !Array.isArray(data.error)) return { ...data, source: "remote" };
      }
    } catch {
      // fall through
    }
  }

  // 3. Empty fallback
  const empty: Record<string, string> = { crons: "jobs", runs: "runs", sessions: "sessions", artifacts: "artifacts" };
  return { [empty[endpoint]]: [], source: "none" };
}
