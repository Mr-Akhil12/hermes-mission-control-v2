"use client";

import { useState, useEffect, useCallback } from "react";
import { TrendingUp, TrendingDown, Activity, Target, RefreshCw, BookOpen, AlertTriangle } from "lucide-react";
import { fmtSAST } from "@/lib/time";

type Trade = {
  id: number;
  direction: "BUY" | "SELL";
  symbol: string;
  entry: number;
  sl: number | null;
  tp: number | null;
  close_price: number | null;
  result: "WIN" | "LOSS" | "BREAKEVEN" | "PENDING";
  rr: number | null;
  volume: number | null;
  profit: number | null;
  account: string;
  opened_at: string | null;
  closed_at: string | null;
};

type Strategy = {
  id: number;
  title: string;
  body: string;
  updated_at: string | null;
};

export default function TradingPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [strategy, setStrategy] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/trading", { cache: "no-store" });
      const data = await res.json();
      setTrades(data?.trades ?? []);
      setStrategy(data?.strategy ?? []);
      setError(null);
    } catch (e) {
      setError(`Failed to load trading data: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const closed = trades.filter((t) => t.result !== "PENDING" && t.profit != null);
  const wins = closed.filter((t) => t.result === "WIN");
  const losses = closed.filter((t) => t.result === "LOSS");
  const totalPnl = closed.reduce((s, t) => s + (t.profit ?? 0), 0);
  const winRate = closed.length ? Math.round((wins.length / closed.length) * 100) : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.profit ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + (t.profit ?? 0), 0) / losses.length : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : avgWin > 0 ? 99 : 0;
  const pending = trades.filter((t) => t.result === "PENDING").length;

  // Risk meter: 0-100 based on recent loss streak + drawdown
  const recent = closed.slice(0, 10);
  const lossStreak = (() => {
    let streak = 0;
    for (const t of recent) {
      if (t.result === "LOSS") streak++;
      else break;
    }
    return streak;
  })();
  const riskScore = Math.min(100, lossStreak * 12 + (totalPnl < 0 ? 20 : 0) + (winRate < 40 ? 15 : 0));
  const riskLabel = riskScore < 30 ? "Low" : riskScore < 60 ? "Moderate" : "High";
  const riskColor = riskScore < 30 ? "var(--green)" : riskScore < 60 ? "var(--amber)" : "var(--red)";

  const fmt = (n: number | null | undefined, digits = 2) =>
    n == null ? "—" : n.toLocaleString("en-ZA", { minimumFractionDigits: digits, maximumFractionDigits: digits });

  const fmtDate = (d: string | null) => {
    if (!d) return "—";
    return fmtSAST(d.replace(" ", "T") + "Z");
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6" style={{ color: "var(--accent)" }} />
          <div>
            <h1 className="text-2xl font-bold">Trading</h1>
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              {closed.length} closed trades · {pending} pending · live XAUUSD scalps
            </p>
          </div>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error && (
        <div className="card border px-4 py-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--red) 40%, transparent)", color: "var(--red)" }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>
          Loading trading data…
        </div>
      ) : (
        <>
          {/* Stats row */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                <TrendingUp className="h-4 w-4" /> Net P&L
              </div>
              <div className="mt-2 text-2xl font-bold" style={{ color: totalPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                {totalPnl >= 0 ? "+" : ""}${fmt(totalPnl)}
              </div>
              <div className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>{closed.length} closed trades</div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                <Target className="h-4 w-4" /> Win rate
              </div>
              <div className="mt-2 text-2xl font-bold">{winRate}%</div>
              <div className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>{wins.length}W / {losses.length}L</div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                <BookOpen className="h-4 w-4" /> Profit factor
              </div>
              <div className="mt-2 text-2xl font-bold">{profitFactor >= 99 ? "∞" : fmt(profitFactor, 2)}</div>
              <div className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
                avg win ${fmt(avgWin)} · avg loss ${fmt(avgLoss)}
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                <AlertTriangle className="h-4 w-4" /> Risk meter
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)" }}>
                  <div className="h-full rounded-full" style={{ width: `${riskScore}%`, background: riskColor }} />
                </div>
                <span className="text-sm font-bold" style={{ color: riskColor }}>{riskLabel}</span>
              </div>
              <div className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
                {lossStreak > 0 ? `${lossStreak}-loss streak` : "no active streak"}
              </div>
            </div>
          </div>

          {/* Recent trades */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              Recent trades ({trades.length})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                    <th className="pb-2 pr-3">Time</th>
                    <th className="pb-2 pr-3">Dir</th>
                    <th className="pb-2 pr-3">Symbol</th>
                    <th className="pb-2 pr-3 text-right">Entry</th>
                    <th className="pb-2 pr-3 text-right">Close</th>
                    <th className="pb-2 pr-3 text-right">P&L</th>
                    <th className="pb-2 pr-3">Result</th>
                    <th className="pb-2">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 20).map((t) => (
                    <tr key={t.id} className="border-t" style={{ borderColor: "var(--card-border)" }}>
                      <td className="py-2 pr-3 text-xs" style={{ color: "var(--text-dim)" }}>{fmtDate(t.opened_at)}</td>
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-1 text-xs font-bold" style={{ color: t.direction === "BUY" ? "var(--green)" : "var(--red)" }}>
                          {t.direction === "BUY" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                          {t.direction}
                        </span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{t.symbol}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(t.entry)}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(t.close_price)}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs font-semibold" style={{ color: (t.profit ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                        {t.profit == null ? "—" : `${t.profit >= 0 ? "+" : ""}$${fmt(t.profit)}`}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
                          style={{
                            background: t.result === "WIN" ? "rgba(61,220,151,0.12)" : t.result === "LOSS" ? "rgba(255,92,92,0.12)" : "rgba(255,193,7,0.12)",
                            color: t.result === "WIN" ? "var(--green)" : t.result === "LOSS" ? "var(--red)" : "var(--amber)",
                          }}
                        >
                          {t.result}
                        </span>
                      </td>
                      <td className="py-2 text-xs" style={{ color: "var(--text-faint)" }}>{t.account}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Strategy notes */}
          {strategy.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                Strategy notes ({strategy.length})
              </h2>
              <div className="space-y-3">
                {strategy.map((s) => (
                  <div key={s.id} className="rounded-lg border p-4" style={{ borderColor: "var(--card-border)" }}>
                    <div className="text-sm font-semibold">{s.title}</div>
                    <div className="mt-1 whitespace-pre-wrap text-xs" style={{ color: "var(--text-dim)" }}>{s.body}</div>
                    {s.updated_at && (
                      <div className="mt-2 text-[10px]" style={{ color: "var(--text-faint)" }}>Updated {s.updated_at}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
