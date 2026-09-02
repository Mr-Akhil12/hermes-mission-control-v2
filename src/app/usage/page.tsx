"use client";

// Usage analytics page — Ollama Cloud (and any billing provider) token in/out
// + request-count graphs. Pure SVG charts, zero new deps (matches the
// dashboard's style). Data: state server /api/usage (session_model_usage DB).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowLeft, BarChart3, Coins, Download, TrendingUp, Zap,
} from "lucide-react";

type Point = {
  bucket: string;
  tokens_in: number;
  tokens_out: number;
  requests: number;
  cost_usd: number;
};

type UsageResp = {
  provider: string;
  bucket: string;
  series: Point[];
  totals: {
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    requests: number;
    cost_usd: number;
  };
};

type Mode = "day" | "week" | "month" | "custom";

const BLUE = "#3b82f6";
const PURPLE = "#a855f7";

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd >= 100) return "$" + usd.toFixed(0);
  if (usd >= 1) return "$" + usd.toFixed(2);
  return "$" + usd.toFixed(3);
}

function labelFor(bucket: string, mode: Mode): string {
  if (mode === "month") return bucket; // 2026-09
  if (mode === "week") return bucket.replace(/^\d{4}-W/, "W");
  const [, m, d] = bucket.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1] ?? m} ${parseInt(d, 10)}`;
}

// ── Pure SVG line/area chart with two series (in blue, out purple) ──
function DualAreaChart({
  series,
  mode,
}: {
  series: Point[];
  mode: Mode;
}) {
  const W = 900;
  const H = 260;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 14;
  const PAD_B = 34;

  const maxVal = Math.max(
    1,
    ...series.map((p) => Math.max(p.tokens_in, p.tokens_out))
  );
  const n = series.length;
  const iw = W - PAD_L - PAD_R;
  const ih = H - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD_T + ih - (v / maxVal) * ih;

  const path = (key: "tokens_in" | "tokens_out") =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = (key: "tokens_in" | "tokens_out") =>
    `${path(key)} L${x(n - 1).toFixed(1)},${(PAD_T + ih).toFixed(1)} L${x(0).toFixed(1)},${(PAD_T + ih).toFixed(1)} Z`;

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxVal);

  if (n === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-zinc-500">
        No usage in this window
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <defs>
        <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={BLUE} stopOpacity="0.25" />
          <stop offset="100%" stopColor={BLUE} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={PURPLE} stopOpacity="0.25" />
          <stop offset="100%" stopColor={PURPLE} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {gridVals.map((v, gi) => (
        <g key={gi}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="#27272a" strokeWidth="1" />
          <text x={PAD_L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#71717a">
            {fmtTokens(v)}
          </text>
        </g>
      ))}
      <path d={area("tokens_in")} fill="url(#gIn)" />
      <path d={area("tokens_out")} fill="url(#gOut)" />
      <path d={path("tokens_in")} fill="none" stroke={BLUE} strokeWidth="2" />
      <path d={path("tokens_out")} fill="none" stroke={PURPLE} strokeWidth="2" />
      {series.map((p, i) => {
        // thin out labels on dense day charts
        const step = mode === "day" && n > 16 ? Math.ceil(n / 12) : 1;
        if (i % step !== 0 && i !== n - 1) return null;
        return (
          <text key={i} x={x(i)} y={H - 10} textAnchor="middle" fontSize="10.5" fill="#a1a1aa">
            {labelFor(p.bucket, mode)}
          </text>
        );
      })}
    </svg>
  );
}

// ── Bar chart for request counts ──
function RequestBars({ series, mode }: { series: Point[]; mode: Mode }) {
  const W = 900;
  const H = 180;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 12;
  const PAD_B = 30;
  const n = series.length;
  const maxReq = Math.max(1, ...series.map((p) => p.requests));
  const iw = W - PAD_L - PAD_R;
  const ih = H - PAD_T - PAD_B;
  const bw = n > 0 ? Math.min(48, (iw / n) * 0.6) : 12;
  const x = (i: number) => PAD_L + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD_T + ih - (v / maxReq) * ih;

  if (n === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center text-sm text-zinc-500">
        No requests in this window
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0, 0.5, 1].map((f, gi) => (
        <g key={gi}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(f * maxReq)} y2={y(f * maxReq)} stroke="#27272a" strokeWidth="1" />
          <text x={PAD_L - 8} y={y(f * maxReq) + 4} textAnchor="end" fontSize="11" fill="#71717a">
            {Math.round(f * maxReq)}
          </text>
        </g>
      ))}
      {series.map((p, i) => (
        <g key={i}>
          <rect
            x={x(i) - bw / 2}
            y={y(p.requests)}
            width={bw}
            height={PAD_T + ih - y(p.requests)}
            rx="3"
            fill={BLUE}
            fillOpacity="0.75"
          />
        </g>
      ))}
      {series.map((p, i) => {
        const step = mode === "day" && n > 16 ? Math.ceil(n / 12) : 1;
        if (i % step !== 0 && i !== n - 1) return null;
        return (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="#a1a1aa">
            {labelFor(p.bucket, mode)}
          </text>
        );
      })}
    </svg>
  );
}

export default function UsagePage() {
  const [mode, setMode] = useState<Mode>("day");
  const [days, setDays] = useState(30);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<UsageResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const query = useMemo(() => {
    const qs = new URLSearchParams({ provider: "ollama-cloud", bucket: mode });
    if (mode === "custom") {
      qs.set("from", from || "2026-08-01");
      qs.set("to", to || new Date().toISOString().slice(0, 10));
      qs.set("days", "400");
    } else {
      qs.set("days", String(days));
    }
    return qs.toString();
  }, [mode, days, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(`/api/chat/usage?${query}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || `HTTP ${res.status}`);
      setData(d);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto window per mode
  useEffect(() => {
    if (mode === "day") setDays(30);
    if (mode === "week") setDays(84);
    if (mode === "month") setDays(365);
  }, [mode]);

  const series = data?.series ?? [];
  const totals = data?.totals;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 transition hover:text-zinc-100"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </a>
            <div>
              <h1 className="flex items-center gap-2 text-lg font-semibold">
                <Activity className="h-5 w-5 text-blue-500" />
                Ollama Cloud Usage
              </h1>
              <p className="text-xs text-zinc-500">
                Tokens in / out and request counts — ground truth from the agent&apos;s billing ledger
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: BLUE }} /> In
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: PURPLE }} /> Out
            </span>
          </div>
        </div>

        {/* Mode switcher */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {(["day", "week", "month", "custom"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-lg border px-3.5 py-1.5 text-sm capitalize transition ${
                mode === m
                  ? "border-blue-500/60 bg-blue-500/10 text-blue-300"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {m}
            </button>
          ))}
          {mode === "day" && (
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-300"
            >
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          )}
          {mode === "custom" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-300"
              />
              <span className="text-zinc-600">→</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-300"
              />
            </div>
          )}
        </div>

        {/* Totals strip */}
        {totals && (
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <TrendingUp className="h-3.5 w-3.5 text-blue-400" /> Tokens in
              </div>
              <div className="mt-1 text-xl font-semibold">{fmtTokens(totals.tokens_in)}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <TrendingUp className="h-3.5 w-3.5 text-purple-400" /> Tokens out
              </div>
              <div className="mt-1 text-xl font-semibold">{fmtTokens(totals.tokens_out)}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Zap className="h-3.5 w-3.5 text-amber-400" /> Requests
              </div>
              <div className="mt-1 text-xl font-semibold">{fmtTokens(totals.requests)}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Coins className="h-3.5 w-3.5 text-emerald-400" /> Metered cost
              </div>
              <div className="mt-1 text-xl font-semibold">{fmtCost(totals.cost_usd)}</div>
            </div>
          </div>
        )}

        {err && (
          <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {err}
          </div>
        )}

        {/* Token chart */}
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-300">
            <BarChart3 className="h-4 w-4 text-zinc-500" />
            Tokens {mode === "custom" ? "per day" : `per ${mode}`} {loading && <span className="text-xs text-zinc-500">· loading…</span>}
          </div>
          {!loading && <DualAreaChart series={series} mode={mode} />}
        </div>

        {/* Requests chart */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-300">
            <Activity className="h-3.5 w-3.5 text-zinc-500" />
            Requests {mode === "custom" ? "per day" : `per ${mode}`}
          </div>
          {!loading && <RequestBars series={series} mode={mode} />}
        </div>
      </div>
    </div>
  );
}