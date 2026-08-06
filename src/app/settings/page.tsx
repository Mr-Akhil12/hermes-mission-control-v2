"use client";

import { useState } from "react";
import { Settings as SettingsIcon, Fingerprint, Database, Wifi, Lock, KeyRound } from "lucide-react";
import { lockNow, setPin, verifyPin } from "@/lib/auth";
import { useRouter } from "next/navigation";

export default function SettingsPage() {
  const router = useRouter();
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmNewPin, setConfirmNewPin] = useState("");
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  const sources = [
    { name: "Turso", status: "configured", icon: Database, note: "tasks · sync_cache · briefs · artifacts" },
    { name: "Native API (:9119)", status: "via Tailscale", icon: Wifi, note: "172.21.184.37 · basic_auth token" },
    { name: "Biometric lock", status: "PIN + WebAuthn", icon: Fingerprint, note: "Fingerprint/FaceID unlock on phone + desktop" },
  ];

  const handleLock = () => {
    lockNow();
    router.refresh();
    window.location.reload();
  };

  const handleChangePin = async () => {
    setPinMsg(null);
    if (newPin.length < 4) return setPinMsg({ ok: false, text: "New PIN must be at least 4 digits." });
    if (newPin !== confirmNewPin) return setPinMsg({ ok: false, text: "New PINs don't match." });
    setPinBusy(true);
    const ok = await verifyPin(currentPin);
    if (!ok) {
      setPinBusy(false);
      return setPinMsg({ ok: false, text: "Current PIN is wrong." });
    }
    await setPin(newPin);
    setPinBusy(false);
    setPinMsg({ ok: true, text: "PIN changed. It's permanent until you change it again here." });
    setCurrentPin("");
    setNewPin("");
    setConfirmNewPin("");
    setChangePinOpen(false);
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
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={handleLock}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ background: "rgba(255,92,92,0.12)", color: "var(--red)" }}
          >
            <Lock className="h-4 w-4" /> Lock now
          </button>
          <button
            onClick={() => { setChangePinOpen((v) => !v); setPinMsg(null); }}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}
          >
            <KeyRound className="h-4 w-4" /> Change PIN
          </button>
        </div>

        {changePinOpen && (
          <div className="mt-4 space-y-2 rounded-lg border p-4" style={{ borderColor: "var(--card-border)" }}>
            <p className="text-xs" style={{ color: "var(--text-faint)" }}>
              PIN is permanent once set. Changing it requires your current PIN.
            </p>
            <input
              type="password" inputMode="numeric" value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))}
              placeholder="Current PIN" maxLength={8}
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
            />
            <input
              type="password" inputMode="numeric" value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
              placeholder="New PIN" maxLength={8}
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
            />
            <input
              type="password" inputMode="numeric" value={confirmNewPin}
              onChange={(e) => setConfirmNewPin(e.target.value.replace(/\D/g, ""))}
              placeholder="Confirm new PIN" maxLength={8}
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
            />
            <button
              onClick={handleChangePin} disabled={pinBusy}
              className="w-full rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
            >
              {pinBusy ? "Changing…" : "Change PIN"}
            </button>
            {pinMsg && (
              <div className="rounded-lg p-2 text-xs" style={{ background: pinMsg.ok ? "rgba(61,220,151,0.10)" : "rgba(255,92,92,0.10)", color: pinMsg.ok ? "var(--green)" : "var(--red)" }}>
                {pinMsg.text}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
