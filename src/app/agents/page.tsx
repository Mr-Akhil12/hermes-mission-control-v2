"use client";

import { Network, Activity } from "lucide-react";

export default function AgentsPage() {
  const agents = [
    { name: "SOL", role: "Important decisions / critical tasks", status: "idle", model: "gpt-5.6-sol" },
    { name: "LUNA", role: "Images + vision", status: "idle", model: "gpt-5.6-luna" },
    { name: "DEEPSEEK", role: "Daily driver / cron agent", status: "idle", model: "deepseek-v4-flash:0731" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Network className="h-6 w-6" style={{ color: "var(--accent)" }} /> Agents
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Akhil's Agent Team — live graph + subagent visualisation lands in Phase 3.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {agents.map((a) => (
          <div key={a.name} className="card p-5">
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold">{a.name}</span>
              <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--green)" }}>
                <Activity className="h-3.5 w-3.5" /> {a.status}
              </span>
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--text-dim)" }}>{a.role}</p>
            <div className="mt-3 rounded-lg px-2 py-1 font-mono text-[11px]" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-faint)" }}>
              {a.model}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
