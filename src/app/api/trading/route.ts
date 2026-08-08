import { NextResponse } from "next/server";

// Trading: read trades + strategy from Turso (the akhils-trading app's DB).
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
    const [trades, strategy] = await Promise.all([
      tursoQuery(
        "SELECT id, direction, symbol, entry, sl, tp, close_price, result, rr, volume, profit, account, opened_at, closed_at FROM trades ORDER BY opened_at DESC LIMIT 200"
      ),
      tursoQuery("SELECT id, title, body, updated_at FROM strategy ORDER BY updated_at DESC LIMIT 20"),
    ]);
    return NextResponse.json({ trades, strategy, source: "turso" });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
