// scribe service worker — precache app shell + runtime cache for offline.
// API requests are NOT intercepted; the IDB-backed sync engine handles those.

const CACHE_VERSION = 'scribe-shell-v2';
const SHELL_PATHS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(SHELL_PATHS);
      try {
        const res = await fetch('/asset-manifest.json');
        if (res.ok) {
          const assets = await res.json();
          await Promise.all(
            assets.map((url) => cache.add(url).catch(() => {})),
          );
        }
      } catch {
        // Manifest not available (dev mode) — skip
      }
    })(),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('scribe-shell-') && k !== CACHE_VERSION)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Don't touch API — let it hit the network, fail naturally if offline.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation: network-first, fall back to cached index.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((m) => m || Response.error())),
    );
    return;
  }

  // Static assets: cache-first (hashed filenames guarantee freshness).
  if (
    url.pathname.startsWith('/assets/') ||
    /\.(?:js|css|woff2?|svg|png|ico|json)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
            return res;
          }).catch(() => Response.error()),
      ),
    );
  }
});
