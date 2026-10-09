const CACHE_NAME = 'gatoguard-shell-v6';
const DATA_CACHE = 'gatoguard-data-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/estadisticas.html',
  '/calendario.html',
  '/dispositivos.html',
  '/gateway-outbox.js',
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
      keys.filter(key => key !== CACHE_NAME && key !== DATA_CACHE).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('push', event => {
  if (!event.data) return;
  const payload = event.data.json();
  const url = new URL(payload.url || '/index.html', self.location.origin);
  const destino = url.origin === self.location.origin ? `${url.pathname}${url.search}` : '/index.html';
  event.waitUntil(self.registration.showNotification(payload.title || 'GatoGuard', {
    body: payload.body || 'Hay una novedad en la rutina de tu gato.',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: payload.tag || 'gatoguard-alerta',
    data: { url: destino },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destino = new URL(event.notification.data?.url || '/index.html', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientes => {
      const existente = clientes.find(client => client.url.startsWith(self.location.origin));
      if (existente) {
        return existente.navigate(destino).then(client => (client || existente).focus());
      }
      return self.clients.openWindow(destino);
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const ruta = new URL(event.request.url).pathname;
  if (ruta.startsWith('/api/')) {
    if (ruta.startsWith('/api/push')) return;
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(DATA_CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request, { cacheName: DATA_CACHE }).then(response =>
        response || new Response(JSON.stringify({ error: 'Sin conexión' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        })
      ))
    );
    return;
  }
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then(response => response || caches.match('/index.html')))
  );
});

async function syncGatewayOutbox() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('gatoguard-offline', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la cola local.'));
  });
  try {
    const operations = await new Promise((resolve, reject) => {
      const request = db.transaction('gateway-operations', 'readonly')
        .objectStore('gateway-operations').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    for (const operation of operations) {
      if (operation.conflict) continue;
      if (operation.action !== 'delete' && !operation.configured) continue;
      const url = `/api/gateways/${encodeURIComponent(operation.device_id)}`;
      const options = {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operation)
      };
      let response;
      if (operation.action === 'delete') {
        response = await fetch(url, { ...options, method: 'DELETE' });
      } else if (operation.action === 'update') {
        response = await fetch(url, { ...options, method: 'PATCH' });
        if (response.status === 404) {
          response = await fetch('/api/gateways/provision', { ...options, method: 'POST' });
        }
      } else {
        response = await fetch('/api/gateways/provision', { ...options, method: 'POST' });
      }

      const transaction = db.transaction('gateway-operations', 'readwrite');
      const store = transaction.objectStore('gateway-operations');
      if (response.ok) {
        store.delete(operation.device_id);
      } else if (response.status === 409) {
        store.put({ ...operation, conflict: true, error: (await response.json()).error || 'La zona requiere revisión.' });
      } else {
        throw new Error(`No se pudo sincronizar ${operation.device_id}: ${response.status}`);
      }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('No se pudo actualizar la cola.'));
      });
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type: 'gateway-outbox-updated' }));
  } finally {
    db.close();
  }
}

self.addEventListener('sync', event => {
  if (event.tag === 'sync-gateway-outbox') event.waitUntil(syncGatewayOutbox());
});

