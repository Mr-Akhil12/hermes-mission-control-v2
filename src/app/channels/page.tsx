"use client";

import { useState, useEffect, useCallback } from "react";
import { MessageSquare, RefreshCw, Server, Radio, Hash, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { fmtSAST } from "@/lib/time";

type Platform = {
  id: string;
  name: string;
  state: string;
  connected: boolean;
  error: string | null;
  updated_at: string;
};

type Channel = {
  id: string;
  name: string;
  guild: string;
  platform: string;
  type: string;
};

type Delivery = {
  platform: string;
  state: string;
  attempts: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  preview: string;
};

export default function ChannelsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [gateway, setGateway] = useState<{ state: string; active_agents: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      const data = await res.json();
      setPlatforms(data?.platforms ?? []);
      setChannels(data?.channels ?? []);
      setDeliveries(data?.deliveries ?? []);
      setGateway(data?.gateway ?? null);
      setError(null);
    } catch (e) {
      setError(`Failed to load channels: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const fmtTime = (ts: number | null | undefined) => (ts ? fmtSAST(ts * 1000) : "—");

  const stateColor = (s: string) => (s === "connected" ? "var(--green)" : s === "retrying" ? "var(--amber)" : "var(--red)");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6" style={{ color: "var(--accent)" }} />
          <div>
            <h1 className="text-2xl font-bold">Channels</h1>
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              Real gateway state, channel directory, and delivery log.
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
          Loading channels…
        </div>
      ) : (
        <>
          {/* Gateway status */}
          <div className="card flex items-center justify-between p-5">
            <div className="flex items-center gap-3">
              <Server className="h-5 w-5" style={{ color: "var(--accent)" }} />
              <div>
                <div className="text-sm font-bold">Hermes Gateway</div>
                <div className="text-xs" style={{ color: "var(--text-faint)" }}>
                  {gateway?.active_agents ?? 0} active agent(s)
                </div>
              </div>
            </div>
            <span className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase" style={{ background: gateway?.state === "running" ? "rgba(61,220,151,0.12)" : "rgba(255,92,92,0.12)", color: gateway?.state === "running" ? "var(--green)" : "var(--red)" }}>
              {gateway?.state ?? "unknown"}
            </span>
          </div>

          {/* Platform states */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {platforms.map((p) => (
              <div key={p.id} className="card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-semibold">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: stateColor(p.state) }} />
                    {p.name}
                  </div>
                  <span className="text-[10px] font-bold uppercase" style={{ color: stateColor(p.state) }}>
                    {p.state}
                  </span>
                </div>
                {p.error ? (
                  <div className="mt-2 flex items-start gap-1.5 text-xs" style={{ color: "var(--amber)" }}>
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="line-clamp-2">{p.error}</span>
                  </div>
                ) : (
                  <div className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
                    Last update {fmtTime(p.updated_at ? new Date(p.updated_at).getTime() / 1000 : null)}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Channel directory */}
          <div className="card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              <Hash className="h-4 w-4" /> Channel directory ({channels.length})
            </h2>
            <div className="grid gap-2 md:grid-cols-2">
              {channels.slice(0, 30).map((c) => (
                <div key={c.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--card-border)" }}>
                  <Radio className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent-2)" }} />
                  <span className="font-medium">{c.name}</span>
                  {c.guild && <span className="text-xs" style={{ color: "var(--text-faint)" }}>{c.guild}</span>}
                  <span className="ml-auto text-[10px] uppercase" style={{ color: "var(--text-faint)" }}>{c.platform}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Delivery log */}
          <div className="card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
              <MessageSquare className="h-4 w-4" /> Delivery log ({deliveries.length})
            </h2>
            <ul className="space-y-2">
              {deliveries.map((d, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg border px-3 py-2" style={{ borderColor: "var(--card-border)" }}>
                  {d.state === "delivered" ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--green)" }} />
                  ) : d.state === "failed" ? (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--red)" }} />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--amber)" }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{d.preview}</div>
                    <div className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                      {d.platform} · {d.state} · {fmtTime(d.updated_at)} {d.attempts > 0 ? `· ${d.attempts} attempt(s)` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
