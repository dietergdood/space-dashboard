// Service Worker deaktiviert - kein Caching
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Alle Requests direkt ans Netzwerk
self.addEventListener('fetch', () => {});
