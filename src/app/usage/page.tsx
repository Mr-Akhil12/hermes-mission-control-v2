"use client";

// Ollama Cloud Usage — site-styled usage analytics.
//
// Two real data sources, labelled honestly:
//  • "Ollama account" — live meter from ollama.com/api/usage + /api/me with the
//    account's real API key (plan, monthly $ usage, per-model request counts).
//    Ollama's API has NO daily breakdown — the meter is a monthly snapshot.
//  • "Local ledger" — the gateway's session_model_usage table: the agent core
//    upserts a true delta per API call (tokens sum exactly). This powers the
//    date-range series, per-model split, and per-task split.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, BadgeCheck, BarChart3, Coins, CreditCard, Layers, Loader2,
  Mail, TrendingUp, Zap,
} from "lucide-react";
import { fmtSAST } from "@/lib/time";

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
  per_model: { model: string; tokens_in: number; tokens_out: number; requests: number; cost_usd: number }[];
  per_task: { task: string; requests: number; tokens_in: number; tokens_out: number }[];
  totals: {
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    reasoning: number;
    requests: number;
    cost_usd: number;
    sessions: number;
  };
  live: {
    email?: string | null;
    name?: string | null;
    plan?: string | null;
    usage_fraction?: number;
    credits_pool_usd?: number | null;
    credits_used_usd?: number | null;
    monthly_window?: { type?: string; starting_at?: string; ending_at?: string };
    models?: { model: string; requests: number }[];
    error?: string;
  } | null;
};

type Mode = "day" | "week" | "month" | "custom";

const C_IN = "var(--accent-2)";
const C_OUT = "var(--accent)";
const C_COST = "var(--green)";

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

