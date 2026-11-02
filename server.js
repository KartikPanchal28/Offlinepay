#!/usr/bin/env node
// server.js — serves the app (public/) and settles payments (/api/*).
//
//   node server.js                      -> http://localhost:3000
//   PORT=8080 node server.js            -> custom port
//   DEMO_TOPUP=0 node server.js         -> disable the "Add money" demo faucet
//   TLS_KEY=key.pem TLS_CERT=cert.pem   -> serve over HTTPS
//   DATA_FILE=/path/offlinepay.db       -> where the SQLite database is stored
//
// Uses SQLite (via better-sqlite3) as the DBMS backend for persistence.
// Every payment is a signed order. The server verifies the signature, then settles the order
// exactly once (orders are idempotent by id), so it does not matter which phone delivers it,
// or how many times.

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { CONFIG, LIMITS } from './public/js/config.js';
import { checkOrderShape, verifyOrder, verifyAuth } from './public/js/protocol.js';
import { cleanName } from './public/js/format.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': CSP,
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- SQLite migration: import data from old db.json ---------- */

function migrateFromJson(sqlDb, jsonPath) {
  if (!fs.existsSync(jsonPath)) return false;
  try {
    const countRow = sqlDb.prepare('SELECT COUNT(*) AS c FROM users').get();
    if (countRow.c > 0) return false; // DB already has data, skip migration

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    const insertUser = sqlDb.prepare(
      'INSERT OR IGNORE INTO users (id, name, pub, balance, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertEntry = sqlDb.prepare(
      `INSERT OR IGNORE INTO ledger (entry_id, kind, from_id, to_id, amount, note, ts, status, reason, settled_at, order_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    sqlDb.transaction(() => {
      for (const [uid, u] of Object.entries(data.users || {})) {
        insertUser.run(uid, u.name || '', u.pub || '', u.balance || 0, u.createdAt || 0);
      }
      for (const e of data.ledger || []) {
        insertEntry.run(
          e.id, e.kind || '', e.from || null, e.to || null, e.amount || 0,
          e.note || '', e.ts || 0, e.status || '', e.reason || '', e.at || 0,
          e.order ? JSON.stringify(e.order) : null
        );
      }
    })();

    fs.renameSync(jsonPath, jsonPath + '.migrated');
    console.log(`  ✓ Migrated data from ${jsonPath} into SQLite`);
    return true;
  } catch (err) {
    console.warn('  ⚠ Migration from JSON failed:', err.message);
    return false;
  }
}

/* ====================================================================== createApp */

export function createApp({ dataFile = null, publicDir = PUBLIC_DIR, topupEnabled = true, tls = null, now = () => Date.now() } = {}) {
  /* ---------- SQLite database setup ---------- */
  const dbPath = dataFile || path.join(ROOT, 'data', 'offlinepay.db');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const sqlDb = new Database(dbPath);
  sqlDb.pragma('journal_mode = WAL');
  sqlDb.pragma('foreign_keys = ON');

  // Create tables
  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      pub        TEXT NOT NULL DEFAULT '',
      balance    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id   TEXT UNIQUE NOT NULL,
      kind       TEXT NOT NULL DEFAULT '',
      from_id    TEXT,
      to_id      TEXT,
      amount     INTEGER NOT NULL DEFAULT 0,
      note       TEXT NOT NULL DEFAULT '',
      ts         INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT '',
      reason     TEXT NOT NULL DEFAULT '',
      settled_at INTEGER NOT NULL DEFAULT 0,
      order_json TEXT
    )
  `);
  sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_ledger_from ON ledger(from_id)');
  sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_ledger_to   ON ledger(to_id)');

  // Migrate old JSON data if present
  const oldJson = path.join(path.dirname(dbPath), 'db.json');
  if (path.resolve(oldJson) !== path.resolve(dbPath)) {
    migrateFromJson(sqlDb, oldJson);
  }

  /* ---------- prepared statements ---------- */
  const stmt = {
    getUser:        sqlDb.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser:     sqlDb.prepare('INSERT OR IGNORE INTO users (id, name, pub, balance, created_at) VALUES (?, ?, ?, ?, ?)'),
    setUserPub:     sqlDb.prepare('UPDATE users SET pub = ? WHERE id = ? AND pub = ?'),
    setUserName:    sqlDb.prepare('UPDATE users SET name = ? WHERE id = ?'),
    addBalance:     sqlDb.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
    subBalance:     sqlDb.prepare('UPDATE users SET balance = balance - ? WHERE id = ?'),
    getEntry:       sqlDb.prepare('SELECT * FROM ledger WHERE entry_id = ?'),
    insertEntry:    sqlDb.prepare(
      `INSERT INTO ledger (entry_id, kind, from_id, to_id, amount, note, ts, status, reason, settled_at, order_json)
       VALUES (@entry_id, @kind, @from_id, @to_id, @amount, @note, @ts, @status, @reason, @settled_at, @order_json)`
    ),
    entriesForUser: sqlDb.prepare(
      'SELECT * FROM ledger WHERE (from_id = ? OR to_id = ?) AND seq > ? ORDER BY seq ASC LIMIT ?'
    ),
    maxSeq:         sqlDb.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ledger'),
  };

  /* ---------- user helpers ---------- */

  function ensureUser(id) {
    let user = stmt.getUser.get(id);
    if (!user) {
      stmt.insertUser.run(id, '', '', 0, now());
      user = stmt.getUser.get(id);
    }
    return user;
  }

  /* ---------- ledger helpers ---------- */

  function duplicateOf(id) {
    const e = stmt.getEntry.get(id);
    if (!e) return null;
    return { status: e.status, reason: e.reason, duplicate: true };
  }

  const rejected = (reason) => ({ status: 'rejected', reason });

  function addEntry(partial) {
    const entry = {
      entry_id:   partial.id,
      kind:       partial.kind || '',
      from_id:    partial.from || null,
      to_id:      partial.to || null,
      amount:     partial.amount || 0,
      note:       partial.note || '',
      ts:         partial.ts || 0,
      status:     partial.status || '',
      reason:     partial.reason || '',
      settled_at: now(),
      order_json: partial.order ? JSON.stringify(partial.order) : null,
    };
    const info = stmt.insertEntry.run(entry);
    return { seq: Number(info.lastInsertRowid), at: entry.settled_at, ...partial };
  }

  /* ---------- settlement ---------- */

  async function settleOrder(order) {
    const shapeErr = checkOrderShape(order, LIMITS);
    if (shapeErr) return rejected(shapeErr);
    const dup = duplicateOf(order.i);
    if (dup) return dup;

    const err = await verifyOrder(order, LIMITS); // signature + key/id binding
    if (err) return rejected(err);
    if (order.c !== CONFIG.currency) return rejected(`This server only handles ${CONFIG.currency}`);
    const nowS = Math.floor(now() / 1000);
    if (order.s > nowS + CONFIG.futureSkewSec) return rejected('Order is dated in the future');
    if (nowS - order.s > CONFIG.orderMaxAgeSec) return rejected('Order has expired');

    // Check again for race
    const again = duplicateOf(order.i);
    if (again) return again;

    const payer = ensureUser(order.f);
    const payee = ensureUser(order.t);

    // Update payer pub/name if not set
    if (!payer.pub && order.k)  stmt.setUserPub.run(order.k, order.f, '');
    if (!payer.name && order.fn) stmt.setUserName.run(order.fn, order.f);

    let status = 'settled', reason = '';
    if (payer.balance < order.a) {
      status = 'failed'; reason = 'Insufficient funds';
    } else {
      stmt.subBalance.run(order.a, order.f);
      stmt.addBalance.run(order.a, order.t);
    }

    addEntry({
      id: order.i, kind: 'pay', from: order.f, to: order.t,
      amount: order.a, note: order.n, ts: order.s, status, reason, order,
    });
    return { status, reason };
  }

  /* ---------- query helpers ---------- */

  function publicEntry(e) {
    const fromUser = e.from_id ? stmt.getUser.get(e.from_id) : null;
    const toUser = e.to_id ? stmt.getUser.get(e.to_id) : null;
    const order = e.order_json ? JSON.parse(e.order_json) : null;
    return {
      seq: e.seq, id: e.entry_id, kind: e.kind,
      from: e.from_id, to: e.to_id, amount: e.amount, note: e.note,
      ts: e.ts, status: e.status, reason: e.reason || '', at: e.settled_at,
      fromName: order?.fn || fromUser?.name || '',
      toName: toUser?.name || '',
    };
  }

  function listFor(id, since, limit) {
    const entries = stmt.entriesForUser.all(id, id, since, limit + 1);
    const more = entries.length > limit;
    const out = entries.slice(0, limit).map(publicEntry);
    const maxSeq = stmt.maxSeq.get().max_seq;
    return {
      entries: out,
      next: more ? out[out.length - 1].seq : maxSeq,
      more,
    };
  }

  /** Verify a signed request and (re)register the account. */
  async function authenticate(auth, op, extra) {
    const err = await verifyAuth(auth, op, extra, { nowSec: Math.floor(now() / 1000), skewSec: CONFIG.futureSkewSec });
    if (err) throw new HttpError(401, err);
    const user = ensureUser(auth.id);
    if (!user.pub && auth.pub) stmt.setUserPub.run(auth.pub, auth.id, '');
    const name = cleanName(auth.name);
    if (name && name !== user.name) stmt.setUserName.run(name, auth.id);
    return stmt.getUser.get(auth.id); // return fresh copy
  }

  /* ---------- API handlers ---------- */

  async function handleOrders(body) {
    const orders = body?.orders;
    if (!Array.isArray(orders) || orders.length === 0 || orders.length > 50) throw new HttpError(400, 'Send 1 to 50 orders');
    const results = [];
    for (const o of orders) results.push(await settleOrder(o));
    return { results };
  }

  async function handleSync(body) {
    const since = Number.isSafeInteger(body?.since) && body.since >= 0 ? body.since : 0;
    const user = await authenticate(body?.auth, 'sync', since);
    const { entries, next, more } = listFor(body.auth.id, since, 200);
    return { balance: user.balance, entries, next, more, time: now() };
  }

  async function handleTopup(body) {
    if (!topupEnabled) throw new HttpError(403, 'Adding demo money is turned off on this server');
    const { auth, amount, nonce } = body || {};
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > CONFIG.maxTopupMinor) throw new HttpError(400, 'Bad amount');
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(400, 'Bad request id');
    const user = await authenticate(auth, 'topup', [amount, nonce]);
    const id = 'topup:' + nonce;
    if (stmt.getEntry.get(id)) throw new HttpError(409, 'This request was already processed');
    stmt.addBalance.run(amount, auth.id);
    addEntry({ id, kind: 'topup', from: null, to: auth.id, amount, note: 'Added money', ts: Math.floor(now() / 1000), status: 'settled' });
    const updatedUser = stmt.getUser.get(auth.id);
    return { ok: true, balance: updatedUser.balance };
  }

  /* ---------- HTTP plumbing ---------- */

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
      ...SECURITY_HEADERS,
    });
    res.end(body);
  }

  async function readJson(req, limit = 256 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Request too large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  async function handleDbmsOverview() {
    const usersCount = sqlDb.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const ledgerCount = sqlDb.prepare('SELECT COUNT(*) AS c FROM ledger').get().c;
    const totalBalance = sqlDb.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM users').get().s;
    const journalMode = sqlDb.pragma('journal_mode', { simple: true });
    const integrity = sqlDb.pragma('integrity_check', { simple: true });
    const schema = {
      users: sqlDb.prepare('PRAGMA table_info(users)').all(),
      ledger: sqlDb.prepare('PRAGMA table_info(ledger)').all(),
      indexes: sqlDb.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index'").all(),
    };
    return {
      engine: 'SQLite 3 (better-sqlite3)',
      dbPath,
      journalMode,
      integrity,
      stats: { usersCount, ledgerCount, totalBalance },
      schema,
    };
  }

  async function handleDbmsQuery(body) {
    const { sql } = body || {};
    if (typeof sql !== 'string' || !sql.trim()) throw new HttpError(400, 'SQL query required');
    const trimmed = sql.trim();
    if (!/^(SELECT|PRAGMA|EXPLAIN)\b/i.test(trimmed)) {
      throw new HttpError(403, 'Only SELECT, PRAGMA, and EXPLAIN queries are allowed');
    }
    const rows = sqlDb.prepare(trimmed).all();
    return { ok: true, rows, count: rows.length };
  }

  const ROUTES = {
    '/api/orders': handleOrders,
    '/api/sync': handleSync,
    '/api/topup': handleTopup,
    '/api/dbms/query': handleDbmsQuery,
  };

  async function handleApi(req, res, pathname) {
    try {
      if (pathname === '/api/health') {
        return send(res, 200, { ok: true, time: now(), currency: CONFIG.currency, topup: topupEnabled });
      }
      if (pathname === '/api/dbms/overview') {
        return send(res, 200, await handleDbmsOverview());
      }
      const route = ROUTES[pathname];
      if (!route) throw new HttpError(404, 'Not found');
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
      return send(res, 200, await route(await readJson(req)));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'Server error' });
    }
  }

  // Build fingerprint for service worker cache versioning
  let build = { at: 0, id: '' };
  function buildId() {
    if (build.id && now() - build.at < 2000) return build.id;
    const hash = crypto.createHash('sha1');
    const swFile = path.join(publicDir, 'sw.js');
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (full !== swFile) hash.update(path.relative(publicDir, full)).update(fs.readFileSync(full));
      }
    };
    walk(publicDir);
    build = { at: now(), id: hash.digest('hex').slice(0, 10) };
    return build.id;
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, { error: 'Bad request' }); }
    if (rel.includes('\0')) return send(res, 400, { error: 'Bad request' });
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(publicDir, path.normalize(rel));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Forbidden' });
    let data;
    try { data = await fs.promises.readFile(file); } catch { return send(res, 404, { error: 'Not found' }); }
    if (file === path.join(publicDir, 'sw.js')) data = Buffer.from(data.toString('utf8').replace("'__BUILD__'", `'${buildId()}'`));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const handler = (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    return pathname.startsWith('/api/') ? handleApi(req, res, pathname) : serveStatic(req, res, pathname);
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

  // Compatible state getter for tests
  const state = {
    get users() {
      const all = sqlDb.prepare('SELECT * FROM users').all();
      const obj = {};
      for (const u of all) obj[u.id] = { name: u.name, pub: u.pub, balance: u.balance, createdAt: u.created_at };
      return obj;
    },
    get ledger() {
      return sqlDb.prepare('SELECT * FROM ledger ORDER BY seq').all().map(e => {
        const order = e.order_json ? JSON.parse(e.order_json) : undefined;
        return { seq: e.seq, id: e.entry_id, kind: e.kind, from: e.from_id, to: e.to_id, amount: e.amount, note: e.note, ts: e.ts, status: e.status, reason: e.reason, at: e.settled_at, order };
      });
    },
  };

  const save = () => {}; // SQLite auto-persists via WAL, no manual save needed

  return {
    server, state, save, sqlDb,
    listen: (port = 3000, host = '0.0.0.0') =>
      new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        sqlDb.close();
        resolve();
      });
    }),
  };
}

