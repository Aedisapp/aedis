// DEPRECADO — sustituido por OneSignalSDKWorker.js (ver ese archivo:
// ahora un único service worker en la raíz gestiona tanto el push de
// OneSignal como el cache-busting que antes hacía este sw.js).
//
// Este archivo se mantiene en el servidor solo para que los clientes que
// ya lo tuvieran registrado de una instalación anterior de la PWA puedan
// recibir esta actualización y auto-desregistrarse — index.html ya no lo
// registra en instalaciones nuevas. No borrar sin confirmar que ya no
// queda ningún usuario con la versión antigua activa.
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    self.registration.unregister().then(function() {
      return self.clients.matchAll();
    }).then(function(clients) {
      clients.forEach(function(client) { client.navigate(client.url); });
    })
  );
});
