// Hermes OS v2 — Push subscription client
// Registers the service worker, subscribes to Web Push, and syncs the
// subscription through the same-origin Vercel routes (/api/push/*), which
// proxy to the local state server via the ngrok tunnel. Same-origin keeps
// the phone on Vercel's CDN — no fragile direct browser→ngrok hop.

export async function isPushSupported(): Promise<boolean> {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export async function getPushStatus(): Promise<{ enabled: boolean; subscriptions: number }> {
  try {
    const res = await fetch("/api/push", { cache: "no-store" });
    const data = await res.json();
    return { enabled: Boolean(data?.enabled), subscriptions: Number(data?.subscriptions ?? 0) };
  } catch {
    return { enabled: false, subscriptions: 0 };
  }
}

export async function getVapidKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/push/vapid", { cache: "no-store" });
    const data = await res.json();
    return data?.public_key ?? null;
  } catch {
    return null;
  }
}

export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!(await isPushSupported())) {
    return { ok: false, error: "This browser doesn't support push notifications." };
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    const vapid = await getVapidKey();
    if (!vapid) return { ok: false, error: "Couldn't reach the push server (state server offline?)." };

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    });

    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data?.error ?? `Subscribe failed (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disablePush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Tell the state server to drop it first (so it stops sending).
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/push/test", { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data?.error ?? `Test failed (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function watchRunCompletion(options: {
  runId: string;
  sessionId: string;
  url: string;
  title?: string;
}): void {
  if (!options.runId || !options.sessionId) return;
  void fetch("/api/push/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: options.runId,
      session_id: options.sessionId,
      url: options.url,
      title: options.title ?? "Hermes replied",
    }),
    keepalive: true,
  }).catch(() => {
    // Streaming remains authoritative; push registration is best-effort.
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
