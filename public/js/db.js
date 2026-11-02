// db.js — tiny promise API over IndexedDB. Same interface backed by memory for tests / when
// IndexedDB is unavailable (data is then NOT persisted).
//
//   kv        key/value:  profile, sync (balance + last ledger position), guard (PIN attempts)
//   txns      every payment shown in the app (pending / settled / failed)
//   outbox    signed orders still to be delivered to the server
//   contacts  people you have paid or received from

const TABLES = ['txns', 'outbox', 'contacts'];

export function openDatabase(name = 'offlinepay') {
  if (typeof indexedDB === 'undefined') return openMemoryDatabase();

  const ready = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      for (const t of TABLES) db.createObjectStore(t, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const run = (store, mode, fn) =>
    ready.then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error);
    }));

  const table = (s) => ({
    get: (k) => run(s, 'readonly', (os) => os.get(k)),
    put: (v) => run(s, 'readwrite', (os) => os.put(v)),
    delete: (k) => run(s, 'readwrite', (os) => os.delete(k)),
    all: () => run(s, 'readonly', (os) => os.getAll()),
  });

  return {
    persistent: true,
    kv: {
      get: (k) => run('kv', 'readonly', (os) => os.get(k)),
      set: (k, v) => run('kv', 'readwrite', (os) => os.put(v, k)),
      del: (k) => run('kv', 'readwrite', (os) => os.delete(k)),
    },
    txns: table('txns'),
    outbox: table('outbox'),
    contacts: table('contacts'),
    wipe: () => Promise.all(['kv', ...TABLES].map((s) => run(s, 'readwrite', (os) => os.clear()))),
  };
}

export function openMemoryDatabase() {
  const stores = { kv: new Map(), txns: new Map(), outbox: new Map(), contacts: new Map() };
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));
  const table = (s) => ({
    get: async (k) => copy(stores[s].get(k)),
    put: async (v) => { stores[s].set(v.id, copy(v)); },
    delete: async (k) => { stores[s].delete(k); },
    all: async () => [...stores[s].values()].map(copy),
  });
  return {
    persistent: false,
    kv: {
      get: async (k) => copy(stores.kv.get(k)),
      set: async (k, v) => { stores.kv.set(k, copy(v)); },
      del: async (k) => { stores.kv.delete(k); },
    },
    txns: table('txns'),
    outbox: table('outbox'),
    contacts: table('contacts'),
    wipe: async () => { for (const m of Object.values(stores)) m.clear(); },
  };
}
