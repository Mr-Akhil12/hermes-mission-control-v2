"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Network, Activity, Layers, Radio, Bot, MessageSquare, Clock,
  AlertCircle, RefreshCw, ArrowUpRight, Cpu, GitBranch, Zap, CheckCircle2, XCircle, Loader2,
} from "lucide-react";
import { fmtSASTRelative } from "@/lib/time";
import { DEFAULT_MODEL } from "@/lib/models";

type ProfileInfo = {
  name: string;
  model?: string;
  provider?: string;
  description?: string;
  served?: boolean;
};

type Session = {
  id: string;
  source: string;
  title?: string | null;
  started_at?: string | number | null;
  ended_at?: string | number | null;
  is_active?: boolean;
  message_count?: number;
  last_activity_at?: string | number | null;
  last_activity_description?: string | null;
};

type Delegation = {
  id: string;
  state: string;
  role?: string | null;
  model?: string | null;
  parent_session?: string | null;
  goal?: string;
  dispatched_at?: number | null;
  completed_at?: number | null;
  toolsets?: string[] | null;
};

// Source → badge colors (same map as the session list).
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
  return n < 1e12 ? n * 1000 : n;
}

const STAT_COLORS: Record<string, string> = {
  completed: "var(--green)",
  running: "var(--accent)",
  unknown: "var(--text-faint)",
};