// ── Dual area chart (tokens in / out), site tokens for colors ──
function DualAreaChart({ series, mode }: { series: Point[]; mode: Mode }) {
  const W = 900;
  const H = 260;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 14;
  const PAD_B = 34;

  if (series.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm" style={{ color: "var(--text-faint)" }}>
        No usage in this window
      </div>
    );
  }

  const maxVal = Math.max(1, ...series.map((p) => Math.max(p.tokens_in, p.tokens_out)));
  const n = series.length;
  const iw = W - 56 - 16;
  const ih = H - 14 - 34;
  const x = (i: number) => 56 + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => 14 + ih - (v / maxVal) * ih;

  const path = (key: "tokens_in" | "tokens_out") =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = (key: "tokens_in" | "tokens_out") =>
    `${path(key)} L${x(n - 1).toFixed(1)},${(14 + ih).toFixed(1)} L${x(0).toFixed(1)},${(14 + ih).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <defs>
        <linearGradient id="uIn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C_IN} stopOpacity="0.22" />
          <stop offset="100%" stopColor={C_IN} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="uOut" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C_OUT} stopOpacity="0.22" />
          <stop offset="100%" stopColor={C_OUT} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((f, gi) => (
        <g key={gi}>
          <line x1={56} x2={W - 16} y1={y(f * maxVal)} y2={y(f * maxVal)} stroke="var(--card-border)" strokeWidth="1" />
          <text x={48} y={y(f * maxVal) + 4} textAnchor="end" fontSize="11" fill="var(--text-faint)">
            {fmtTokens(f * maxVal)}
          </text>
        </g>
      ))}
      <path d={area("tokens_in")} fill="url(#uIn)" />
      <path d={area("tokens_out")} fill="url(#uOut)" />
      <path d={path("tokens_in")} fill="none" stroke={C_IN} strokeWidth="2" />
      <path d={path("tokens_out")} fill="none" stroke={C_OUT} strokeWidth="2" />
      {series.map((p, i) => {
        const step = mode === "day" && n > 16 ? Math.ceil(n / 12) : 1;
        if (i % step !== 0 && i !== n - 1) return null;
        return (
          <text key={i} x={x(i)} y={H - 10} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)">
            {labelFor(p.bucket, mode)}
          </text>
        );
      })}
    </svg>
  );
}

function RequestBars({ series, mode }: { series: Point[]; mode: Mode }) {
  const W = 900;
  const H = 170;
  const PAD_L = 52;
  const PAD_R = 16;
  const PAD_T = 12;
  const PAD_B = 30;

  if (series.length === 0) {
    return (
      <div className="flex h-[150px] items-center justify-center text-sm" style={{ color: "var(--text-faint)" }}>
        No requests in this window
      </div>
    );
  }

  const n = series.length;
  const maxReq = Math.max(1, ...series.map((p) => p.requests));
  const iw = W - PAD_L - PAD_R;
  const ih = H - PAD_T - PAD_B;
  const bw = Math.min(48, (iw / n) * 0.6);
  const x = (i: number) => PAD_L + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD_T + ih - (v / maxReq) * ih;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0, 0.5, 1].map((f, gi) => (
        <g key={gi}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(f * maxReq)} y2={y(f * maxReq)} stroke="var(--card-border)" strokeWidth="1" />
          <text x={PAD_L - 8} y={y(f * maxReq) + 4} textAnchor="end" fontSize="11" fill="var(--text-faint)">
            {Math.round(f * maxReq)}
          </text>
        </g>
      ))}
      {series.map((p, i) => (
        <rect
          key={i}
          x={x(i) - bw / 2}
          y={y(p.requests)}
          width={bw}
          height={PAD_T + ih - y(p.requests)}
          rx="3"
          fill={C_IN}
          fillOpacity="0.75"
        />
      ))}
      {series.map((p, i) => {
        const step = mode === "day" && n > 16 ? Math.ceil(n / 12) : 1;
        if (i % step !== 0 && i !== n - 1) return null;
        return (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)">
            {labelFor(p.bucket, mode)}
          </text>
        );
      })}
    </svg>
  );
}

function StatCard({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
        <span style={color ? { color } : undefined}>{icon}</span> {label}
      </div>
      <div className="mt-1 text-xl font-bold">{value}</div>
      {sub && <div className="text-xs" style={{ color: "var(--text-faint)" }}>{sub}</div>}
    </div>
  );
}

export default function UsagePage() {
  const [mode, setMode] = useState<Mode>("day");
  const [days, setDays] = useState(30);
  const [from, setFrom] = useState("2026-08-01");
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<UsageResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const query = useMemo(() => {
    const qs = new URLSearchParams({ provider: "ollama-cloud", bucket: mode });
    if (mode === "custom") {
      qs.set("from", from);
      qs.set("to", to);
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

  useEffect(() => {
    if (mode === "day") setDays(30);
    if (mode === "week") setDays(84);
    if (mode === "month") setDays(365);
  }, [mode]);

  const series = data?.series ?? [];
  const totals = data?.totals;
  const live = data?.live;
  const perModel = data?.per_model ?? [];
  const perTask = data?.per_task ?? [];

  const windowLabel = useMemo(() => {
    if (mode === "custom") return `${from} → ${to}`;
    if (mode === "week") return `last ${Math.ceil(days / 7)} weeks`;
    if (mode === "month") return "all months";
    return `last ${days} days`;
  }, [mode, days, from, to]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Activity className="h-6 w-6" style={{ color: "var(--accent)" }} />
          Ollama Cloud Usage
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Live account meter from ollama.com plus your agent&apos;s full call ledger. All times SAST.
        </p>
      </div>

      {err && (
        <div className="card p-4 text-sm" style={{ color: "var(--red)" }}>Could not load: {err}</div>
      )}

      {/* ── Live Ollama account meter ── */}
      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <CreditCard className="h-4 w-4" style={{ color: "var(--accent-2)" }} />
            Ollama account — live meter
          </div>
          {live?.plan && (
            <span
              className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase"
              style={{ background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}
            >
              {live.plan}
            </span>
          )}
        </div>
        {live && !live.error && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <div className="text-xs" style={{ color: "var(--text-faint)" }}>Account</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold">
                  <Mail className="h-3.5 w-3.5" style={{ color: "var(--text-faint)" }} />
                  <span className="truncate">{live.email ?? "—"}</span>
                  {live.plan === "pro" && <BadgeCheck className="h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />}
                </div>
              </div>
              <div>
                <div className="text-xs" style={{ color: "var(--text-faint)" }}>Credits used (Ollama&apos;s meter)</div>
                <div className="mt-0.5 text-lg font-bold">
                  {live.credits_used_usd != null
                    ? `$${live.credits_used_usd.toFixed(2)} of $${live.credits_pool_usd?.toFixed(0)}`
                    : `${((live.usage_fraction ?? 0) * 100).toFixed(1)}%`}
                </div>
                {live.credits_pool_usd != null && (
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--card-border)" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, (live.usage_fraction ?? 0) * 100)}%`,
                        background: (live.usage_fraction ?? 0) > 0.8 ? "var(--red)" : (live.usage_fraction ?? 0) > 0.5 ? "var(--amber)" : "var(--green)",
                      }}
                    />
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs" style={{ color: "var(--text-faint)" }}>Requests this window</div>
                <div className="mt-0.5 text-lg font-bold">
                  {(live.models ?? []).reduce((a, m) => a + (m.requests || 0), 0).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-xs" style={{ color: "var(--text-faint)" }}>Meter window</div>
                <div className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>
                  {live.monthly_window?.starting_at ? fmtSAST(live.monthly_window.starting_at) : "—"}
                  {" → "}
                  live
                </div>
              </div>
            </div>
            {(live.models ?? []).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {(live.models ?? []).map((m) => (
                  <span
                    key={m.model}
                    className="rounded-full px-2.5 py-1 text-xs"
                    style={{ background: "rgba(77,159,255,0.10)", color: "var(--accent-2)" }}
                  >
                    {m.model}: {m.requests.toLocaleString()} requests
                  </span>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs" style={{ color: "var(--text-faint)" }}>
              Ollama&apos;s API only exposes this monthly snapshot — no per-day breakdown exists on their side,
              so the date-range charts below come from your agent&apos;s own call ledger (every call is logged with exact tokens).
            </p>
          </>
        )}
        {live?.error && (
          <div className="text-sm" style={{ color: "var(--amber)" }}>Live meter unavailable: {live.error}</div>
        )}
      </div>

      {/* ── Mode switcher ── */}
      <div className="flex flex-wrap items-center gap-2">
        {(["day", "week", "month", "custom"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg border px-3.5 py-1.5 text-sm capitalize transition ${
              mode === m ? "border-[var(--accent)] text-[var(--accent)]" : ""
            }`}
            style={
              mode === m
                ? { background: "color-mix(in srgb, var(--accent) 12%, transparent)", borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)" }
                : { background: "var(--card)", borderColor: "var(--card-border)", color: "var(--text-dim)" }
            }
          >
            {m}
          </button>
        ))}
        {mode === "day" && (
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="rounded-lg border px-2.5 py-1.5 text-sm"
            style={{ background: "var(--bg-2)", borderColor: "var(--card-border)", color: "var(--text)" }}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={400}>All time</option>
          </select>
        )}
        {mode === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border px-2.5 py-1.5 text-sm"
              style={{ background: "var(--bg-2)", borderColor: "var(--card-border)", color: "var(--text)" }}
            />
            <span style={{ color: "var(--text-faint)" }}>→</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border px-2.5 py-1.5 text-sm"
              style={{ background: "var(--bg-2)", borderColor: "var(--card-border)", color: "var(--text)" }}
            />
          </div>
        )}
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>{windowLabel}</span>
        {loading && <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--accent)" }} />}
      </div>

      {/* ── Totals strip ── */}
      {totals && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div className="card p-4">
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
              <TrendingUp className="h-3.5 w-3.5" style={{ color: C_IN }} /> Tokens in
            </div>
            <div className="mt-1 text-xl font-bold">{fmtTokens(totals.tokens_in)}</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
              <TrendingUp className="h-3.5 w-3.5" style={{ color: C_OUT }} /> Tokens out
            </div>
            <div className="mt-1 text-xl font-bold">{fmtTokens(totals.tokens_out)}</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
              <Zap className="h-3.5 w-3.5" style={{ color: "var(--amber)" }} /> API calls
            </div>
            <div className="mt-1 text-xl font-bold">{fmtTokens(totals.requests)}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>{totals.sessions} sessions</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
              <Layers className="h-3.5 w-3.5" style={{ color: "var(--green)" }} /> Reasoning tokens
            </div>
            <div className="mt-1 text-xl font-bold">{fmtTokens(totals.reasoning)}</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
              <Coins className="h-3.5 w-3.5" style={{ color: "var(--green)" }} /> Ledger cost estimate
            </div>
            <div className="mt-1 text-xl font-bold">{fmtCost(totals.cost_usd)}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>cached rates · not Ollama&apos;s meter</div>
          </div>
        </div>
      )}

      {/* ── Token chart ── */}
      <div className="card p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="h-4 w-4" style={{ color: "var(--text-faint)" }} />
          Tokens per {mode === "custom" ? "day" : mode}
        </div>
        {!loading && (
          <>
            <DualAreaChart series={series} mode={mode} />
            <div className="mt-1 flex items-center gap-4 text-xs" style={{ color: "var(--text-faint)" }}>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: C_IN }} /> in
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: C_OUT }} /> out
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Requests chart ── */}
      <div className="card p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-3.5 w-3.5" style={{ color: "var(--text-faint)" }} />
          Requests per {mode === "custom" ? "day" : mode}
        </div>
        {!loading && <RequestBars series={series} mode={mode} />}
      </div>

      {/* ── Per-model breakdown ── */}
      {perModel.length > 0 && (
        <div className="card overflow-hidden">
          <div className="border-b p-4 text-sm font-semibold" style={{ borderColor: "var(--card-border)" }}>
            Per-model breakdown — {windowLabel}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs" style={{ color: "var(--text-faint)" }}>
                  <th className="p-3 text-left font-medium">Model</th>
                  <th className="p-3 text-right font-medium">Calls</th>
                  <th className="p-3 text-right font-medium">Tokens in</th>
                  <th className="p-3 text-right font-medium">Tokens out</th>
                  <th className="p-3 text-right font-medium">Est. cost (ledger)</th>
                </tr>
              </thead>
              <tbody>
                {perModel.map((m) => (
                  <tr key={m.model} className="border-t" style={{ borderColor: "var(--card-border)" }}>
                    <td className="p-3 font-medium">{m.model}</td>
                    <td className="p-3 text-right">{m.requests.toLocaleString()}</td>
                    <td className="p-3 text-right">{fmtTokens(m.tokens_in)}</td>
                    <td className="p-3 text-right">{fmtTokens(m.tokens_out)}</td>
                    <td className="p-3 text-right">{fmtCost(m.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Per-task split ── */}
      {perTask.length > 1 && (
        <div className="card p-4">
          <div className="mb-3 text-sm font-semibold">What consumed it — {windowLabel}</div>
          <div className="flex flex-wrap gap-2">
            {perTask.map((t) => (
              <span
                key={t.task}
                className="rounded-full px-3 py-1.5 text-xs"
                style={{
                  background: t.task === "main" ? "rgba(124,108,255,0.12)" : "rgba(255,180,84,0.10)",
                  color: t.task === "main" ? "var(--accent)" : "var(--amber)",
                }}
              >
                {t.task === "main" ? "agent chats" : t.task}: {fmtTokens(t.requests)} calls · in {fmtTokens(t.tokens_in)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}