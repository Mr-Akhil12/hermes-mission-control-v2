"use client";

import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, Check, X, Info, RefreshCw, Clock, ExternalLink } from "lucide-react";

type Approval = {
  run_id: string;
  status: "pending" | "resolved" | "approved" | "rejected";
  command: string;
  what: string;
  why: string;
  risk: "low" | "medium" | "high";
  choices?: string[];
  created_at: string;
  resolved_at?: string;
};

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals", { cache: "no-store" });
      const data = await res.json();
      setApprovals(data?.approvals ?? []);
      setError(null);
    } catch (e) {
      setError(`Failed to load approvals: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const decide = useCallback(async (item: Approval, choice: string) => {
    setBusyId(item.run_id);
    setError(null);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: item.run_id, choice }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `Resolve failed (${res.status})`);
      }
      // Mark locally as resolved for immediate UI feedback.
      setApprovals((prev) =>
        prev.map((a) =>
          a.run_id === item.run_id
            ? { ...a, status: choice === "deny" ? "rejected" : "approved", resolved_at: new Date().toISOString() }
            : a
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const pending = approvals.filter((a) => a.status === "pending");
  const history = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6" style={{ color: "var(--accent)" }} />
          <div>
            <h1 className="text-2xl font-bold">Approvals</h1>
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              The safety boundary. Dangerous commands wait for your tap — resolved through the real Hermes approval system.
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
          Loading approvals…
        </div>
      ) : pending.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-sm" style={{ color: "var(--text-dim)" }}>Nothing waiting for approval. 🎉</div>
          <div className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            When a dispatch needs a dangerous command, it lands here in real time.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((a) => (
            <div key={a.run_id} className="card p-5" style={{ borderColor: a.risk === "high" ? "color-mix(in srgb, var(--red) 45%, transparent)" : "var(--card-border)" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: `color-mix(in srgb, ${a.risk === "high" ? "var(--red)" : a.risk === "medium" ? "var(--amber)" : "var(--green)"} 15%, transparent)`, color: a.risk === "high" ? "var(--red)" : a.risk === "medium" ? "var(--amber)" : "var(--green)" }}>
                      {a.risk} risk
                    </span>
                    <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
                      <Clock className="h-3 w-3" /> {new Date(a.created_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })}
                    </span>
                  </div>
                  <h3 className="mt-2 font-semibold">{a.what || "Dangerous command"}</h3>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>{a.why}</p>
                  <div className="mt-3 flex items-start gap-2 rounded-lg p-3 text-xs" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-dim)" }}>
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent-2)" }} />
                    <span className="min-w-0 break-all font-mono">{a.command || a.what}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => decide(a, "once")}
                  disabled={busyId === a.run_id}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: "var(--green)" }}
                >
                  <Check className="h-4 w-4" /> Approve once
                </button>
                <button
                  onClick={() => decide(a, "always")}
                  disabled={busyId === a.run_id}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  style={{ borderColor: "color-mix(in srgb, var(--green) 40%, transparent)", color: "var(--green)" }}
                >
                  <Check className="h-4 w-4" /> Always allow
                </button>
                <button
                  onClick={() => decide(a, "deny")}
                  disabled={busyId === a.run_id}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  style={{ borderColor: "color-mix(in srgb, var(--red) 40%, transparent)", color: "var(--red)" }}
                >
                  <X className="h-4 w-4" /> Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
            History ({history.length})
          </h2>
          <ul className="space-y-2 text-sm" style={{ color: "var(--text-dim)" }}>
            {history.slice(0, 20).map((h) => (
              <li key={h.run_id} className="flex items-start gap-2">
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: h.status === "approved" ? "var(--green)" : h.status === "rejected" ? "var(--red)" : "var(--amber)" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">{h.command || h.what}</div>
                  <div className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                    {h.status} · {h.resolved_at ? new Date(h.resolved_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : h.created_at}
                  </div>
                </div>
                <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-faint)" }}>
                  {h.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
