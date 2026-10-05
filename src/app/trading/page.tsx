"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  ExternalLink,
  Clock,
  ShieldAlert,
  Target,
  Activity,
  SkipForward,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { fmtSAST } from "@/lib/time";

type Trade = {
  id: number | string;
  direction: "BUY" | "SELL" | string;
  symbol: string;
  entry: number | string | null;
  sl: number | string | null;
  tp: number | string | null;
  close_price: number | string | null;
  result: "WIN" | "LOSS" | "BREAKEVEN" | "PENDING" | string;
  rr: number | string | null;
  volume: number | string | null;
  profit: number | string | null;
  account: string;
  opened_at: string | null;
  closed_at: string | null;
  source?: string | null;
};

type Strategy = {
  id: number | string;
  title: string;
  body: string;
  updated_at: string | null;
};

type Session = {
  phase: "IN_WINDOW" | "COUNTDOWN" | "OUT_OF_WINDOW";
  label: string;
  windowLabel: string | null;
  sastNow: string;
  sastDate: string;
  minutesToNext: number | null;
  inWindow: boolean;
};

type Day = {
  state: "ACTIVE" | "LOCKED_LOSS" | "IDLE";
  todayLosses: number;
  todayWins: number;
  todayPnl: number;
};

type Account = {
  login: string;
  server: string;
  mode: "DEMO" | "LIVE";
  leverage: string;
  maxLot: number;
  mt5Url: string;
  startingBalanceHint: number;
  balance: number;
  equity: number;
  margin: number | null;
};

type LastReport = {
  id?: string;
  created_at?: string;
  bias?: string | null;
  levels?: string | null;
  decision?: string | null;
  entry?: number | string | null;
  sl?: number | string | null;
  tp?: number | string | null;
  lot?: number | string | null;
  hold_seconds?: number | string | null;
  margin?: number | string | null;
  pnl?: number | string | null;
  balance?: number | string | null;
  equity?: number | string | null;
  session_window?: string | null;
  notes?: string | null;
  symbol?: string | null;
} | null;

