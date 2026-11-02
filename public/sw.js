// sw.js — makes the app load with no network.
//
//  • On install it downloads the whole app shell into a versioned cache.
//  • Afterwards every page, script and icon is answered from that cache first (instant, offline-safe).
//  • /api/* requests are never touched: the app handles being offline itself (pending payments).
//  • Background Sync (Chrome) delivers queued payments even when the app is closed.
//
// VERSION: `node server.js` replaces the token below with a fingerprint of your files, so a changed
// file means a new cache automatically. If you host the files somewhere else, replace the token with
// a version string yourself and change it every time you edit anything in public/.
const VERSION = '__BUILD__';
const CACHE = `opay-shell-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/styles.css',
  '/js/app.js',
  '/js/config.js',
  '/js/crypto.js',
  '/js/db.js',
  '/js/errors.js',
  '/js/format.js',
  '/js/protocol.js',
  '/js/qr.js',
  '/js/scanner.js',
  '/js/ui.js',
  '/js/wallet.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    // Optional QR-reading library for browsers without BarcodeDetector (see README). Absent is fine.
    await cache.add(new Request('/js/vendor/jsQR.js', { cache: 'reload' })).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('opay-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Page loads: always the cached app (hash routes like /#/pay all live in index.html).
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('/index.html').then((hit) => hit || fetch(req)));
    return;
  }

  // Everything else: cache first, and remember anything new we had to fetch.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    })),
  );
});

/* ---------- Background Sync: deliver the outbox when the connection returns ---------- */

function readOutbox() {
  return new Promise((resolve) => {
    const open = indexedDB.open('offlinepay'); // no version: use whatever exists
    open.onupgradeneeded = () => open.transaction.abort(); // database doesn't exist yet: don't create it
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('outbox')) { db.close(); resolve([]); return; }
      const req = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); resolve([]); };
    };
  });
}

async function flushOutbox() {
  const items = await readOutbox();
  for (let i = 0; i < items.length; i += 25) {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orders: items.slice(i, i + 25).map((x) => x.order) }),
    });
    if (!res.ok) throw new Error('Server not ready'); // rejecting makes the browser retry later
  }
  // The app clears its outbox and updates balances next time it is opened (delivery is idempotent).
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'opay-flush') event.waitUntil(flushOutbox());
});
