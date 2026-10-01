(() => {
  const DB_NAME = 'gatoguard-offline';
  const STORE_NAME = 'gateway-operations';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'device_id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacenamiento sin conexión.'));
    });
  }

  async function transact(mode, action) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = action(store);
        let result;
        if (request) {
          request.onsuccess = () => { result = request.result; };
          request.onerror = () => reject(request.error);
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('No se pudo guardar el cambio sin conexión.'));
      });
    } finally {
      db.close();
    }
  }

  async function save(operation) {
    const result = await transact('readwrite', store => store.put(operation));
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(registration => {
        if ('sync' in registration) return registration.sync.register('sync-gateway-outbox');
        return undefined;
      }).catch(error => console.warn('[Dispositivos] No se pudo programar la sincronización:', error));
    }
    return result;
  }

  window.GatewayOutbox = Object.freeze({
    all: () => transact('readonly', store => store.getAll()),
    save,
    remove: deviceId => transact('readwrite', store => store.delete(deviceId))
  });
})();
