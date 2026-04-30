// ======================================================
// IndexedDB-Wrapper — minimal, key-value-style
// ======================================================
// DB-Name: renex-keys
// Object-Store: keys
//
// Wird von e2eKeys.js genutzt für Keypair-Persistenz.
// CryptoKey-Objekte sind in IDB direkt serialisierbar (structured clone).
//
// Migration aus renex-legacy/js/e2e.js Lines 1-55.
// ======================================================

const DB_NAME = 'renex-keys';
const STORE = 'keys';
// VERSION 2: Heilung-Migration. Manche DB-Instanzen wurden bei v1 ohne den
// 'keys'-Store angelegt (Legacy-Bug). Bump auf 2 erzwingt onupgradeneeded
// → Store wird (idempotent) angelegt.
const VERSION = 2;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);

    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };

    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };

    req.onsuccess = () => {
      const db = req.result;
      // Wenn Browser DB schließt (Version-Upgrade etc.) → Cache invalidieren
      db.onclose = () => { _dbPromise = null; };
      db.onerror = () => { _dbPromise = null; };
      resolve(db);
    };
  });

  return _dbPromise;
}

/**
 * Liest einen Wert aus IndexedDB.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
export async function idbGet(key) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  return new Promise((resolve) => {
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

/**
 * Schreibt einen Wert nach IndexedDB.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<boolean>}
 */
export async function idbSet(key, value) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Listet alle Keys mit gegebenem Prefix.
 * Wird genutzt um CMK-Einträge ("cmk:me:*") für Bundle-Sync zu sammeln.
 *
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function idbListKeys(prefix) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  return new Promise((resolve) => {
    const out = [];
    const req = tx.objectStore(STORE).openKeyCursor();
    req.onerror = () => resolve(out);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      const k = String(cursor.key);
      if (!prefix || k.startsWith(prefix)) out.push(k);
      cursor.continue();
    };
  });
}

/**
 * Löscht einen Wert aus IndexedDB.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function idbDelete(key) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
