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