/* ---------- start when run directly ---------- */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if ((process.env.DB_ENGINE || 'mysql').toLowerCase() === 'mysql') {
    const { startMySqlServer } = await import('./mysql-server.js');
    await startMySqlServer();
  } else {
  const port = Number(process.env.PORT) || 3000;
  const dataFile = process.env.DATA_FILE || path.join(ROOT, 'data', 'offlinepay.db');
  const useTls = !!(process.env.TLS_KEY && process.env.TLS_CERT);
  const tls = useTls ? { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) } : null;
  const app = createApp({ dataFile, topupEnabled: process.env.DEMO_TOPUP !== '0', tls });
  await app.listen(port, process.env.HOST || '0.0.0.0');

  const scheme = useTls ? 'https' : 'http';
  console.log(`\n🔷 ${CONFIG.appName} is running (${CONFIG.currency}, demo money ${process.env.DEMO_TOPUP === '0' ? 'OFF' : 'ON'})`);
  console.log(`  📦 Database: SQLite (better-sqlite3)`);
  console.log(`  🏠 This computer:  ${scheme}://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  📱 Same network:   ${scheme}://${n.address}:${port}`);
    }
  }
  console.log(`  💾 Data file:      ${dataFile}\n`);

  const stop = () => { app.sqlDb.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  }
}
