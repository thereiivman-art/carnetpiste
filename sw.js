// Service worker of the installable PWA. Goal: the app opens and works
// with no network at all (airplane mode at the paddock), not just once it
// is already open.
//
// Three caches:
// - SHELL (CACHE_VERSION): index.html, app.js, style.css... Bump
//   CACHE_VERSION whenever one of them changes (same convention as the ?v=
//   in index.html) so returning devices get the new files.
// - ASSETS (ASSETS_VERSION): every circuit outline. Kept across app
//   versions so a release doesn't re-download them all; bump ASSETS_VERSION
//   when an outline is added or redrawn, and add new files to TRACK_URLS.
// - LIBS: third-party scripts and fonts (Firebase SDK, Google Fonts, the
//   timesheet reader). Their URLs carry a fixed version, so a cached copy
//   never goes stale; kept across app versions too.
var CACHE_VERSION = 'cdp-2026103059';
var ASSETS_VERSION = 'cdp-assets-traces-55';
var LIBS_CACHE = 'cdp-libs-1';
var SHELL_URLS = [
  './',
  './index.html',
  './style.css?v=2026103059',
  './chrono-import.js?v=2026103059',
  './app.js?v=2026103059',
  './manifest.json',
  './firebase-config.js',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];
var TRACK_URLS = [
  './circuit-outlines/Albi.png',
  './circuit-outlines/Alcarras.png',
  './circuit-outlines/Ales.png',
  './circuit-outlines/Almeria.png',
  './circuit-outlines/Aragon.png',
  './circuit-outlines/Assen.png',
  './circuit-outlines/Barcelone.png',
  './circuit-outlines/Brands%20Hatch.png',
  './circuit-outlines/Bresse.png',
  './circuit-outlines/Brno.png',
  './circuit-outlines/Buriram.png',
  './circuit-outlines/COTA.png',
  './circuit-outlines/Calafat.png',
  './circuit-outlines/Carole.png',
  './circuit-outlines/Cartagena.png',
  './circuit-outlines/Cremona.png',
  './circuit-outlines/Croix-en-Ternois.png',
  './circuit-outlines/Dijon-Prenois.png',
  './circuit-outlines/Donington.png',
  './circuit-outlines/Estoril.png',
  './circuit-outlines/Hockenheim.png',
  './circuit-outlines/Imola.png',
  './circuit-outlines/Jarama.png',
  './circuit-outlines/Jerez.png',
  './circuit-outlines/Le%20Mans.png',
  './circuit-outlines/Le%20Vigeant.png',
  './circuit-outlines/Ledenon.png',
  './circuit-outlines/Losail.png',
  './circuit-outlines/Magny%20Cours.png',
  './circuit-outlines/Mandalika.png',
  './circuit-outlines/Mettet.png',
  './circuit-outlines/Misano.png',
  './circuit-outlines/Most.png',
  './circuit-outlines/Pannonia-Ring.png',
  './circuit-outlines/Pau-Arnos.png',
  './circuit-outlines/Haute%20Saintonge.png',
  './circuit-outlines/Motegi.png',
  './circuit-outlines/Mugello.png',
  './circuit-outlines/Navarra.png',
  './circuit-outlines/Nogaro.png',
  './circuit-outlines/Nurburgring.png',
  './circuit-outlines/Paul%20Ricard.png',
  './circuit-outlines/Phillip%20Island.png',
  './circuit-outlines/Portimao.png',
  './circuit-outlines/Red%20Bull%20Ring.png',
  './circuit-outlines/Sachsenring.png',
  './circuit-outlines/Silverstone.png',
  './circuit-outlines/Slovakia%20Ring.png',
  './circuit-outlines/Spa-Francorchamps.png',
  './circuit-outlines/Termas%20de%20Rio%20Hondo.png',
  './circuit-outlines/Valence.png',
  './circuit-outlines/Vallelunga.png',
  './circuit-outlines/Varano.png',
  './circuit-outlines/Zolder.png'
];
// Without these the page can't even start offline (index.html loads them
// from Google's CDN before app.js).
var LIB_URLS = [
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,500;0,600;0,700;0,800;1,700;1,800&family=Barlow:wght@400;500;600;700&display=swap'
];
// Cross-origin hosts whose responses are cached on first use (fonts files,
// the timesheet reader and its language data, the QR code library).
var LIB_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'tessdata.projectnaptha.com'];

// Caches one URL; a failure only skips that file (an outline removed by
// an admin must not break the whole install).
function cacheOne(cache, url) {
  var cross = url.indexOf('http') === 0;
  return fetch(url, cross ? { mode: 'cors', credentials: 'omit' } : undefined)
    .catch(function () { return cross ? fetch(url, { mode: 'no-cors' }) : Promise.reject(); })
    .then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) return cache.put(url, res);
    })
    .catch(function () {});
}
function fillCache(name, urls, onlyMissing) {
  return caches.open(name).then(function (cache) {
    return Promise.all(urls.map(function (url) {
      if (!onlyMissing) return cacheOne(cache, url);
      return cache.match(url).then(function (hit) { return hit || cacheOne(cache, url); });
    }));
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(Promise.all([
    fillCache(CACHE_VERSION, SHELL_URLS, false),
    fillCache(ASSETS_VERSION, TRACK_URLS, true),
    fillCache(LIBS_CACHE, LIB_URLS, true)
  ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  var keep = [CACHE_VERSION, ASSETS_VERSION, LIBS_CACHE];
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return keep.indexOf(k) === -1; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function fromCacheThenNetwork(req, cacheName) {
  return caches.match(req, { ignoreVary: true }).then(function (cached) {
    var network = fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) {
        var copy = res.clone();
        caches.open(cacheName).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () { return cached; });
    return cached || network;
  });
}

// Firestore and Auth traffic (firestore.googleapis.com, identitytoolkit...)
// is left alone: Firestore keeps its own offline copy of the data and
// queues writes (db.enablePersistence() in app.js).
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (LIB_HOSTS.indexOf(url.hostname) === -1) return;
    // Versioned URLs: the cached copy is served as is, the network only
    // fills the cache the first time.
    event.respondWith(caches.match(req, { ignoreVary: true }).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(LIBS_CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    }));
    return;
  }

  // Opening/reloading the page: network first so a connected device gets
  // the latest index.html, cached shell the moment there is no network.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html').then(function (hit) { return hit || caches.match('./'); });
      })
    );
    return;
  }

  // App files and outlines: cached copy right away, refreshed in the
  // background.
  var cacheName = url.pathname.indexOf('/circuit-outlines/') !== -1 ? ASSETS_VERSION : CACHE_VERSION;
  event.respondWith(fromCacheThenNetwork(req, cacheName));
});

// Lets a page force an already-installed worker to activate immediately
// (see the "new version available" reload prompt in app.js) instead of
// waiting for every tab to close first.
self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
