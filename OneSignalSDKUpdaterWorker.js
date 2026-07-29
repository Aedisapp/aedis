// AEDIS — copia idéntica de OneSignalSDKWorker.js con otro nombre.
// OneSignal exige históricamente dos archivos (uno "principal" y uno
// "updater") para su mecanismo de detección de actualizaciones del SDK,
// aunque en la práctica basta con que ambos existan y tengan el mismo
// contenido — así que este archivo es una copia exacta del principal.
// Si editas OneSignalSDKWorker.js, copia los mismos cambios aquí.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(function() { return caches.match(e.request); }));
});

// ═══ BADGE DEL ICONO EN TIEMPO REAL, incluso con la app cerrada ═══
// Ver comentario completo en OneSignalSDKWorker.js — misma lógica.
function badgeDbGet() {
  return new Promise(function(resolve) {
    try {
      var req = indexedDB.open('aedis-badge', 1);
      req.onupgradeneeded = function() { req.result.createObjectStore('state'); };
      req.onsuccess = function() {
        var tx = req.result.transaction('state', 'readonly');
        var getReq = tx.objectStore('state').get('count');
        getReq.onsuccess = function() { resolve(getReq.result || 0); };
        getReq.onerror = function() { resolve(0); };
      };
      req.onerror = function() { resolve(0); };
    } catch(e) { resolve(0); }
  });
}
function badgeDbSet(count) {
  return new Promise(function(resolve) {
    try {
      var req = indexedDB.open('aedis-badge', 1);
      req.onupgradeneeded = function() { req.result.createObjectStore('state'); };
      req.onsuccess = function() {
        var tx = req.result.transaction('state', 'readwrite');
        tx.objectStore('state').put(count, 'count');
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { resolve(); };
      };
      req.onerror = function() { resolve(); };
    } catch(e) { resolve(); }
  });
}
self.addEventListener('push', function(e) {
  if (!self.registration || !('setAppBadge' in self.registration)) return;
  e.waitUntil(
    badgeDbGet()
      .then(function(count) { return badgeDbSet(count + 1).then(function(){ return self.registration.setAppBadge(count + 1); }); })
      .catch(function() {})
  );
});
