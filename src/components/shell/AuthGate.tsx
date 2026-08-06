"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Fingerprint, Lock, ShieldCheck, KeyRound } from "lucide-react";
import {
  isUnlocked,
  isPinSet,
  setPin,
  verifyPin,
  markUnlocked,
  biometricSupported,
  registerBiometric,
  hasBiometric,
  authenticateBiometric,
} from "@/lib/auth";

type Step = "setup-pin" | "setup-pin-confirm" | "setup-biometric" | "unlock";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [step, setStep] = useState<Step>("unlock");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioTried, setBioTried] = useState(false);
  const bioAutoRef = useRef(false);

  // ── First-run detection: PIN is PERMANENT once set ──────────────
  // If a PIN exists, we NEVER re-enter setup. The only way to change it
  // is to manually clear localStorage (explicit secret change).
  useEffect(() => {
    setBioAvailable(biometricSupported());
    setBioEnabled(hasBiometric());
    setReady(true);
    setUnlocked(isUnlocked());
    if (!isPinSet()) {
      setStep("setup-pin");
    } else {
      setStep("unlock");
    }
  }, []);

  // ── Auto-biometric on unlock: try fingerprint/FaceID FIRST ───────
  // If biometrics are registered, attempt them automatically when the
  // unlock screen appears. Only fall back to PIN if they fail/cancel.
  useEffect(() => {
    if (!ready || unlocked || step !== "unlock" || !bioEnabled || bioAutoRef.current) return;
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
  }, [ready, unlocked, step, bioEnabled]);

  const submitPin = async () => {
    setError(null);
    if (step === "setup-pin") {
      if (pin.length < 4) return setError("PIN must be at least 4 digits.");
      setStep("setup-pin-confirm");
      return;
    }
    if (step === "setup-pin-confirm") {
      if (pin !== pinConfirm) return setError("PINs don't match.");
      await setPin(pin);
      markUnlocked();
      // Offer biometric if available (first-run only)
      if (bioAvailable) {
        setStep("setup-biometric");
      } else {
        setUnlocked(true);
      }
      return;
    }
    // unlock — PIN fallback
    setBusy(true);
    const ok = await verifyPin(pin);
    setBusy(false);
    if (ok) {
      markUnlocked();
      setUnlocked(true);
    } else {
      setError("Wrong PIN. Try again.");
    }
  };

  const enableBiometric = async () => {
    setError(null);
    setBusy(true);
    const ok = await registerBiometric();
    setBusy(false);
    if (ok) {
      setBioEnabled(true);
      setUnlocked(true);
    } else {
      setError("Biometric registration failed or was cancelled.");
    }
  };

  const skipBiometric = () => setUnlocked(true);

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
          {step === "setup-biometric" ? <Fingerprint className="h-7 w-7 text-white" /> : <Lock className="h-7 w-7 text-white" />}
        </div>

        <h1 className="mt-4 text-xl font-bold">Hermes OS</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>
          {step === "setup-pin" && "Set a PIN to secure your dashboard."}
          {step === "setup-pin-confirm" && "Confirm your PIN."}
          {step === "setup-biometric" && "Add fingerprint / FaceID for one-tap unlock?"}
          {step === "unlock" && (busy ? "Checking biometrics…" : bioTried ? "Enter your PIN." : "Unlock with biometrics or PIN.")}
        </p>

        {step !== "setup-biometric" && (
          <input
            type="password"
            inputMode="numeric"
            autoFocus={step === "unlock" && bioTried}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && submitPin()}
            placeholder={step === "setup-pin-confirm" ? "Re-enter PIN" : "••••"}
            className="mt-6 w-full rounded-xl border bg-transparent px-4 py-3 text-center text-lg tracking-[0.4em] outline-none"
            style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
            maxLength={8}
          />
        )}

        {step === "setup-pin-confirm" && (
          <input
            type="password"
            inputMode="numeric"
            value={pinConfirm}
            onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && submitPin()}
            placeholder="Confirm PIN"
            className="mt-3 w-full rounded-xl border bg-transparent px-4 py-3 text-center text-lg tracking-[0.4em] outline-none"
            style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
            maxLength={8}
          />
        )}

        {error && (
          <div className="mt-4 rounded-lg p-3 text-sm" style={{ background: "rgba(255,92,92,0.10)", color: "var(--red)" }}>
            {error}
          </div>
        )}

        <div className="mt-6 space-y-2">
          {step === "setup-biometric" ? (
            <>
              <button
                onClick={enableBiometric}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
              >
                <Fingerprint className="h-4 w-4" /> {busy ? "Registering…" : "Enable biometrics"}
              </button>
              <button onClick={skipBiometric} className="w-full rounded-xl border px-4 py-3 text-sm" style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}>
                Skip for now
              </button>
            </>
          ) : step === "unlock" && bioEnabled && !bioTried ? (
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
              <KeyRound className="h-4 w-4" /> {step.startsWith("setup") ? "Continue" : "Unlock"}
            </button>
          )}
        </div>

        <div className="mt-6 flex items-start justify-center gap-1.5 text-[11px] leading-relaxed" style={{ color: "var(--text-faint)" }}>
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>Local-only — PIN hashed in your browser, nothing sent to a server</span>
        </div>
      </div>
    </div>
  );
}
