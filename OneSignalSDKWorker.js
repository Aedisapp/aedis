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
