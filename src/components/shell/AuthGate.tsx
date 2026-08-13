"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Fingerprint, Lock, ShieldCheck, KeyRound } from "lucide-react";
import {
  isUnlocked,
  verifyPinUniversal,
  markUnlocked,
  biometricSupported,
  hasBiometric,
  authenticateBiometric,
} from "@/lib/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioTried, setBioTried] = useState(false);
  const bioAutoRef = useRef(false);

  // The PIN is hardcoded (REDACTED) + synced to Turso — setup NEVER runs.
  // The only state to manage is biometric registration (per-device, done in Settings).
  useEffect(() => {
    setBioEnabled(hasBiometric());
    setReady(true);
    setUnlocked(isUnlocked());
  }, []);

  // ── Auto-biometric on unlock: try fingerprint/FaceID FIRST ───────
  // If biometrics are registered, attempt them automatically when the
  // unlock screen appears. Only fall back to PIN if they fail/cancel.
  useEffect(() => {
    if (!ready || unlocked || !bioEnabled || bioAutoRef.current) return;
    bioAutoRef.current = true;
    setBusy(true);
    authenticateBiometric()
      .then((ok) => {
        if (ok) {
          markUnlocked();
          setUnlocked(true);
        } else {
          setBioTried(true);
          setError("Biometric failed — enter your PIN.");
        }
      })
      .catch(() => {
        setBioTried(true);
        setError("Biometric failed — enter your PIN.");
      })
      .finally(() => setBusy(false));
  }, [ready, unlocked, bioEnabled]);

  const submitPin = async () => {
    setError(null);
    setBusy(true);
    const ok = await verifyPinUniversal(pin);
    setBusy(false);
    if (ok) {
      markUnlocked();
      setUnlocked(true);
    } else {
      setError("Wrong PIN. Try again.");
    }
  };

  const bioUnlock = async () => {
    setError(null);
    setBusy(true);
    const ok = await authenticateBiometric();
    setBusy(false);
    if (ok) {
      markUnlocked();
      setUnlocked(true);
    } else {
      setError("Biometric verification failed.");
    }
  };

  if (!ready) return null;
  if (unlocked) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" style={{ background: "var(--bg)" }}>
      <div className="particle-bg" aria-hidden="true" />
      <div className="card w-full max-w-sm p-8 text-center">
        <div
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
        >
          <Lock className="h-7 w-7 text-white" />
        </div>

        <h1 className="mt-4 text-xl font-bold">Hermes OS</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>
          {busy ? "Checking biometrics…" : bioTried ? "Enter your PIN." : "Unlock with biometrics or PIN."}
        </p>

        <input
          type="password"
          inputMode="numeric"
          autoFocus={bioTried}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && submitPin()}
          placeholder="••••"
          className="mt-6 w-full rounded-xl border bg-transparent px-4 py-3 text-center text-lg tracking-[0.4em] outline-none"
          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
          maxLength={8}
        />

        {error && (
          <div className="mt-4 rounded-lg p-3 text-sm" style={{ background: "rgba(255,92,92,0.10)", color: "var(--red)" }}>
            {error}
          </div>
        )}

        <div className="mt-6 space-y-2">
          {bioEnabled && !bioTried ? (
            <>
              <button
                onClick={bioUnlock}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
              >
                <Fingerprint className="h-4 w-4" /> {busy ? "Verifying…" : "Unlock with biometrics"}
              </button>
              <button onClick={() => setBioTried(true)} className="w-full rounded-xl border px-4 py-3 text-sm" style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}>
                Use PIN instead
              </button>
            </>
          ) : (
            <button
              onClick={submitPin}
              disabled={busy || pin.length < 4}
              className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
            >
              <KeyRound className="h-4 w-4" /> Unlock
            </button>
          )}
        </div>

        <div className="mt-6 flex items-start justify-center gap-1.5 text-[11px] leading-relaxed" style={{ color: "var(--text-faint)" }}>
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>Local + Turso — PIN synced across devices, biometrics per device</span>
        </div>
      </div>
    </div>
  );
}
