/* FieldBook Pro — Service Worker
 * Offline-first cache for the app shell. External API calls (Open-Meteo, maps,
 * CDNs) are network-only and never cached.
 *
 * CACHE VERSIONING: the token __BUILD_VERSION__ is replaced at deploy time by
 * the GitHub Actions workflow with the commit SHA (or a timestamp). That makes
 * the cache name unique per deploy, so a new deploy always installs a fresh
 * cache and the activate handler deletes the old one — users never get stale
 * files. If the token is left unreplaced (e.g. local dev), it falls back to a
 * stable name.
 */
var BUILD = '__BUILD_VERSION__';
if (BUILD.indexOf('BUILD_VERSION') !== -1) { BUILD = 'dev'; } // not substituted
var CACHE = 'fieldbookpro-' + BUILD;

var SHELL = [
  './',
  './index.html',
  './app.html',
  './install-banner.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './offline.html'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (url) {
        return c.add(url).catch(function () { /* optional asset missing — ignore */ });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE && k.indexOf('fieldbookpro-') === 0;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
     .then(function () {
       // Tell open pages a new version is live so they can offer a refresh.
       return self.clients.matchAll({ type: 'window' }).then(function (cs) {
         cs.forEach(function (client) { client.postMessage({ type: 'FB_SW_UPDATED', version: BUILD }); });
       });
     })
  );
});

// Allow a page to force activation immediately.
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'FB_SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Never cache cross-origin API/CDN traffic (weather, maps, xlsx/pptx CDNs).
  if (url.origin !== self.location.origin) return;

  // Navigation requests: cache-first shell, offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(function (cached) {
        return cached || fetch(req).catch(function () { return caches.match('./offline.html'); });
      })
    );
    return;
  }

  // Same-origin assets: cache-first, then network, then cache the fresh copy.
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return caches.match('./offline.html'); });
    })
  );
});
