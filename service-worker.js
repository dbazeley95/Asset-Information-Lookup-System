// Exists only to satisfy the browser's PWA installability check (a
// manifest alone isn't enough — Chrome/Edge also require a registered
// service worker with a fetch handler). No offline caching, so it never
// fights the ?v= cache-busting used elsewhere — every request just goes
// straight to the network.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
