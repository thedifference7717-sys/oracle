// The Prop Shop's service worker: phone notifications only.
//
// It shows the alerts the engine pushes (scripts/push.mjs in the engine) and
// keeps the count on the app icon's badge, cleared when the app is opened
// (pages.js). It has no fetch handler on purpose: pages are never served
// from a cache, so it can't make the site show anything stale.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "The Prop Shop", {
      body: d.body || "", icon: "propshop-180.png?v=3", badge: "propshop-180.png?v=3",
      data: { url: d.url || "dashboard.html" }
    });
    try {
      const c = await caches.open("ps-badge"), r = await c.match("n");
      const n = (r ? +(await r.text()) || 0 : 0) + 1;
      await c.put("n", new Response(String(n)));
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
    } catch (x) {}
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "dashboard.html";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ("focus" in w) return w.focus();
    return self.clients.openWindow(url);
  }));
});
