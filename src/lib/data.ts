"use server";

/**
 * Data layer for Hermes OS v2.
 *
 * Three sources, tried in order:
 *  1. TURSO — the durable cloud layer (survives PC downtime). The bridge
 *     mirrors real Hermes state here every 30s. This is the primary source
 *     for the Vercel-hosted PWA (phone).
 *  2. REMOTE — the state server through the ngrok tunnel (NEXT_PUBLIC_DATA_URL).
 *     Fallback when Turso isn't configured.
 *  3. LOCAL — Hermes's own files (same-machine dev).
 */

const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

const ENDPOINTS: Record<string, { table: string; key: string }> = {
  crons: { table: "sync_cache", key: "crons" },
  runs: { table: "sync_cache", key: "cron_runs" },
  sessions: { table: "sync_cache", key: "sessions" },
  artifacts: { table: "artifacts", key: "" },
};

async function tursoQuery(sql: string): Promise<any> {
  const body = JSON.stringify({ requests: [{ type: "execute", stmt: { sql } }] });
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`turso ${res.status}`);
  const data = await res.json();
  const result = data?.results?.[0]?.response?.result;
  if (!result) return [];
  const cols = result.cols.map((c: any) => c.name);
  return result.rows.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i], v?.value])));
}

export async function fetchState(endpoint: "crons" | "runs" | "sessions" | "artifacts", limit = 25) {
  // 1. Turso (durable cloud)
  if (TURSO_URL && TURSO_TOKEN) {
    try {
      if (endpoint === "artifacts") {
        const rows = await tursoQuery("SELECT title, kind, repo, path, url, source, created_at FROM artifacts ORDER BY created_at DESC LIMIT 200");
        return { artifacts: rows, source: "turso" };
      }
      const cfg = ENDPOINTS[endpoint];
      const rows = await tursoQuery(`SELECT payload FROM sync_cache WHERE key = '${cfg.key}'`);
      if (rows.length > 0) {
        const payload = JSON.parse(rows[0].payload);
        const key = endpoint === "crons" ? "jobs" : endpoint === "runs" ? "runs" : "sessions";
        const list = Array.isArray(payload) ? payload : payload[key] ?? [];
        return { [key]: list.slice(0, limit), source: "turso" };
      }
    } catch {
      // fall through
    }
  }

  // 2. Remote state server (tunnel)
  if (DATA_URL) {
    try {
      const localPaths: Record<string, string> = {
        crons: "/api/crons",
        runs: "/api/runs",
        sessions: `/api/sessions?limit=${limit}`,
        artifacts: "/api/artifacts",
      };
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
