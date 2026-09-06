// storage.js — settings in localStorage (needed synchronously at boot),
// everything larger in IndexedDB.

const SETTINGS_KEY = 'rl.settings.v1';
const KEY_KEY = 'rl.apiKey';

export const DEFAULT_SETTINGS = {
  profile: 'foot-walking',
  denominators: [10],
  lensId: null,
  lensScales: {},          // per-lens scale overrides
  speech: true,
  speechRate: 1,
  vibrate: true,
  wakeLock: true,
  units: 'metric',
  minSpacingM: null,       // null = derive from route length
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

// The key is readable by anything running on this origin. That is acceptable
// for a personal app on your own device; it is never written to source.
export const loadApiKey = () => { try { return localStorage.getItem(KEY_KEY) || ''; } catch { return ''; } };
export const saveApiKey = (k) => { try { localStorage.setItem(KEY_KEY, k.trim()); } catch { /* ignore */ } };

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = 'route-lens';
// v2 added the journeys store. Bump this whenever a store is added, or writes
// to the new one fail with NotFoundError on every existing install.
const DB_VERSION = 2;
export const STORES = ['routes', 'lenses', 'journeys'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('routes')) {
        db.createObjectStore('routes', { keyPath: 'id' }).createIndex('by_createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('lenses')) {
        db.createObjectStore('lenses', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('journeys')) {
        db.createObjectStore('journeys', { keyPath: 'id' }).createIndex('by_routeId', 'routeId');
      }
      // 'sessions' was created by v1 and never used.
      if (db.objectStoreNames.contains('sessions')) db.deleteObjectStore('sessions');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Ask Android not to evict us under storage pressure. */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}
