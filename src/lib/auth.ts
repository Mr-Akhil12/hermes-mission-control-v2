"use client";

const CRED_KEY = "hermesos.webauthn.cred";
const UNLOCK_KEY = "hermesos.unlocked";

export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`hermes-os:${pin}:v1`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isPinSet(): boolean {
  return true;
}

export async function setPin(_pin: string): Promise<void> {
  void _pin;
}

export async function verifyPin(pin: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

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

export function markUnlocked(hours = 12): void {
  localStorage.setItem(UNLOCK_KEY, String(Date.now() + hours * 3600 * 1000));
}

export function lockNow(): void {
  localStorage.removeItem(UNLOCK_KEY);
}

const RP_ID = typeof window !== "undefined" ? window.location.hostname : "localhost";
const RP_NAME = "Hermes OS";

export function biometricSupported(): boolean {
  return typeof window !== "undefined" && !!(
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
  );
}

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
        authenticatorAttachment: "platform",
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

export function deleteBiometric(): void {
  localStorage.removeItem(CRED_KEY);
}

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
