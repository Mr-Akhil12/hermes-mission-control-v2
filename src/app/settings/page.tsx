"use client";

import { Settings as SettingsIcon, Fingerprint, Database, Wifi } from "lucide-react";

export default function SettingsPage() {
  const sources = [
    { name: "Turso", status: "configured", icon: Database, note: "tasks · sync_cache · briefs · artifacts" },
    { name: "Native API (:9119)", status: "via Tailscale", icon: Wifi, note: "100.109.86.13 · basic_auth token" },
    { name: "Biometric lock", status: "PIN + WebAuthn", icon: Fingerprint, note: "Phase 1 rollout — fingerprint/FaceID on phone" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <SettingsIcon className="h-6 w-6" style={{ color: "var(--accent)" }} /> Settings
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Wrapper + data source status.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {sources.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.name} className="card p-5">
              <Icon className="h-5 w-5" style={{ color: "var(--accent-2)" }} />
              <div className="mt-2 font-semibold">{s.name}</div>
              <div className="text-xs font-medium" style={{ color: "var(--green)" }}>{s.status}</div>
              <div className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>{s.note}</div>
            </div>
          );
        })}
      </div>

      <div className="card p-5 text-sm" style={{ color: "var(--text-dim)" }}>
        Native config pages (models, MCP, plugins, skills, env, logs, system, analytics) live in the <b>Native UI</b> embed — no rebuild needed.
      </div>
    </div>
  );
}
