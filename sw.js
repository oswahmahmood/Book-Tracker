/* Offline support.
 *
 * The app's own files are fetched from the network first and only fall back to
 * the cache when that fails, so a new version reaches the phone as soon as it
 * is online. Cache-first would be faster by a few milliseconds and would pin
 * the app to whichever copy it saw first — updates could never land.
 *
 * Book covers are the other way round: they never change, so the cached copy
 * is the right answer and saves the request. */
const VERSION = 'v3';
const SHELL = `reading-list-shell-${VERSION}`;
const COVERS = 'reading-list-assets-v1';
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
    // Cache Storage is per origin, and on a github.io account that origin is
    // shared with every other project published there. Only ever touch ours.
    const stale = keys.filter((k) => k.startsWith('reading-list-') && k !== SHELL && k !== COVERS);
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

/* Covers and font files never change for a given URL, so the stored copy is
   the right answer — and it is what keeps the app readable offline. */
const isImmutableAsset = (url) => /(^|\.)covers\.openlibrary\.org$/.test(url.hostname)
  || /(^|\.)books\.google\.com$/.test(url.hostname)
  || /(^|\.)books\.googleusercontent\.com$/.test(url.hostname)
  || /(^|\.)fonts\.googleapis\.com$/.test(url.hostname)
  || /(^|\.)fonts\.gstatic\.com$/.test(url.hostname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (isImmutableAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(COVERS);
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      // Cover images are fetched no-cors, so a success is indistinguishable
      // from a 404 — both arrive opaque. What can be told apart is a visible
      // error, and that must not be stored: a cached 404 is a cover that stays
      // broken for ever. (The app double-checks covers load, and forgets the
      // ones that do not.)
      const worthKeeping = res.ok || res.type === 'opaque';
      if (worthKeeping) {
        try {
          await cache.put(request, res.clone());
        } catch (err) { /* not cacheable — serve it from the network each time */ }
      }
      return res;
    })());
    return;
  }

  // Metadata lookups always go to the network — stale results help nobody.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      // 'no-cache' revalidates with the server rather than trusting the
      // browser's own copy, which GitHub Pages lets it hold for ten minutes.
      // Unchanged files come back as a cheap 304; a new version arrives at
      // once instead of whenever that ten minutes happens to lapse.
      const res = await fetch(request, { cache: 'no-cache' });
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
