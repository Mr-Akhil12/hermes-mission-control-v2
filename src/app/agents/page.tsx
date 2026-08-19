"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Network, Activity, Layers, Radio, Bot, MessageSquare, Clock,
  AlertCircle, RefreshCw, ArrowUpRight,
} from "lucide-react";
import { DEFAULT_MODEL } from "@/lib/models";
import { fmtSASTRelative } from "@/lib/time";

type Session = {
  id: string;
  source: string;
  title?: string | null;
  started_at?: string | number | null;
  ended_at?: string | number | null;
  is_active?: boolean;
  message_count?: number;
};

type AgentStat = {
  name: string;
  role: string;
  model: string;
  count: number;
  active: boolean;
  lastActivity: number | null;
  totalMessages: number;
};

const AGENT_DEFS = [
  { name: "SOL", role: "Important decisions / critical tasks", model: "gpt-5.6-sol" },
  { name: "LUNA", role: "Images + vision", model: "gpt-5.6-luna" },
  { name: "DEEPSEEK", role: "Daily driver / cron agent", model: DEFAULT_MODEL },
];

// Source → badge colors. subagent=purple, dashboard=blue, cron=amber,
// api_server=green, everything else dim.
const SOURCE_STYLES: Record<string, { bg: string; color: string }> = {
  subagent: { bg: "rgba(124,108,255,0.14)", color: "#8b7bff" },
  dashboard: { bg: "rgba(77,159,255,0.14)", color: "#4d9fff" },
  cron: { bg: "rgba(255,180,84,0.14)", color: "var(--amber)" },
  api_server: { bg: "rgba(61,220,151,0.14)", color: "var(--green)" },
};

function sourceStyle(source: string) {
  return SOURCE_STYLES[source] ?? { bg: "rgba(107,107,133,0.14)", color: "var(--text-faint)" };
}

function toTs(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (isNaN(n)) return null;
  // Hermes timestamps are epoch seconds; convert to ms for Date.
  return n < 1e12 ? n * 1000 : n;
}

function matchesAgent(s: Session, name: string): boolean {
  const title = s.title ?? "";
  if (name === "DEEPSEEK") {
    // DEEPSEEK is the default driver — everything not claimed by SOL/LUNA.
    return !/sol/i.test(title) && !/luna/i.test(title);
  }
  return new RegExp(name, "i").test(title);
}

export default function AgentsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async (): Promise<Session[]> => {
    const r = await fetch("/api/chat/sessions?source=all", { cache: "no-store" });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return (d.sessions ?? d.data ?? []) as Session[];
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSessions()
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchSessions]);

  const retry = () => {
    setLoading(true);
    setError(null);
    fetchSessions()
      .then((list) => setSessions(list))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  const totalSessions = sessions.length;
  const activeNow = sessions.filter((s) => s.is_active).length;
  const subagentSpawns = sessions.filter((s) => s.source === "subagent").length;
  const totalMessages = sessions.reduce((sum, s) => sum + (s.message_count ?? 0), 0);

  const agents: AgentStat[] = AGENT_DEFS.map((def) => {
    const matching = sessions.filter((s) => matchesAgent(s, def.name));
    const lastTs = matching.reduce<number | null>((acc, s) => {
      const t = toTs(s.started_at);
      return t !== null && (acc === null || t > acc) ? t : acc;
    }, null);
    return {
      ...def,
      count: matching.length,
      active: matching.some((s) => s.is_active),
      lastActivity: lastTs,
      totalMessages: matching.reduce((sum, s) => sum + (s.message_count ?? 0), 0),
    };
  });

  const recent = sessions.slice(0, 10);

  const stats = [
    { label: "Total Sessions", value: totalSessions, icon: Layers, color: "var(--accent)" },
    { label: "Active Now", value: activeNow, icon: Radio, color: "var(--green)" },
    { label: "Subagent Spawns", value: subagentSpawns, icon: Bot, color: "#8b7bff" },
    { label: "Total Messages", value: totalMessages, icon: MessageSquare, color: "var(--amber)" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Network className="h-6 w-6" style={{ color: "var(--accent)" }} /> Agents
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Real agent activity — sessions, spawns, and token usage from the live Hermes state.
        </p>
      </div>

      {loading && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card h-24 animate-pulse p-5" style={{ background: "color-mix(in srgb, var(--card) 60%, transparent)" }} />
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card h-40 animate-pulse p-5" style={{ background: "color-mix(in srgb, var(--card) 60%, transparent)" }} />
            ))}
          </div>
          <div className="card h-64 animate-pulse p-5" style={{ background: "color-mix(in srgb, var(--card) 60%, transparent)" }} />
        </div>
      )}

      {error && (
        <div className="card p-6">
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--red)" }}>
            <AlertCircle className="h-4 w-4" /> Could not load agent state
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>{error}</p>
          <button
            onClick={retry}
            className="mt-4 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold"
            style={{ background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)" }}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="card card-hover p-5">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                  <s.icon className="h-4 w-4" style={{ color: s.color }} /> {s.label}
                </div>
                <div className="mt-2 text-2xl font-bold">{s.value.toLocaleString()}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {agents.map((a) => (
              <div key={a.name} className="card card-hover p-5">
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold">{a.name}</span>
                  <span
                    className="flex items-center gap-1.5 text-xs font-medium"
                    style={{ color: a.active ? "var(--green)" : "var(--text-faint)" }}
                  >
                    <Activity className={`h-3.5 w-3.5 ${a.active ? "animate-pulse" : ""}`} />
                    {a.active ? "active" : "idle"}
                  </span>
                </div>
                <p className="mt-2 text-sm" style={{ color: "var(--text-dim)" }}>{a.role}</p>
                <div
                  className="mt-3 rounded-lg px-2 py-1 font-mono text-[11px]"
                  style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-faint)" }}
                >
                  {a.model}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-lg font-bold">{a.count}</div>
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Sessions</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold">{a.totalMessages}</div>
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Messages</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold" style={{ color: "var(--text-dim)" }}>
                      {a.lastActivity ? fmtSASTRelative(a.lastActivity) : "—"}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Last Seen</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
              <Clock className="h-5 w-5" style={{ color: "var(--accent)" }} /> Recent Activity
            </h2>
            <div className="space-y-2">
              {recent.map((s) => {
                const st = sourceStyle(s.source);
                const ts = toTs(s.started_at);
                return (
                  <a
                    key={s.id}
                    href={`/chat?resume=${encodeURIComponent(s.id)}`}
                    className="card card-hover flex items-center gap-3 p-4"
                  >
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                      style={{ background: st.bg, color: st.color }}
                    >
                      {s.source}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{s.title || s.id.slice(0, 60)}</div>
                      <div className="text-xs" style={{ color: "var(--text-faint)" }}>
                        {s.message_count ?? 0} messages · {ts ? fmtSASTRelative(ts) : "—"}
                      </div>
                    </div>
                    {s.is_active && (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium" style={{ color: "var(--green)" }}>
                        <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--green)" }} /> live
                      </span>
                    )}
                    <ArrowUpRight className="h-4 w-4 shrink-0" style={{ color: "var(--text-faint)" }} />
                  </a>
                );
              })}
              {recent.length === 0 && (
                <div className="card p-8 text-center text-sm" style={{ color: "var(--text-faint)" }}>No sessions found.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
