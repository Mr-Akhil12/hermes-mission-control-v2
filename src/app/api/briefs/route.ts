import { NextResponse } from "next/server";

// Daily Brief: read briefs from Turso (written by the 6:00 SAST cron via bridge).
const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

async function tursoQuery(sql: string): Promise<any[]> {
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

export async function GET() {
  try {
    if (!TURSO_URL || !TURSO_TOKEN) {
      return NextResponse.json({ error: "Turso not configured" }, { status: 503 });
    }
    const rows = await tursoQuery(
      "SELECT id, date, content, created_at FROM briefs ORDER BY created_at DESC LIMIT 7"
    );
    const briefs = rows.map((r) => {
      let content = {};
      try {
        content = JSON.parse(r.content ?? "{}");
      } catch {
        content = {};
      }
      return { id: r.id, date: r.date, content, created_at: r.created_at };
    });
    return NextResponse.json({ briefs, source: "turso" });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
