import { NextResponse } from "next/server";

// Dispatch queue: read tasks from Turso (queued/running/done/failed).
const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

export async function GET() {
  try {
    if (!TURSO_URL || !TURSO_TOKEN) {
      return NextResponse.json({ tasks: [], error: "Turso not configured" }, { status: 503 });
    }
    const body = JSON.stringify({
      requests: [
        {
          type: "execute",
          stmt: {
            sql: "SELECT id, prompt, profile, status, result, error, created_at, started_at, finished_at FROM tasks ORDER BY created_at DESC LIMIT 50",
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
    const cols = result?.cols?.map((c: any) => c.name) ?? [];
    const rows = result?.rows ?? [];
    const tasks = rows.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i], v?.value])));
    return NextResponse.json({ tasks });
  } catch (e) {
    return NextResponse.json({ error: String(e), tasks: [] }, { status: 502 });
  }
}
