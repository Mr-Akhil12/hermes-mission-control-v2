// Hermes OS v2 — Push service worker
// Receives Web Push notifications and shows them as system notifications.
// Clicking opens the dashboard at the relevant page.

self.addEventListener("push", (event) => {
  let data = { title: "Hermes OS", body: "", url: "/approvals", tag: "hermes" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // Not JSON — use raw text as body
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag,
    data: { url: data.url },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/approvals";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ── Offline: network-first for GET page/static requests ────────────────
// API routes are deliberately NOT cached (they're auth-gated and session
// cookies are required) — offline just serves the app shell + last pages.

const CACHE = "hermes-os-v1";
const SHELL = ["/", "/chat", "/approvals", "/crons", "/dev", "/agents", "/sessions", "/channels", "/settings", "/trading", "/studio", "/personal", "/native"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.filter((p) => p !== "/native")))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/") && url.search) return; // versioned chunks — never stale

  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match("/"))
      )
  );
});
