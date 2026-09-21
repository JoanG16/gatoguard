const CACHE_NAME = 'gatoguard-shell-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/estadisticas.html',
  '/calendario.html',
  '/dispositivos.html',
  '/perfil.html',
  '/historial.html',
  '/alertas.html',
  '/alertas-archivadas.html',
  '/manifest.webmanifest',
  '/ui-polish.css',
  '/motion.js',
  '/pwa.js',
  '/icon-192.svg',
  '/icon-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then(response => response || caches.match('/index.html')))
  );
});
