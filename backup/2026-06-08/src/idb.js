// Tiny promise-based IndexedDB key/value store.
//
// The M3+ catalog (~500k events) blows past the localStorage quota, so the cache
// lives here instead. We only need get/set on a single object store — no indexes,
// no migrations beyond bumping the key names in config. Values are stored by
// structured clone, so we hand IndexedDB the live arrays/objects directly (no
// JSON.stringify), which is both faster and unbounded by string-length limits.
import { IDB_NAME, IDB_STORE } from './config.js';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function idbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('idbSet failed:', e);
  }
}