export default function AgentsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [sR, pR, dR] = await Promise.all([
      fetch("/api/chat/sessions?source=all", { cache: "no-store" }),
      fetch("/api/chat/profiles", { cache: "no-store" }),
      fetch("/api/chat/delegations", { cache: "no-store" }),
    ]);
    const sD = await sR.json();
    const pD = await pR.json();
    const dD = await dR.json();
    if (sD.error) throw new Error(sD.error);
    return {
      sessions: (sD.sessions ?? sD.data ?? []) as Session[],
      profiles: (pD.profiles ?? []) as ProfileInfo[],
      delegations: (dD.delegations ?? []) as Delegation[],
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then(({ sessions, profiles, delegations }) => {
        if (cancelled) return;
        setSessions(sessions);
        setProfiles(profiles);
        setDelegations(delegations);
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
  }, [fetchAll]);

  const retry = () => {
    setLoading(true);
    setError(null);
    fetchAll()
      .then(({ sessions, profiles, delegations }) => {
        setSessions(sessions);
        setProfiles(profiles);
        setDelegations(delegations);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  // Live activity log: active sessions first, then by last activity.
  const activeNow = sessions.filter((s) => s.is_active);
  const recentSessions = [...sessions]
    .sort((a, b) => {
      const aTs = toTs(a.last_activity_at ?? a.started_at) ?? 0;
      const bTs = toTs(b.last_activity_at ?? b.started_at) ?? 0;
      return bTs - aTs;
    })
    .slice(0, 8);
  const subagentSpawns = delegations.length;
  const subagentsRunning = delegations.filter((d) => d.state === "running").length;

  const stats = [
    { label: "Profiles", value: profiles.length + 1, icon: Bot, color: "var(--accent)" },
    { label: "Active Now", value: activeNow.length, icon: Radio, color: "var(--green)" },
    { label: "Subagent Spawns", value: subagentSpawns, icon: GitBranch, color: "#8b7bff" },
    { label: "Subagents Running", value: subagentsRunning, icon: Zap, color: "var(--amber)" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Network className="h-6 w-6" style={{ color: "var(--accent)" }} /> Agents
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Hermes profiles (same as the native profiles screen) — who is available, what they run,
          and what they&apos;re doing right now.
        </p>
      </div>

      {loading && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card h-24 animate-pulse p-5" style={{ background: "color-mix(in srgb, var(--card) 60%, transparent)" }} />
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
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

          {/* Profile cards — like the native Hermes profiles screen: each
              multiplex profile with its model, provider, description and
              whether the gateway serves it. */}
          <div>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
              <Bot className="h-5 w-5" style={{ color: "var(--accent)" }} /> Profiles
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="card card-hover p-5">
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold">Hermes</span>
                  <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--green)" }}>
                    <Activity className="h-3.5 w-3.5 animate-pulse" /> default
                  </span>
                </div>
                <p className="mt-2 text-sm" style={{ color: "var(--text-dim)" }}>
                  Default — orchestration, general work
                </p>
                <div className="mt-3 rounded-lg px-2 py-1 font-mono text-[11px]" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-faint)" }}>
                  {DEFAULT_MODEL}
                </div>
              </div>
              {profiles.map((p) => (
                <div key={p.name} className="card card-hover p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold capitalize">{p.name.replace(/[-_]/g, " ")}</span>
                    <span
                      className="flex items-center gap-1.5 text-xs font-medium"
                      style={{ color: p.served ? "var(--green)" : "var(--text-faint)" }}
                    >
                      <Activity className="h-3.5 w-3.5" />
                      {p.served ? "served" : "not served"}
                    </span>
                  </div>
                  {p.description && (
                    <p className="mt-2 text-sm" style={{ color: "var(--text-dim)" }}>{p.description}</p>
                  )}
                  <div className="mt-3 rounded-lg px-2 py-1 font-mono text-[11px]" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-faint)" }}>
                    {p.model || p.provider || "unknown model"}
                  </div>
                </div>
              ))}
              {profiles.length === 0 && (
                <div className="card p-8 text-center text-sm" style={{ color: "var(--text-faint)" }}>
                  No custom profiles found — create one with <code className="rounded px-1" style={{ background: "rgba(124,108,255,0.10)", color: "var(--accent-2)" }}>hermes profile create</code>
                </div>
              )}
            </div>
          </div>

          {/* Live activity — what's running / was last doing. */}
          <div>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
              <Activity className="h-5 w-5" style={{ color: "var(--green)" }} /> Live Activity
            </h2>
            <div className="space-y-2">
              {recentSessions.map((s) => {
                const st = sourceStyle(s.source);
                const ts = toTs(s.last_activity_at ?? s.started_at);
                const lastDesc = s.last_activity_description;
                return (
                  <a
                    key={s.id}
                    href={`/chat?resume=${encodeURIComponent(s.id)}`}
                    className="card card-hover flex items-center gap-3 p-4"
                  >
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: st.bg, color: st.color }}>
                      {s.source}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{s.title || s.id.slice(0, 60)}</div>
                      <div className="truncate text-xs" style={{ color: "var(--text-faint)" }}>
                        {lastDesc ? lastDesc : `${s.message_count ?? 0} messages`}
                        {ts ? ` · ${fmtSASTRelative(ts)}` : ""}
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
              {recentSessions.length === 0 && (
                <div className="card p-8 text-center text-sm" style={{ color: "var(--text-faint)" }}>No activity yet.</div>
              )}
            </div>
          </div>

          {/* Subagent log — what delegations were spawned, for what, outcome. */}
          <div>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
              <GitBranch className="h-5 w-5" style={{ color: "#8b7bff" }} /> Subagent Log
            </h2>
            <div className="space-y-2">
              {delegations.map((d) => {
                const ts = toTs(d.dispatched_at);
                const dur =
                  d.dispatched_at && d.completed_at
                    ? Math.round((d.completed_at - d.dispatched_at) * 10) / 10
                    : null;
                return (
                  <div key={d.id} className="card flex items-start gap-3 p-4">
                    {d.state === "completed" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--green)" }} />
                    ) : d.state === "running" ? (
                      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--text-faint)" }} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-bold" style={{ color: "var(--text-dim)" }}>
                          {d.role ? d.role.toUpperCase() : "SUBAGENT"}
                        </span>
                        {d.model && (
                          <span className="rounded px-1.5 py-0.5 font-mono text-[10px]" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-faint)" }}>
                            {d.model}
                          </span>
                        )}
                        {dur !== null && (
                          <span className="font-mono text-[10px]" style={{ color: "var(--text-faint)" }}>
                            {dur}s
                          </span>
                        )}
                        {ts && <span className="ml-auto text-[10px]" style={{ color: "var(--text-faint)" }}>{fmtSASTRelative(ts)}</span>}
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs leading-relaxed" style={{ color: "var(--text-dim)" }}>
                        {d.goal || "(no goal recorded)"}
                      </div>
                    </div>
                  </div>
                );
              })}
              {delegations.length === 0 && (
                <div className="card p-8 text-center text-sm" style={{ color: "var(--text-faint)" }}>
                  No subagent delegations recorded yet.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
