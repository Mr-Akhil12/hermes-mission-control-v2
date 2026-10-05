import { NextResponse } from "next/server";
import { tursoConfigured, tursoQuery } from "@/lib/turso-trading";
import {
  computeDayState,
  getSessionClock,
  yellowAccountFromEnv,
  YELLOW_RULES,
  YELLOW_RULES_FALLBACK,
} from "@/lib/yellow";

export const dynamic = "force-dynamic";

async function loadTrades(): Promise<Record<string, unknown>[]> {
  // Prefer Yellow-sourced rows when `source` column exists; fall back without it.
  try {
    return await tursoQuery(
      `SELECT id, direction, symbol, entry, sl, tp, close_price, result, rr, volume, profit, account, opened_at, closed_at, source
       FROM trades
       ORDER BY
         CASE WHEN lower(coalesce(source,'')) = 'yellow' THEN 0 ELSE 1 END,
         opened_at DESC
       LIMIT 200`
    );
  } catch {
    return await tursoQuery(
      `SELECT id, direction, symbol, entry, sl, tp, close_price, result, rr, volume, profit, account, opened_at, closed_at
       FROM trades ORDER BY opened_at DESC LIMIT 200`
    );
  }
}

async function loadStrategy(): Promise<Record<string, unknown>[]> {
  try {
    return await tursoQuery(
      "SELECT id, title, body, updated_at FROM strategy ORDER BY updated_at DESC LIMIT 20"
    );
  } catch {
    return [];
  }
}

async function loadLastReport(): Promise<Record<string, unknown> | null> {
  try {
    const rows = await tursoQuery(
      `SELECT id, created_at, symbol, bias, levels, decision, entry, sl, tp, lot,
              hold_seconds, margin, pnl, balance, equity, session_window, notes
       FROM yellow_reports ORDER BY created_at DESC LIMIT 1`
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    if (!tursoConfigured()) {
      return NextResponse.json({ error: "Turso not configured" }, { status: 503 });
    }

    const clock = getSessionClock();
    const account = yellowAccountFromEnv();

    const [trades, strategyRows, lastReport] = await Promise.all([
      loadTrades(),
      loadStrategy(),
      loadLastReport(),
    ]);

    const { dayState, todayLosses, todayWins, todayPnl } = computeDayState(
      trades as Parameters<typeof computeDayState>[0],
      clock
    );

    const strategy =
      strategyRows.length > 0
        ? strategyRows
        : YELLOW_RULES_FALLBACK.map((r, i) => ({
            id: `yellow-fallback-${i}`,
            title: r.title,
            body: r.body,
            updated_at: null,
          }));

    // Account strip numbers: prefer last report balance/equity/margin, else hints.
    const balance =
      lastReport?.balance != null ? Number(lastReport.balance) : account.startingBalanceHint;
    const equity =
      lastReport?.equity != null
        ? Number(lastReport.equity)
        : lastReport?.pnl != null
          ? balance + Number(lastReport.pnl)
          : balance;
    const margin = lastReport?.margin != null ? Number(lastReport.margin) : null;

    return NextResponse.json({
      source: "turso",
      rules: YELLOW_RULES,
      account: {
        ...account,
        balance,
        equity,
        margin,
      },
      session: clock,
      day: {
        state: dayState,
        todayLosses,
        todayWins,
        todayPnl,
      },
      lastReport,
      trades,
      strategy,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
