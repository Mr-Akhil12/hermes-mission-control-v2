"use client";

import { useState, useEffect, useCallback } from "react";
import { Settings as SettingsIcon, Fingerprint, Database, Wifi, Lock, Bell, BellOff, Send } from "lucide-react";
import { lockNow } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { isPushSupported, getPushStatus, enablePush, disablePush, testPush } from "@/lib/push";

export default function SettingsPage() {
  const router = useRouter();
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSubs, setPushSubs] = useState(0);
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

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
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Lock the dashboard now — you'll need your PIN or biometrics to get back in. Your PIN is permanent and cannot be changed.</p>
        <div className="mt-3 flex flex-wrap gap-2">
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
