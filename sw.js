// Service worker for the installable PWA shell. Bump CACHE_VERSION whenever
// any precached file changes (same convention as the ?v= on app.js/style.css
// in index.html) so returning devices pick up the new files instead of
// serving a stale cache forever.
var CACHE_VERSION = 'cdp-2026091301';
var PRECACHE_URLS = [
  './',
  './index.html',
  './style.css?v=2026091301',
  './app.js?v=2026091301',
  './manifest.json',
  './firebase-config.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './circuit-outlines/Barcelone.png',
  './circuit-outlines/Carole.png',
  './circuit-outlines/Jerez.png',
  './circuit-outlines/Le%20Mans.png',
  './circuit-outlines/Magny%20Cours.png',
  './circuit-outlines/Misano.png',
  './circuit-outlines/Mugello.png',
  './circuit-outlines/Navarra.png'
];

self.addEventListener('install', function (event) {
  // cache.addAll() is all-or-nothing -- one missing/renamed file (an admin
  // removing a circuit outline, say) would otherwise fail the ENTIRE
  // install and leave the app with no offline shell at all. Caching each
  // URL individually means a single miss just skips that one file.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) {
        return Promise.all(PRECACHE_URLS.map(function (url) {
          return cache.add(url).catch(function () {});
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Firestore/Auth/CDN calls (googleapis.com, gstatic.com, firebaseio.com,
// fonts.googleapis.com...) are all cross-origin -- left untouched here so
// they hit the network directly; Firestore has its own offline persistence
// (see db.enablePersistence() in app.js) for the data side of "works
// offline". This worker only owns the static app shell.
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Navigations (opening/reloading the page): try the network first so a
  // connected device always gets the latest index.html, falling back to
  // the cached shell the moment the network is unavailable.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // Everything else (app.js, style.css, icons, circuit outlines): serve
  // from cache instantly if present, refill/refresh the cache from the
  // network in the background either way.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});

// Lets a page force an already-installed worker to activate immediately
// (see the "new version available" reload prompt in app.js) instead of
// waiting for every tab to close first.
self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
