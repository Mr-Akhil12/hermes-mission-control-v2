"use client";

import { useState } from "react";
import { ShieldCheck, Check, X, Info } from "lucide-react";

type Approval = {
  id: string;
  what: string;
  why: string;
  risk: "low" | "medium" | "high";
  preview: string;
  created_at: string;
};

const DEMO_APPROVALS: Approval[] = [
  {
    id: "1",
    what: "Post SA Compliance Morning Brief to Discord",
    why: "Daily 06:00 SAST scheduled deliverable",
    risk: "low",
    preview: "🔴 PAYE & SDL filing due Fri 2026-08-07…",
    created_at: "2026-08-06T06:00:00+02:00",
  },
  {
    id: "2",
    what: "Commit + push 3 artifacts to hermes-dump",
    why: "Hourly cron report sweep found uncommitted files",
    risk: "low",
    preview: "artifacts: 2026-08-06/hermes-os-v2-buildspec.md …",
    created_at: "2026-08-06T04:00:00+02:00",
  },
];

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>(DEMO_APPROVALS);
  const [history, setHistory] = useState<string[]>([]);

  const decide = (id: string, action: "approved" | "rejected") => {
    const item = approvals.find((a) => a.id === id);
    if (!item) return;
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    setHistory((prev) => [`${item.what} — ${action}`, ...prev]);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6" style={{ color: "var(--accent)" }} />
        <div>
          <h1 className="text-2xl font-bold">Approvals</h1>
          <p className="text-sm" style={{ color: "var(--text-dim)" }}>The safety boundary. Consequential actions wait for your tap.</p>
        </div>
      </div>

      {approvals.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-sm" style={{ color: "var(--text-dim)" }}>Nothing waiting for approval. 🎉</div>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => (
            <div key={a.id} className="card p-5" style={{ borderColor: a.risk === "high" ? "color-mix(in srgb, var(--red) 45%, transparent)" : "var(--card-border)" }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: `color-mix(in srgb, ${a.risk === "high" ? "var(--red)" : a.risk === "medium" ? "var(--amber)" : "var(--green)"} 15%, transparent)`, color: a.risk === "high" ? "var(--red)" : a.risk === "medium" ? "var(--amber)" : "var(--green)" }}>
                      {a.risk} risk
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                      {new Date(a.created_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })}
                    </span>
                  </div>
                  <h3 className="mt-2 font-semibold">{a.what}</h3>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>{a.why}</p>
                  <div className="mt-3 flex items-start gap-2 rounded-lg p-3 text-xs" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-dim)" }}>
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent-2)" }} />
                    <span className="font-mono">{a.preview}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button onClick={() => decide(a.id, "approved")} className="flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "var(--green)" }}>
                  <Check className="h-4 w-4" /> Approve
                </button>
                <button onClick={() => decide(a.id, "rejected")} className="flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold" style={{ borderColor: "color-mix(in srgb, var(--red) 40%, transparent)", color: "var(--red)" }}>
                  <X className="h-4 w-4" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>History</h2>
          <ul className="space-y-2 text-sm" style={{ color: "var(--text-dim)" }}>
            {history.map((h, i) => (
              <li key={i}>• {h}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
