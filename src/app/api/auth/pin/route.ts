import { NextResponse } from "next/server";

// Universal PIN storage: reads/writes the PIN hash in Turso app_settings.
// The PIN is the same on every device (Turso is the source of truth);
// the hardcoded REDACTED hash in auth.ts remains the offline master fallback.
const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

async function tursoQuery(sql: string, args: any[] = []): Promise<any[]> {
  const body = JSON.stringify({
    requests: [{ type: "execute", stmt: { sql, args: args.map((v) => ({ type: "text", value: String(v) })) } }],
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

export async function GET() {
  try {
    if (!TURSO_URL || !TURSO_TOKEN) {
      return NextResponse.json({ error: "Turso not configured" }, { status: 503 });
    }
    const rows = await tursoQuery("SELECT value FROM app_settings WHERE key = 'pin_hash' LIMIT 1");
    const hash = rows.length > 0 ? rows[0].value : null;
    return NextResponse.json({ hash });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    if (!TURSO_URL || !TURSO_TOKEN) {
      return NextResponse.json({ error: "Turso not configured" }, { status: 503 });
    }
    const body = await req.json();
    const hash = typeof body?.hash === "string" ? body.hash : null;
    if (!hash) {
      return NextResponse.json({ error: "hash required" }, { status: 400 });
    }
    await tursoQuery(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('pin_hash', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [hash, new Date().toISOString()]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
