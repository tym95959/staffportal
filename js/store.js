// Tiny IndexedDB wrapper used for the on-device copy of portal data and roster drafts.
// Falls back to memory if IndexedDB is unavailable (private browsing, blocked storage).
const DB_NAME = 'staffportal';
const STORES = ['cache', 'drafts', 'meta'];
const memory = Object.fromEntries(STORES.map(s => [s, new Map()]));
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const d = req.result; STORES.forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}
const unwrap = r => (r && typeof r === 'object' && 'result' in r ? r.result : undefined);
function run(store, mode, fn) {
  return openDb().then(d => {
    if (!d) return unwrap(fn(null));
    return new Promise(resolve => {
      try {
        const t = d.transaction(store, mode); const os = t.objectStore(store);
        const req = fn(os);
        t.oncomplete = () => resolve(unwrap(req));
        t.onerror = t.onabort = () => resolve(undefined);
      } catch { resolve(unwrap(fn(null))); }
    });
  });
}

export const idb = {
  get: (store, key) => run(store, 'readonly', os => os ? os.get(key) : { result: memory[store].get(key) }),
  set: (store, key, value) => run(store, 'readwrite', os => { if (os) return os.put(value, key); memory[store].set(key, value); }),
  del: (store, key) => run(store, 'readwrite', os => { if (os) return os.delete(key); memory[store].delete(key); }),
  keys: (store) => run(store, 'readonly', os => os ? os.getAllKeys() : { result: [...memory[store].keys()] }),
  clear: (store) => run(store, 'readwrite', os => { if (os) return os.clear(); memory[store].clear(); })
};
