/* FieldBook Pro service worker (self-healing, loop-proof) */
var VERSION = '__BUILD_VERSION__';
var CACHE = 'fieldbookpro-' + VERSION;
var SHELL = ['./','./index.html','./app.html','./manifest.webmanifest',
  './icons/icon-192.png','./icons/icon-512.png','./offline.html'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'FB_SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return resp;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) { return r || caches.match('./offline.html'); });
      })
    );
    return;
  }
  e.respondWith(caches.match(req).then(function (r) {
    return r || fetch(req).then(function (resp) {
      var copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return resp;
    }).catch(function () { return r; });
  }));
});
