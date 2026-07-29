// Service Worker v2 — Cache-Busting bei jedem Deploy
const VERSION = 'v2026-07-29';

self.addEventListener('install', e => {
  self.skipWaiting(); // Neuer SW wird sofort aktiv
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Alle offenen Tabs neu laden
        return self.clients.matchAll({ type: 'window' });
      })
      .then(clients => clients.forEach(c => c.navigate(c.url)))
  );
});

// Keine Caches — alles direkt vom Netzwerk
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // index.html: immer frisch vom Server
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // Alles andere: normal
  e.respondWith(fetch(e.request));
});