function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null) return "—";
  return v.toLocaleString("en-ZA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function parseLevels(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export default function TradingPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [strategy, setStrategy] = useState<Strategy[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [day, setDay] = useState<Day | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [lastReport, setLastReport] = useState<LastReport>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/trading", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setTrades(data?.trades ?? []);
      setStrategy(data?.strategy ?? []);
      setSession(data?.session ?? null);
      setDay(data?.day ?? null);
      setAccount(data?.account ?? null);
      setLastReport(data?.lastReport ?? null);
      setError(null);
    } catch (e) {
      setError(`Failed to load Yellow cockpit: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  // Local countdown tick between polls
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const closed = trades.filter((t) => String(t.result).toUpperCase() !== "PENDING" && n(t.profit) != null);
  const wins = closed.filter((t) => String(t.result).toUpperCase() === "WIN");
  const losses = closed.filter((t) => String(t.result).toUpperCase() === "LOSS");
  const totalPnl = closed.reduce((s, t) => s + (n(t.profit) ?? 0), 0);
  const winRate = closed.length ? Math.round((wins.length / closed.length) * 100) : 0;

  const levels = useMemo(() => parseLevels(lastReport?.levels ?? null), [lastReport]);
  const decision = String(lastReport?.decision ?? "").toLowerCase();
  const reportPnl = n(lastReport?.pnl);
  const reportMargin = n(lastReport?.margin) ?? account?.margin ?? null;

  const dayState = day?.state ?? "IDLE";
  const dayColor =
    dayState === "LOCKED_LOSS" ? "var(--red)" : dayState === "ACTIVE" ? "var(--green)" : "var(--text-faint)";
  const sessionColor =
    session?.phase === "IN_WINDOW"
      ? "var(--green)"
      : session?.phase === "COUNTDOWN"
        ? "var(--amber)"
        : "var(--text-faint)";

  const countdownLabel = useMemo(() => {
    void tick;
    if (!session || session.minutesToNext == null) return null;
    const totalSec = Math.max(0, Math.floor(session.minutesToNext * 60));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }, [session, tick]);

  const fmtDate = (d: string | null) => {
    if (!d) return "—";
    const iso = d.includes("T") ? d : d.replace(" ", "T") + (d.endsWith("Z") ? "" : "Z");
    return fmtSAST(iso);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Header / account strip */}
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-black"
              style={{ background: "rgba(232,197,0,0.18)", color: "var(--tape)" }}
              title="Yellow"
            >
              Y
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold">Yellow</h1>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{ background: "rgba(232,197,0,0.15)", color: "var(--tape)" }}
                >
                  XAUUSD
                </span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{
                    background:
                      account?.mode === "LIVE" ? "rgba(214,59,59,0.15)" : "rgba(13,158,110,0.15)",
                    color: account?.mode === "LIVE" ? "var(--red)" : "var(--green)",
                  }}
                >
                  {account?.mode ?? "DEMO"}
                </span>
              </div>
              <p className="mt-1 text-xs" style={{ color: "var(--text-dim)" }}>
                {account?.server ?? "MetaQuotes-Demo"} · login{" "}
                <span className="font-mono">{account?.login ?? "—"}</span> · {account?.leverage ?? "1:500"} ·
                max lot {account?.maxLot ?? 0.01}
              </p>
              <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
                Follow + journal only — no auto-trade from this dashboard.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={account?.mt5Url ?? "https://web.metatrader.app/terminal"}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium"
              style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
            >
              Open MT5 Web <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              onClick={load}
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--card-border)" }}>
            <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              Balance
            </div>
            <div className="mt-0.5 font-mono text-lg font-semibold">${fmt(account?.balance)}</div>
          </div>
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--card-border)" }}>
            <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              Equity
            </div>
            <div className="mt-0.5 font-mono text-lg font-semibold">${fmt(account?.equity)}</div>
          </div>
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--card-border)" }}>
            <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              Margin
            </div>
            <div className="mt-0.5 font-mono text-lg font-semibold">
              {reportMargin == null ? "—" : `$${fmt(reportMargin)}`}
            </div>
          </div>
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--card-border)" }}>
            <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              Lot cap
            </div>
            <div className="mt-0.5 font-mono text-lg font-semibold">{account?.maxLot ?? 0.01}</div>
          </div>
        </div>
      </div>

      {error && (
        <div
          className="card border px-4 py-3 text-sm"
          style={{ borderColor: "color-mix(in srgb, var(--red) 40%, transparent)", color: "var(--red)" }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>
          Loading Yellow cockpit…
        </div>
      ) : (
        <>
          {/* Session + day state */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                <Clock className="h-4 w-4" /> Session clock · SAST
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-3">
                <span className="text-2xl font-bold" style={{ color: sessionColor }}>
                  {session?.label ?? "—"}
                </span>
                <span className="font-mono text-sm" style={{ color: "var(--text-dim)" }}>
                  {session?.sastNow ?? "—"}
                </span>
              </div>
              <p className="mt-1 text-xs" style={{ color: "var(--text-dim)" }}>
                {session?.windowLabel ?? "Windows: 06:00–08:00 · 18:00–20:00 SAST"}
              </p>
              {session?.phase !== "IN_WINDOW" && countdownLabel && (
                <p className="mt-2 text-sm font-medium" style={{ color: "var(--amber)" }}>
                  Next window in {countdownLabel}
                </p>
              )}
            </div>

            <div className="card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                {dayState === "LOCKED_LOSS" ? <Lock className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
                Day state
              </div>
              <div className="mt-2 text-2xl font-bold" style={{ color: dayColor }}>
                {dayState}
              </div>
              <p className="mt-1 text-xs" style={{ color: "var(--text-dim)" }}>
                Today {day?.todayWins ?? 0}W / {day?.todayLosses ?? 0}L · P&amp;L $
                {fmt(day?.todayPnl ?? 0)}
                {dayState === "LOCKED_LOSS" ? " · one loss rule — done for today" : ""}
                {dayState === "IDLE" ? " · outside window" : ""}
                {dayState === "ACTIVE" ? " · hunting gold" : ""}
              </p>
            </div>
          </div>

          {/* Bias / levels / skip-take / plan */}
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="card p-5 lg:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                  <Target className="h-4 w-4" /> Levels · bias
                </div>
                {lastReport?.created_at && (
                  <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                    report {fmtDate(lastReport.created_at)}
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span
                  className="rounded-lg px-2.5 py-1 text-sm font-bold uppercase"
                  style={{
                    background: "rgba(124,108,255,0.12)",
                    color: "var(--accent)",
                  }}
                >
                  {lastReport?.bias ? String(lastReport.bias) : "No bias yet"}
                </span>
                {lastReport?.session_window && (
                  <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                    window {lastReport.session_window}
                  </span>
                )}
              </div>
              <div className="mt-3 rounded-lg border p-3 font-mono text-xs" style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}>
                {levels == null ? (
                  <span>Waiting for Yellow levels…</span>
                ) : typeof levels === "string" ? (
                  <pre className="whitespace-pre-wrap">{levels}</pre>
                ) : Array.isArray(levels) ? (
                  <ul className="space-y-1">
                    {levels.map((lv, i) => (
                      <li key={i}>{typeof lv === "object" ? JSON.stringify(lv) : String(lv)}</li>
                    ))}
                  </ul>
                ) : (
                  <pre className="whitespace-pre-wrap">{JSON.stringify(levels, null, 2)}</pre>
                )}
              </div>
              {lastReport?.notes && (
                <p className="mt-3 text-xs" style={{ color: "var(--text-dim)" }}>
                  {lastReport.notes}
                </p>
              )}
            </div>

            <div className="card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                <Activity className="h-4 w-4" /> Decision
              </div>
              <div className="mt-3 flex gap-2">
                <div
                  className="flex flex-1 flex-col items-center rounded-lg border px-2 py-3"
                  style={{
                    borderColor: decision === "skip" ? "var(--amber)" : "var(--card-border)",
                    background: decision === "skip" ? "rgba(185,123,0,0.1)" : "transparent",
                  }}
                >
                  <SkipForward className="h-5 w-5" style={{ color: decision === "skip" ? "var(--amber)" : "var(--text-faint)" }} />
                  <span className="mt-1 text-xs font-bold">SKIP</span>
                </div>
                <div
                  className="flex flex-1 flex-col items-center rounded-lg border px-2 py-3"
                  style={{
                    borderColor: decision === "take" ? "var(--green)" : "var(--card-border)",
                    background: decision === "take" ? "rgba(13,158,110,0.1)" : "transparent",
                  }}
                >
                  <CheckCircle2 className="h-5 w-5" style={{ color: decision === "take" ? "var(--green)" : "var(--text-faint)" }} />
                  <span className="mt-1 text-xs font-bold">TAKE</span>
                </div>
              </div>

              <div className="mt-4 space-y-1.5 text-xs" style={{ color: "var(--text-dim)" }}>
                <div className="flex justify-between gap-2">
                  <span>Entry</span>
                  <span className="font-mono font-semibold" style={{ color: "var(--text)" }}>
                    {fmt(n(lastReport?.entry), 2)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>SL</span>
                  <span className="font-mono" style={{ color: "var(--red)" }}>
                    {fmt(n(lastReport?.sl), 2)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>TP</span>
                  <span className="font-mono" style={{ color: "var(--green)" }}>
                    {fmt(n(lastReport?.tp), 2)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Lot</span>
                  <span className="font-mono">{fmt(n(lastReport?.lot) ?? account?.maxLot ?? 0.01, 2)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Hold</span>
                  <span className="font-mono">
                    {n(lastReport?.hold_seconds) == null ? "—" : `${n(lastReport?.hold_seconds)}s`}
                  </span>
                </div>
                <div className="flex justify-between gap-2 border-t pt-2" style={{ borderColor: "var(--card-border)" }}>
                  <span>P&amp;L</span>
                  <span
                    className="font-mono font-semibold"
                    style={{ color: (reportPnl ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}
                  >
                    {reportPnl == null ? "—" : `${reportPnl >= 0 ? "+" : ""}$${fmt(reportPnl)}`}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="card p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                Net P&amp;L (journal)
              </div>
              <div className="mt-1 text-xl font-bold" style={{ color: totalPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                {totalPnl >= 0 ? "+" : ""}${fmt(totalPnl)}
              </div>
            </div>
            <div className="card p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                Win rate
              </div>
              <div className="mt-1 text-xl font-bold">
                {winRate}% <span className="text-xs font-normal" style={{ color: "var(--text-faint)" }}>({wins.length}W / {losses.length}L)</span>
              </div>
            </div>
            <div className="card p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                Journal rows
              </div>
              <div className="mt-1 text-xl font-bold">{trades.length}</div>
            </div>
          </div>

          {/* Journal */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              Journal ({trades.length}) · Yellow preferred
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
                    <th className="pb-2 pr-3 text-right">P&amp;L</th>
                    <th className="pb-2 pr-3">Result</th>
                    <th className="pb-2">Src</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-xs" style={{ color: "var(--text-faint)" }}>
                        No trades yet — Yellow reports with decision=take land here.
                      </td>
                    </tr>
                  ) : (
                    trades.slice(0, 40).map((t) => {
                      const profit = n(t.profit);
                      const result = String(t.result).toUpperCase();
                      return (
                        <tr key={String(t.id)} className="border-t" style={{ borderColor: "var(--card-border)" }}>
                          <td className="py-2 pr-3 text-xs" style={{ color: "var(--text-dim)" }}>
                            {fmtDate(t.opened_at)}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className="flex items-center gap-1 text-xs font-bold"
                              style={{ color: String(t.direction).toUpperCase() === "BUY" ? "var(--green)" : "var(--red)" }}
                            >
                              {String(t.direction).toUpperCase() === "BUY" ? (
                                <TrendingUp className="h-3 w-3" />
                              ) : (
                                <TrendingDown className="h-3 w-3" />
                              )}
                              {t.direction}
                            </span>
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">{t.symbol}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(n(t.entry))}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(n(t.close_price))}</td>
                          <td
                            className="py-2 pr-3 text-right font-mono text-xs font-semibold"
                            style={{ color: (profit ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}
                          >
                            {profit == null ? "—" : `${profit >= 0 ? "+" : ""}$${fmt(profit)}`}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
                              style={{
                                background:
                                  result === "WIN"
                                    ? "rgba(61,220,151,0.12)"
                                    : result === "LOSS"
                                      ? "rgba(255,92,92,0.12)"
                                      : "rgba(255,193,7,0.12)",
                                color:
                                  result === "WIN"
                                    ? "var(--green)"
                                    : result === "LOSS"
                                      ? "var(--red)"
                                      : "var(--amber)",
                              }}
                            >
                              {result}
                            </span>
                          </td>
                          <td className="py-2 text-xs" style={{ color: "var(--text-faint)" }}>
                            {t.source ?? t.account ?? "—"}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Rules */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              Rules · Yellow
            </h2>
            <div className="space-y-3">
              {strategy.map((s) => (
                <div key={String(s.id)} className="rounded-lg border p-4" style={{ borderColor: "var(--card-border)" }}>
                  <div className="text-sm font-semibold">{s.title}</div>
                  <div className="mt-1 whitespace-pre-wrap text-xs" style={{ color: "var(--text-dim)" }}>
                    {s.body}
                  </div>
                  {s.updated_at && (
                    <div className="mt-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
                      Updated {s.updated_at}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
