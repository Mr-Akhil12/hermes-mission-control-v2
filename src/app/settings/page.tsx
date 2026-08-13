"use client";

import { useState, useEffect, useCallback } from "react";
import { Settings as SettingsIcon, Fingerprint, Database, Wifi, Lock, KeyRound, Bell, BellOff, Send, Trash2, Plus } from "lucide-react";
import { lockNow, changePinUniversal, verifyPinUniversal, registerBiometric, hasBiometric, deleteBiometric } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { isPushSupported, getPushStatus, enablePush, disablePush, testPush } from "@/lib/push";

export default function SettingsPage() {
  const router = useRouter();
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSubs, setPushSubs] = useState(0);
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  // Security state
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioMsg, setBioMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmNewPin, setConfirmNewPin] = useState("");
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  const refreshPush = useCallback(async () => {
    const supported = await isPushSupported();
    setPushSupported(supported);
    if (!supported) return;
    const status = await getPushStatus();
    setPushEnabled(status.enabled && status.subscriptions > 0);
    setPushSubs(status.subscriptions);
  }, []);

  useEffect(() => {
    refreshPush();
    setBioEnabled(hasBiometric());
  }, [refreshPush]);

  const handleEnablePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    const res = await enablePush();
    if (res.ok) {
      setPushMsg({ ok: true, text: "Push notifications enabled. Approvals and failed crons will ping this device." });
      await refreshPush();
    } else {
      setPushMsg({ ok: false, text: res.error ?? "Failed to enable push." });
    }
    setPushBusy(false);
  };

  const handleDisablePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    const res = await disablePush();
    if (res.ok) {
      setPushMsg({ ok: true, text: "Push notifications disabled for this device." });
      await refreshPush();
    } else {
      setPushMsg({ ok: false, text: res.error ?? "Failed to disable push." });
    }
    setPushBusy(false);
  };

  const handleTestPush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    const res = await testPush();
    if (res.ok) {
      setPushMsg({ ok: true, text: "Test notification sent — check your phone." });
    } else {
      setPushMsg({ ok: false, text: res.error ?? "Test failed." });
    }
    setPushBusy(false);
  };

  const sources = [
    { name: "Turso", status: "configured", icon: Database, note: "tasks · sync_cache · briefs · artifacts" },
    { name: "Native API (:9119)", status: "via Tailscale", icon: Wifi, note: "172.21.184.37 · basic_auth token" },
    { name: "Biometric lock", status: bioEnabled ? "enabled on this device" : "not set on this device", icon: Fingerprint, note: "Fingerprint/FaceID unlock on phone + desktop" },
  ];

  const handleLock = () => {
    lockNow();
    router.refresh();
    window.location.reload();
  };

  const handleAddBiometric = async () => {
    setBioBusy(true);
    setBioMsg(null);
    const ok = await registerBiometric();
    setBioBusy(false);
    if (ok) {
      setBioEnabled(true);
      setBioMsg({ ok: true, text: "Fingerprint registered on this device. It will auto-trigger on the lock screen." });
    } else {
      setBioMsg({ ok: false, text: "Registration failed or was cancelled." });
    }
  };

  const handleDeleteBiometric = () => {
    deleteBiometric();
    setBioEnabled(false);
    setBioMsg({ ok: true, text: "Fingerprint removed from this device. Re-add it anytime." });
  };

  const handleChangePin = async () => {
    setPinMsg(null);
    if (newPin.length < 4) return setPinMsg({ ok: false, text: "New PIN must be at least 4 digits." });
    if (newPin !== confirmNewPin) return setPinMsg({ ok: false, text: "New PINs don't match." });
    setPinBusy(true);
    const ok = await verifyPinUniversal(currentPin);
    if (!ok) {
      setPinBusy(false);
      return setPinMsg({ ok: false, text: "Current PIN is wrong." });
    }
    const changed = await changePinUniversal(newPin);
    setPinBusy(false);
    if (changed) {
      setPinMsg({ ok: true, text: "PIN changed — applies to every device (synced via Turso)." });
      setCurrentPin("");
      setNewPin("");
      setConfirmNewPin("");
      setChangePinOpen(false);
    } else {
      setPinMsg({ ok: false, text: "Failed to save the new PIN. Check your connection and try again." });
    }
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
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>Push notifications</h2>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Approvals and failed crons ping your phone even when the dashboard is closed. Works on installed PWA + desktop browsers.
        </p>
        {!pushSupported ? (
          <div className="mt-3 rounded-lg p-3 text-xs" style={{ background: "rgba(255,92,92,0.10)", color: "var(--red)" }}>
            This browser doesn't support Web Push. Use Chrome/Edge on desktop, or install the PWA on your phone.
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {pushEnabled ? (
              <>
                <button
                  onClick={handleDisablePush}
                  disabled={pushBusy}
                  className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  style={{ background: "rgba(255,92,92,0.12)", color: "var(--red)" }}
                >
                  <BellOff className="h-4 w-4" /> {pushBusy ? "Disabling…" : "Disable push"}
                </button>
                <button
                  onClick={handleTestPush}
                  disabled={pushBusy}
                  className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                >
                  <Send className="h-4 w-4" /> {pushBusy ? "Sending…" : "Send test"}
                </button>
                <span className="text-xs" style={{ color: "var(--green)" }}>
                  ● Active on {pushSubs} device{pushSubs === 1 ? "" : "s"}
                </span>
              </>
            ) : (
              <button
                onClick={handleEnablePush}
                disabled={pushBusy}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
              >
                <Bell className="h-4 w-4" /> {pushBusy ? "Enabling…" : "Enable push notifications"}
              </button>
            )}
          </div>
        )}
        {pushMsg && (
          <div className="mt-3 rounded-lg p-2 text-xs" style={{ background: pushMsg.ok ? "rgba(61,220,151,0.10)" : "rgba(255,92,92,0.10)", color: pushMsg.ok ? "var(--green)" : "var(--red)" }}>
            {pushMsg.text}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>Security</h2>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          PIN is synced across all your devices via Turso. Biometrics are per-device — register once on each device you use.
        </p>

        {/* Biometrics */}
        <div className="mt-4 rounded-lg border p-4" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Fingerprint className="h-4 w-4" style={{ color: "var(--accent)" }} /> Fingerprint / FaceID
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            {bioEnabled
              ? "Registered on this device — it auto-triggers on the lock screen."
              : "Not registered on this device. Add it for one-tap unlock."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!bioEnabled ? (
              <button
                onClick={handleAddBiometric}
                disabled={bioBusy}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
              >
                <Plus className="h-4 w-4" /> {bioBusy ? "Registering…" : "Add fingerprint"}
              </button>
            ) : (
              <button
                onClick={handleDeleteBiometric}
                disabled={bioBusy}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
                style={{ background: "rgba(255,92,92,0.12)", color: "var(--red)" }}
              >
                <Trash2 className="h-4 w-4" /> Delete fingerprint
              </button>
            )}
          </div>
          {bioMsg && (
            <div className="mt-3 rounded-lg p-2 text-xs" style={{ background: bioMsg.ok ? "rgba(61,220,151,0.10)" : "rgba(255,92,92,0.10)", color: bioMsg.ok ? "var(--green)" : "var(--red)" }}>
              {bioMsg.text}
            </div>
          )}
        </div>

        {/* Change PIN */}
        <div className="mt-4 rounded-lg border p-4" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4" style={{ color: "var(--accent)" }} /> PIN
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            Changing the PIN updates it on every device (synced via Turso). The master PIN REDACTED always works as a fallback.
          </p>
          {!changePinOpen ? (
            <button
              onClick={() => { setChangePinOpen(true); setPinMsg(null); }}
              className="mt-3 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
              style={{ background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}
            >
              <KeyRound className="h-4 w-4" /> Change PIN
            </button>
          ) : (
            <div className="mt-3 space-y-2">
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
              <div className="flex gap-2">
                <button
                  onClick={handleChangePin} disabled={pinBusy}
                  className="flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
                >
                  {pinBusy ? "Saving…" : "Save new PIN"}
                </button>
                <button
                  onClick={() => { setChangePinOpen(false); setPinMsg(null); }}
                  className="rounded-lg border px-4 py-2 text-sm"
                  style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                >
                  Cancel
                </button>
              </div>
              {pinMsg && (
                <div className="rounded-lg p-2 text-xs" style={{ background: pinMsg.ok ? "rgba(61,220,151,0.10)" : "rgba(255,92,92,0.10)", color: pinMsg.ok ? "var(--green)" : "var(--red)" }}>
                  {pinMsg.text}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Lock now */}
        <div className="mt-4">
          <button
            onClick={handleLock}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ background: "rgba(255,92,92,0.12)", color: "var(--red)" }}
          >
            <Lock className="h-4 w-4" /> Lock now
          </button>
        </div>
      </div>
    </div>
  );
}
