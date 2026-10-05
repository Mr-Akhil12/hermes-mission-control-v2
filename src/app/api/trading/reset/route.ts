import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth-server";
import { tursoBatch, tursoConfigured } from "@/lib/turso-trading";

export const dynamic = "force-dynamic";

/**
 * POST /api/trading/reset — "clear and start fresh" for the Yellow cockpit.
 *
 * Session-cookie only (dashboard user). The Yellow ingest token can NOT call this.
 * Body must be {"confirm":"CLEAR"}.
 *
 * Recoverable: copies `trades` and `yellow_reports` into timestamped archive
 * tables (trades_archive_<ts>, yellow_reports_archive_<ts>) in the same
 * transaction before deleting. Env (PIN, ingest token, MT5) and the strategy
 * rules table are untouched.
 */
export async function POST(request: Request) {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value ?? "";
    if (!token || !verifySessionToken(token)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!tursoConfigured()) {
      return NextResponse.json({ error: "Turso not configured" }, { status: 503 });
    }

    let body: { confirm?: string } = {};
    try {
      body = await request.json();
    } catch {
      // fallthrough to confirm check
    }
    if (body.confirm !== "CLEAR") {
      return NextResponse.json({ error: 'send {"confirm":"CLEAR"}' }, { status: 400 });
    }

    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS (UTC)
    const tradesArchive = `trades_archive_${ts}`;
    const reportsArchive = `yellow_reports_archive_${ts}`;

    // Make sure yellow_reports exists so the archive/delete never errors.
    await tursoBatch([
      {
        sql: `CREATE TABLE IF NOT EXISTS yellow_reports (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          symbol TEXT DEFAULT 'XAUUSD', bias TEXT, levels TEXT, decision TEXT,
          entry REAL, sl REAL, tp REAL, lot REAL DEFAULT 0.01, hold_seconds INTEGER,
          margin REAL, pnl REAL, balance REAL, equity REAL, session_window TEXT,
          notes TEXT, raw_json TEXT)`,
      },
    ]);

    // Atomic: archive + delete, all-or-nothing (tursoBatch wraps BEGIN/COMMIT/ROLLBACK).
    const results = await tursoBatch([
      { sql: "SELECT (SELECT count(*) FROM trades) AS trades, (SELECT count(*) FROM yellow_reports) AS reports" },
      { sql: `CREATE TABLE ${tradesArchive} AS SELECT * FROM trades` },
      { sql: `CREATE TABLE ${reportsArchive} AS SELECT * FROM yellow_reports` },
      { sql: "DELETE FROM trades" },
      { sql: "DELETE FROM yellow_reports" },
      { sql: "SELECT (SELECT count(*) FROM trades) AS trades, (SELECT count(*) FROM yellow_reports) AS reports" },
    ]);

    const before = results[0].rows[0] ?? {};
    const after = results[5].rows[0] ?? {};
    return NextResponse.json({
      ok: true,
      archived: { trades: tradesArchive, yellow_reports: reportsArchive },
      deleted: { trades: results[3].affected, yellow_reports: results[4].affected },
      before,
      after,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
