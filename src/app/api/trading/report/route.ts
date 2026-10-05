import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth-server";
import { tursoConfigured, tursoQuery, tursoExecIgnoreDup } from "@/lib/turso-trading";

export const dynamic = "force-dynamic";

type ReportBody = {
  bias?: string;
  levels?: unknown;
  decision?: "skip" | "take" | string;
  entry?: number | null;
  sl?: number | null;
  tp?: number | null;
  lot?: number | null;
  hold_seconds?: number | null;
  margin?: number | null;
  pnl?: number | null;
  balance?: number | null;
  equity?: number | null;
  session_window?: string | null;
  notes?: string | null;
  symbol?: string | null;
  direction?: "BUY" | "SELL" | string | null;
};

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function authorize(request: Request): Promise<boolean> {
  const ingest = process.env.YELLOW_INGEST_TOKEN ?? "";
  const auth = request.headers.get("authorization") ?? "";
  const headerToken = request.headers.get("x-yellow-token") ?? "";

  if (ingest) {
    if (auth.toLowerCase().startsWith("bearer ")) {
      const token = auth.slice(7).trim();
      if (safeEqualStr(token, ingest)) return true;
    }
    if (headerToken && safeEqualStr(headerToken, ingest)) return true;
  }

  // Fallback: existing Hermes session cookie (dashboard user).
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value ?? "";
    if (token && verifySessionToken(token)) return true;
  } catch {
    // no cookie store
  }
  return false;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: Request) {
  try {
    if (!(await authorize(request))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!tursoConfigured()) {
      return NextResponse.json({ error: "Turso not configured" }, { status: 503 });
    }

    let body: ReportBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }

    const decision = String(body.decision ?? "").toLowerCase();
    if (decision !== "skip" && decision !== "take") {
      return NextResponse.json({ error: "decision must be skip|take" }, { status: 400 });
    }

    const symbol = (body.symbol ?? "XAUUSD").toString().toUpperCase();
    if (symbol !== "XAUUSD") {
      return NextResponse.json({ error: "Yellow is XAUUSD only" }, { status: 400 });
    }

    const levelsJson =
      body.levels == null
        ? null
        : typeof body.levels === "string"
          ? body.levels
          : JSON.stringify(body.levels);

    const entry = numOrNull(body.entry);
    const sl = numOrNull(body.sl);
    const tp = numOrNull(body.tp);
    const lot = numOrNull(body.lot) ?? 0.01;
    const hold = numOrNull(body.hold_seconds);
    const margin = numOrNull(body.margin);
    const pnl = numOrNull(body.pnl);
    const balance = numOrNull(body.balance);
    const equity = numOrNull(body.equity);
    const bias = body.bias != null ? String(body.bias) : null;
    const sessionWindow = body.session_window != null ? String(body.session_window) : null;
    const notes = body.notes != null ? String(body.notes) : null;
    const rawJson = JSON.stringify(body);

    // Ensure table exists (idempotent) so first report works before manual migrate.
    await tursoQuery(`
      CREATE TABLE IF NOT EXISTS yellow_reports (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        symbol TEXT DEFAULT 'XAUUSD',
        bias TEXT,
        levels TEXT,
        decision TEXT,
        entry REAL,
        sl REAL,
        tp REAL,
        lot REAL DEFAULT 0.01,
        hold_seconds INTEGER,
        margin REAL,
        pnl REAL,
        balance REAL,
        equity REAL,
        session_window TEXT,
        notes TEXT,
        raw_json TEXT
      )
    `);

    await tursoQuery(
      `INSERT INTO yellow_reports
        (symbol, bias, levels, decision, entry, sl, tp, lot, hold_seconds, margin, pnl, balance, equity, session_window, notes, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        symbol,
        bias,
        levelsJson,
        decision,
        entry,
        sl,
        tp,
        lot,
        hold,
        margin,
        pnl,
        balance,
        equity,
        sessionWindow,
        notes,
        rawJson,
      ]
    );

    // Mirror take decisions into trades journal when we have an entry.
    let tradeId: string | null = null;
    if (decision === "take" && entry != null) {
      await tursoExecIgnoreDup(`ALTER TABLE trades ADD COLUMN source TEXT DEFAULT 'legacy'`);

      const direction = String(body.direction ?? (bias?.toLowerCase().includes("bear") ? "SELL" : "BUY")).toUpperCase();
      const dir = direction === "SELL" ? "SELL" : "BUY";
      let result = "PENDING";
      let closePrice: number | null = null;
      if (pnl != null) {
        result = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BREAKEVEN";
        closePrice = entry; // unknown exact close — journal shows entry + pnl
      }

      const account = process.env.YELLOW_MT5_LOGIN ?? "10013006443";
      const id = createHash("sha256")
        .update(`${Date.now()}:${entry}:${sl}:${tp}:${pnl}:${notes ?? ""}`)
        .digest("hex")
        .slice(0, 16);

      try {
        await tursoQuery(
          `INSERT INTO trades
            (id, direction, symbol, entry, sl, tp, close_price, result, rr, volume, profit, account, opened_at, closed_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'yellow')`,
          [
            id,
            dir,
            symbol,
            entry,
            sl,
            tp,
            closePrice,
            result,
            null,
            lot,
            pnl,
            account,
            result === "PENDING" ? null : new Date().toISOString(),
          ]
        );
        tradeId = id;
      } catch (e) {
        // Legacy trades.id may be integer AUTOINCREMENT — try without explicit id / source.
        try {
          await tursoQuery(
            `INSERT INTO trades
              (direction, symbol, entry, sl, tp, close_price, result, volume, profit, account, opened_at, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S','now'), ?)`,
            [
              dir,
              symbol,
              entry,
              sl,
              tp,
              closePrice,
              result,
              lot,
              pnl,
              account,
              result === "PENDING" ? null : new Date().toISOString().replace("T", " ").slice(0, 19),
            ]
          );
          tradeId = "legacy-insert";
        } catch (e2) {
          // Report still saved; journal mirror best-effort.
          console.warn("yellow report: trade mirror failed", e2);
        }
      }
    }

    return NextResponse.json({ ok: true, decision, tradeId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
