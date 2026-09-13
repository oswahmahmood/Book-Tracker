/* Offline support: the app shell is cached on install, book covers are cached
   as they are fetched so the list still looks right on a plane. */
const SHELL = 'reading-list-shell-v1';
const COVERS = 'reading-list-covers-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== COVERS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isCover = (url) => /(^|\.)covers\.openlibrary\.org$/.test(url.hostname)
  || /(^|\.)books\.google\.com$/.test(url.hostname)
  || /(^|\.)books\.googleusercontent\.com$/.test(url.hostname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (isCover(url)) {
    event.respondWith(
      caches.open(COVERS).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
        return res;
      }).catch(() => Response.error()),
    );
    return;
  }

  // Metadata lookups always go to the network — stale results help nobody.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok) caches.open(SHELL).then((cache) => cache.put(request, res.clone()));
      return res.clone();
    })),
  );
});
