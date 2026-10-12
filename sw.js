const CACHE_NAME = 'pakan-cbl-v5';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json'
];

// Install & paksa versi baru langsung aktif
self.addEventListener('install', event => {
  self.skipWaiting(); 
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// Bersihkan memori versi lama (v1, v2) otomatis
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    })
  );
});

// Strategi: Jaringan Utama, Offline sebagai Cadangan (Network First)
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
