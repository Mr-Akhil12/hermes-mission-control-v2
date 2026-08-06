"use client";

import { TrendingUp, LineChart as LineChartIcon } from "lucide-react";

export default function TradingPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <TrendingUp className="h-6 w-6" style={{ color: "var(--accent)" }} /> Trading Mastery
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>XAUUSD journal, P&L, strategy panel — Phase 2, wired to Turso.</p>
      </div>
      <div className="card flex flex-col items-center justify-center gap-3 p-16 text-center">
        <LineChartIcon className="h-8 w-8" style={{ color: "var(--text-faint)" }} />
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Live ticker, journal table (17:30–19:00 SAST window), P&L chart, and risk meter connect to the trades table in Phase 2.
        </p>
      </div>
    </div>
  );
}
