import { NextResponse } from "next/server";

// Dispatch: try the real Hermes API (via tunnel); if unreachable, queue the
// task into Turso `tasks` — the bridge polls it every 30s and runs it.
// This makes dispatch survive tunnel drops.

const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

async function tursoQuery(sql: string, args: unknown[] = []): Promise<any[]> {
  const body = JSON.stringify({
    requests: [
      {
        type: "execute",
        stmt: {
          sql,
          args: args.map((v) =>
            v == null
              ? { type: "null", value: null }
              : typeof v === "number"
                ? { type: "integer", value: String(v) }
                : { type: "text", value: String(v) }
          ),
        },
      },
    ],
  });
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

export async function POST(request: Request) {
  try {
    const { prompt, profile } = await request.json();
    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const apiBase = process.env.HERMES_API_URL ?? "http://127.0.0.1:8642";
    const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
    const proxyBase = DATA_URL && apiBase.startsWith("http://127.0.0.1") ? DATA_URL : apiBase;

    // 1. Try the real Hermes API (run path produces approvals).
    const body = {
      input: `[dispatch:${profile}] ${prompt}`,
      model: process.env.HERMES_API_MODEL ?? "deepseek-v4-flash:0731",
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(`${proxyBase}/v1/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        return NextResponse.json({
          ok: true,
          message: data.run_id ? `Run started (${data.run_id}). If it needs approval, it'll appear on the Approvals screen.` : "Run started.",
          run_id: data.run_id ?? null,
          queued: false,
        });
      }
      // API reachable but returned an error — fall through to queue.
    } catch {
      clearTimeout(timer);
      // Tunnel/API unreachable — fall through to queue.
    }

    // 2. Queue into Turso — bridge picks it up within 30s.
    if (!TURSO_URL || !TURSO_TOKEN) {
      return NextResponse.json(
        { error: "Hermes API unreachable and Turso queue not configured — dispatch failed." },
        { status: 502 }
      );
    }
    await tursoQuery(
      "INSERT INTO tasks (prompt, profile, status, source) VALUES (?, ?, 'queued', 'pwa')",
      [prompt, profile ?? "default"]
    );
    return NextResponse.json({
      ok: true,
      message: "Queued — Hermes API was unreachable, so this task is in the queue. The bridge will pick it up within 30s.",
      run_id: null,
      queued: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Dispatch failed: ${msg}` }, { status: 502 });
  }
}
