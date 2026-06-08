const CACHE_NAME = 'webft8-assets-v3';

// Force immediate activation without waiting
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Purge all old and current caches to break any deadlock
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          console.log('[Service Worker] Evicting active cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Network-only/Network-first with bypass to ensure the app is never locked and always gets latest live builds
self.addEventListener('fetch', (event) => {
  // Let the browser fetch directly from network. Do not serve stale assets.
  return; 
});
