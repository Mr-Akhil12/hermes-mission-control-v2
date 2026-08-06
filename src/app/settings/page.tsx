"use client";

import { Settings as SettingsIcon, Fingerprint, Database, Wifi, Lock } from "lucide-react";
import { lockNow } from "@/lib/auth";
import { useRouter } from "next/navigation";

export default function SettingsPage() {
  const router = useRouter();
  const sources = [
    { name: "Turso", status: "configured", icon: Database, note: "tasks · sync_cache · briefs · artifacts" },
    { name: "Native API (:9119)", status: "via Tailscale", icon: Wifi, note: "100.109.86.13 · basic_auth token" },
    { name: "Biometric lock", status: "PIN + WebAuthn", icon: Fingerprint, note: "Fingerprint/FaceID unlock on phone + desktop" },
  ];

  const handleLock = () => {
    lockNow();
    router.refresh();
    window.location.reload();
  };

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

      <div className="card p-5">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>Security</h2>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Lock the dashboard now — you'll need your PIN or biometrics to get back in.</p>
        <button
          onClick={handleLock}
          className="mt-3 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
          style={{ background: "rgba(255,92,92,0.12)", color: "var(--red)" }}
        >
          <Lock className="h-4 w-4" /> Lock now
        </button>
      </div>
    </div>
  );
}
