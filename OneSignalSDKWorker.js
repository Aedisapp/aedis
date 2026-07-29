// AEDIS — service worker único (push de OneSignal + gestión de caché)
//
// Antes había DOS service workers separados: sw.js en la raíz (scope
// /AEDIS_APP/, solo cache-busting) y este archivo en push/onesignal/
// (scope /AEDIS_APP/push/onesignal/, solo push). Registrar dos workers
// casi al mismo tiempo al cargar la app es válido según la spec, pero
// Safari/iOS es notablemente menos fiable que Chrome gestionando el
// registro simultáneo de varios service workers — se sospecha que esa
// carrera impedía que la suscripción push llegara a completarse en
// iPhone pese a que el usuario concedía el permiso correctamente
// (confirmado: 0 suscripciones con push token real en el Dashboard de
// OneSignal, solo en iOS, mientras que desde Chrome sí funcionaba).
//
// Ahora hay un único worker en la raíz de la app, con scope único que
// cubre toda la app — sin ambigüedad de cuál service worker controla
// qué. El script de OneSignal (importado abajo) solo escucha 'activate',
// 'message', 'notificationclick', 'notificationclose', 'push' y
// 'pushsubscriptionchange' — nunca 'install' ni 'fetch' — así que añadir
// esos dos aquí no compite con nada de OneSignal.
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

// Siempre red, nunca caché (igual que el antiguo sw.js) — evita que la PWA
// se quede pegada a una versión antigua del HTML/CSS/JS tras un redeploy.
// BUG CORREGIDO: fetch(request) sin más SIGUE respetando el Cache-Control
// HTTP normal del navegador — y GitHub Pages sirve con "max-age=600" (10
// min). O sea que "siempre red" no garantizaba red de verdad: dentro de
// esos 10 minutos, Safari podía devolver una copia cacheada sin ni
// siquiera hacer la petición. Con varios redeploys seguidos en pocos
// minutos (como durante esta depuración), eso significaba que el
// teléfono podía seguir viendo código antiguo pese a "actualizar".
// { cache: 'no-store' } fuerza una petición de red real siempre, sin
// consultar ni guardar en el HTTP cache del navegador.
self.addEventListener('fetch', function(e) {
  e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(function() { return caches.match(e.request); }));
});

// ═══ BADGE DEL ICONO EN TIEMPO REAL, incluso con la app cerrada ═══
// navigator/registration.setAppBadge() no tiene "getter" — no se puede
// leer el valor actual del badge desde aquí, solo ponerlo. Para poder
// INCREMENTARLO al recibir un push con la app cerrada, guardamos el
// último valor conocido en IndexedDB (accesible tanto desde la página
// como desde este worker; localStorage NO está disponible en un SW). La
// página (ver updateAppIconBadge en index.html) escribe ahí el valor
// REAL cada vez que lo recalcula, así que en cuanto se abre la app una
// vez el contador se resincroniza — entre aperturas, cada push solo
// suma 1 de forma optimista.
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
