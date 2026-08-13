"use client";

/**
 * Hermes OS v2 — Local auth: PIN (hashed) + WebAuthn biometric unlock.
 * Local-first, no server. PIN hash + credential id live in localStorage.
 */

const PIN_KEY = "hermesos.pin.hash";
const CRED_KEY = "hermesos.webauthn.cred";
const UNLOCK_KEY = "hermesos.unlocked";

/**
 * HARDCODED PIN (user-specified 13 Aug 2026): REDACTED.
 * The PIN is permanent and can NEVER be changed or re-set. The setup flow
 * never runs because isPinSet() always returns true, and setPin() is a no-op.
 * Hash = SHA-256("hermes-os:REDACTED:v1").
 */
const HARDCODED_PIN_HASH = "REDACTED";

/** SHA-256 via WebCrypto — salted with a static local pepper (not a secret, just obfuscation). */
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`hermes-os:${pin}:v1`);
  try {
    if (crypto?.subtle?.digest) {
      const digest = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // fall through to JS fallback
  }
  // Fallback (e.g. WebCrypto unavailable in some embedded contexts): FNV-1a 64-bit.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const c of `hermes-os:${pin}:v1`) {
    h1 = Math.imul(h1 ^ c.charCodeAt(0), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c.charCodeAt(0), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** PIN is ALWAYS set — the hardcoded PIN is permanent. Setup never runs. */
export function isPinSet(): boolean {
  return true;
}

/** No-op — the PIN can never be changed. */
export async function setPin(_pin: string): Promise<void> {
  // Intentionally does nothing. The PIN is hardcoded (REDACTED) and permanent.
}

export async function verifyPin(pin: string): Promise<boolean> {
  // Hardcoded PIN is the offline master fallback. localStorage hash kept for migration only.
  const stored = localStorage.getItem(PIN_KEY);
  const hardcodedOk = (await hashPin(pin)) === HARDCODED_PIN_HASH;
  if (hardcodedOk) return true;
  if (stored) return (await hashPin(pin)) === stored;
  return false;
}

/* ── Universal PIN (Turso) ─────────────────────────────────────────── */

/** Fetch the universal PIN hash from Turso (same PIN on every device). */
export async function fetchRemotePinHash(): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/pin", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.hash === "string" ? data.hash : null;
  } catch {
    return null;
  }
}

/** Verify a PIN against the universal (Turso) hash, falling back to the hardcoded master. */
export async function verifyPinUniversal(pin: string): Promise<boolean> {
  const remote = await fetchRemotePinHash();
  if (remote) {
    return (await hashPin(pin)) === remote;
  }
  // Turso unreachable → hardcoded master PIN still works (offline fallback).
  return (await hashPin(pin)) === HARDCODED_PIN_HASH;
}

/** Change the universal PIN (writes the new hash to Turso). Returns true on success. */
export async function changePinUniversal(newPin: string): Promise<boolean> {
  const hash = await hashPin(newPin);
  try {
    const res = await fetch("/api/auth/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

export function isUnlocked(): boolean {
  const until = Number(localStorage.getItem(UNLOCK_KEY) ?? "0");
  return Date.now() < until;
}

/** Unlock for the session (e.g. 12h) so the app doesn't nag on every reload. */
export function markUnlocked(hours = 12): void {
  localStorage.setItem(UNLOCK_KEY, String(Date.now() + hours * 3600 * 1000));
}

export function lockNow(): void {
  localStorage.removeItem(UNLOCK_KEY);
}

/* ── WebAuthn (biometric) ─────────────────────────────────────────── */

const RP_ID = typeof window !== "undefined" ? window.location.hostname : "localhost";
const RP_NAME = "Hermes OS";

export function biometricSupported(): boolean {
  return typeof window !== "undefined" && !!(
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
  );
}

/** Register a platform authenticator (fingerprint / FaceID). */
export async function registerBiometric(): Promise<boolean> {
  if (!biometricSupported()) return false;

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: RP_ID, name: RP_NAME },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "akhil",
        displayName: "Akhil Pillay",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform", // fingerprint / FaceID only
        userVerification: "required",
      },
      timeout: 60000,
    },
  });

  if (!cred) return false;
  localStorage.setItem(CRED_KEY, cred.id);
  return true;
}

export function hasBiometric(): boolean {
  return !!localStorage.getItem(CRED_KEY);
}

/** Remove the stored biometric credential for this device (app-level only). */
export function deleteBiometric(): void {
  localStorage.removeItem(CRED_KEY);
}

/** Verify via platform authenticator. */
export async function authenticateBiometric(): Promise<boolean> {
  if (!biometricSupported()) return false;
  const credId = localStorage.getItem(CRED_KEY);
  if (!credId) return false;

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: "public-key", id: base64UrlToBuffer(credId) }],
        userVerification: "required",
        timeout: 60000,
      },
    });
    return !!assertion;
  } catch {
    return false;
  }
}

function base64UrlToBuffer(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const b64 = pad + "=".repeat((4 - (pad.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
