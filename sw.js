/* Offline support.
 *
 * The app's own files are fetched from the network first and only fall back to
 * the cache when that fails, so a new version reaches the phone as soon as it
 * is online. Cache-first would be faster by a few milliseconds and would pin
 * the app to whichever copy it saw first — updates could never land.
 *
 * Book covers are the other way round: they never change, so the cached copy
 * is the right answer and saves the request. */
const VERSION = 'v2';
const SHELL = `reading-list-shell-${VERSION}`;
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
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== SHELL && k !== COVERS);
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();

    // An older version was in charge, so any open page is showing its markup
    // and styles. Send those pages round again on this one rather than making
    // someone reload by hand to see an update.
    if (stale.length) {
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) {
        try {
          await client.navigate(client.url);
        } catch (err) { /* a page we may not navigate — it will update on its own next load */ }
      }
    }
  })());
});

const isCover = (url) => /(^|\.)covers\.openlibrary\.org$/.test(url.hostname)
  || /(^|\.)books\.google\.com$/.test(url.hostname)
  || /(^|\.)books\.googleusercontent\.com$/.test(url.hostname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (isCover(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(COVERS);
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      // Cover images are fetched no-cors, so the response is opaque and some
      // browsers refuse to store it. Failing to cache must never fail the image.
      try {
        await cache.put(request, res.clone());
      } catch (err) { /* not cacheable — serve it from the network each time */ }
      return res;
    })());
    return;
  }

  // Metadata lookups always go to the network — stale results help nobody.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res.ok) {
        const cache = await caches.open(SHELL);
        await cache.put(request, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(request);
      if (hit) return hit;
      // An offline navigation to a URL we never cached still gets the app.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
