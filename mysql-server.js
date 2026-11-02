// MySQL-backed production server. The SQLite createApp in server.js remains available
// for the existing automated tests and can still be selected with DB_ENGINE=sqlite.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import SQLite from 'better-sqlite3';
import { CONFIG, LIMITS } from './public/js/config.js';
import { checkOrderShape, verifyOrder, verifyAuth } from './public/js/protocol.js';
import { cleanName } from './public/js/format.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
function loadLocalEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[m[1]] = value;
  }
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; '),
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function createMySqlApp({ publicDir = PUBLIC_DIR, topupEnabled = true, tls = null, now = () => Date.now() } = {}) {
  loadLocalEnv();
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  const port = Number(process.env.MYSQL_PORT) || 3306;
  const user = process.env.MYSQL_USER || 'root';
  const password = process.env.MYSQL_PASSWORD || '';
  const database = process.env.MYSQL_DATABASE || 'offlinepay';
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('MYSQL_DATABASE may contain only letters, numbers, and underscores');

  // Create the configured database when the MySQL account has CREATE DATABASE permission.
  const bootstrap = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await bootstrap.end();

  const pool = mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: false });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      name VARCHAR(80) NOT NULL DEFAULT '', pub VARCHAR(100) NOT NULL DEFAULT '',
      balance BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger (
      seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      entry_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
      kind VARCHAR(20) NOT NULL DEFAULT '', from_id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NULL,
      to_id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NULL,
      amount BIGINT NOT NULL DEFAULT 0, note VARCHAR(500) NOT NULL DEFAULT '', ts BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT '', reason VARCHAR(255) NOT NULL DEFAULT '',
      settled_at BIGINT NOT NULL DEFAULT 0, order_json LONGTEXT NULL,
      INDEX idx_ledger_from (from_id), INDEX idx_ledger_to (to_id),
      CONSTRAINT fk_ledger_from FOREIGN KEY (from_id) REFERENCES users(id),
      CONSTRAINT fk_ledger_to FOREIGN KEY (to_id) REFERENCES users(id)
    ) ENGINE=InnoDB
  `);

  // One-time, non-destructive import of the existing SQLite database, when present.
  // Never overwrite rows already created in MySQL.
  if (process.env.MYSQL_IMPORT_SQLITE !== '0') {
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM users) AS users_count, (SELECT COUNT(*) FROM ledger) AS ledger_count');
    const legacyPath = path.join(ROOT, 'data', 'offlinepay.db');
    if (counts.users_count === 0 && counts.ledger_count === 0 && fs.existsSync(legacyPath)) {
      const oldDb = new SQLite(legacyPath, { readonly: true, fileMustExist: true });
      try {
        const oldUsers = oldDb.prepare('SELECT id, name, pub, balance, created_at FROM users').all();
        const oldEntries = oldDb.prepare('SELECT seq, entry_id, kind, from_id, to_id, amount, note, ts, status, reason, settled_at, order_json FROM ledger ORDER BY seq').all();
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          for (const u of oldUsers) await conn.execute('INSERT IGNORE INTO users (id, name, pub, balance, created_at) VALUES (?, ?, ?, ?, ?)', [u.id, u.name, u.pub, u.balance, u.created_at]);
          for (const e of oldEntries) await conn.execute('INSERT IGNORE INTO ledger (seq, entry_id, kind, from_id, to_id, amount, note, ts, status, reason, settled_at, order_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [e.seq, e.entry_id, e.kind, e.from_id, e.to_id, e.amount, e.note, e.ts, e.status, e.reason, e.settled_at, e.order_json]);
          await conn.commit();
          if (oldUsers.length || oldEntries.length) console.log(`Imported ${oldUsers.length} users and ${oldEntries.length} ledger entries from SQLite.`);
        } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
      } finally { oldDb.close(); }
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger (
      seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      entry_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
      kind VARCHAR(20) NOT NULL DEFAULT '', from_id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NULL,
      to_id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NULL,
      amount BIGINT NOT NULL DEFAULT 0, note VARCHAR(500) NOT NULL DEFAULT '', ts BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT '', reason VARCHAR(255) NOT NULL DEFAULT '',
      settled_at BIGINT NOT NULL DEFAULT 0, order_json LONGTEXT NULL,
      INDEX idx_ledger_from (from_id), INDEX idx_ledger_to (to_id),
      CONSTRAINT fk_ledger_from FOREIGN KEY (from_id) REFERENCES users(id),
      CONSTRAINT fk_ledger_to FOREIGN KEY (to_id) REFERENCES users(id)
    ) ENGINE=InnoDB
  `);

  const ensureUser = async (conn, id) => {
    await conn.execute('INSERT IGNORE INTO users (id, created_at) VALUES (?, ?)', [id, now()]);
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0];
  };
  const duplicateOf = async (conn, id) => {
    const [rows] = await conn.execute('SELECT status, reason FROM ledger WHERE entry_id = ?', [id]);
    return rows[0] ? { status: rows[0].status, reason: rows[0].reason, duplicate: true } : null;
  };
  const rejected = (reason) => ({ status: 'rejected', reason });

  async function authenticate(conn, auth, op, extra) {
    const err = await verifyAuth(auth, op, extra, { nowSec: Math.floor(now() / 1000), skewSec: CONFIG.futureSkewSec });
    if (err) throw new HttpError(401, err);
    const existing = await ensureUser(conn, auth.id);
    if (!existing.pub && auth.pub) await conn.execute('UPDATE users SET pub = ? WHERE id = ? AND pub = \'\'', [auth.pub, auth.id]);
    const name = cleanName(auth.name);
    if (name && name !== existing.name) await conn.execute('UPDATE users SET name = ? WHERE id = ?', [name, auth.id]);
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [auth.id]);
    return rows[0];
  }

  async function settleOrder(order) {
    const shapeErr = checkOrderShape(order, LIMITS);
    if (shapeErr) return rejected(shapeErr);
    const err = await verifyOrder(order, LIMITS);
    if (err) return rejected(err);
    if (order.c !== CONFIG.currency) return rejected(`This server only handles ${CONFIG.currency}`);
    const nowS = Math.floor(now() / 1000);
    if (order.s > nowS + CONFIG.futureSkewSec) return rejected('Order is dated in the future');
    if (nowS - order.s > CONFIG.orderMaxAgeSec) return rejected('Order has expired');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const dup = await duplicateOf(conn, order.i);
      if (dup) { await conn.commit(); return dup; }
      await ensureUser(conn, order.f);
      await ensureUser(conn, order.t);
      const [payers] = await conn.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [order.f]);
      const payer = payers[0];
      if (!payer.pub && order.k) await conn.execute('UPDATE users SET pub = ? WHERE id = ?', [order.k, order.f]);
      if (!payer.name && order.fn) await conn.execute('UPDATE users SET name = ? WHERE id = ?', [order.fn, order.f]);
      let status = 'settled', reason = '';
      if (payer.balance < order.a) { status = 'failed'; reason = 'Insufficient funds'; }
      else {
        await conn.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [order.a, order.f]);
        await conn.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [order.a, order.t]);
      }
      await conn.execute(
        `INSERT INTO ledger (entry_id, kind, from_id, to_id, amount, note, ts, status, reason, settled_at, order_json)
         VALUES (?, 'pay', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [order.i, order.f, order.t, order.a, order.n || '', order.s, status, reason, now(), JSON.stringify(order)],
      );
      await conn.commit();
      return { status, reason };
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return (await duplicateOf(pool, order.i)) || rejected('Duplicate transaction');
      throw e;
    } finally { conn.release(); }
  }

  async function listFor(id, since, limit) {
    const [rows] = await pool.execute(
      `SELECT l.*, f.name AS from_name, t.name AS to_name
       FROM ledger l LEFT JOIN users f ON f.id = l.from_id LEFT JOIN users t ON t.id = l.to_id
       WHERE (l.from_id = ? OR l.to_id = ?) AND l.seq > ? ORDER BY l.seq ASC LIMIT ?`,
      [id, id, since, limit + 1],
    );
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map((e) => {
      let order = null;
      try { order = e.order_json ? JSON.parse(e.order_json) : null; } catch { /* legacy row */ }
      return { seq: e.seq, id: e.entry_id, kind: e.kind, from: e.from_id, to: e.to_id, amount: e.amount, note: e.note, ts: e.ts, status: e.status, reason: e.reason || '', at: e.settled_at, fromName: order?.fn || e.from_name || '', toName: e.to_name || '' };
    });
    const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ledger');
    return { entries, next: more ? entries.at(-1).seq : maxRow.max_seq, more };
  }

  async function handleApi(req, res, pathname) {
    try {
      if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, time: now(), currency: CONFIG.currency, topup: topupEnabled, engine: 'MySQL' });
      if (pathname === '/api/dbms/overview' && req.method === 'GET') {
        const [[u]] = await pool.query('SELECT COUNT(*) AS c FROM users');
        const [[l]] = await pool.query('SELECT COUNT(*) AS c FROM ledger');
        const [[b]] = await pool.query('SELECT COALESCE(SUM(balance), 0) AS s FROM users');
        const [users] = await pool.query('SHOW COLUMNS FROM users');
        const [ledger] = await pool.query('SHOW COLUMNS FROM ledger');
        const [indexes] = await pool.query('SHOW INDEX FROM ledger');
        return send(res, 200, { engine: 'MySQL', database, stats: { usersCount: u.c, ledgerCount: l.c, totalBalance: Number(b.s) }, schema: { users, ledger, indexes } });
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
      const body = await readJson(req);
      if (pathname === '/api/sync') {
        const since = Number.isSafeInteger(body?.since) && body.since >= 0 ? body.since : 0;
        const conn = await pool.getConnection();
        let account;
        try { await conn.beginTransaction(); account = await authenticate(conn, body?.auth, 'sync', since); await conn.commit(); }
        catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
        const result = await listFor(body.auth.id, since, 200);
        return send(res, 200, { balance: account.balance, ...result, time: now() });
      }
      if (pathname === '/api/orders') {
        const orders = body?.orders;
        if (!Array.isArray(orders) || !orders.length || orders.length > 50) throw new HttpError(400, 'Send 1 to 50 orders');
        const results = [];
        for (const order of orders) results.push(await settleOrder(order));
        return send(res, 200, { results });
      }
      if (pathname === '/api/topup') {
        if (!topupEnabled) throw new HttpError(403, 'Adding demo money is turned off on this server');
        const { auth, amount, nonce } = body || {};
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > CONFIG.maxTopupMinor) throw new HttpError(400, 'Bad amount');
        if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(400, 'Bad request id');
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await authenticate(conn, auth, 'topup', [amount, nonce]);
          const id = `topup:${nonce}`;
          if (await duplicateOf(conn, id)) throw new HttpError(409, 'This request was already processed');
          await conn.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, auth.id]);
          await conn.execute(`INSERT INTO ledger (entry_id, kind, to_id, amount, note, ts, status, settled_at) VALUES (?, 'topup', ?, ?, 'Added money', ?, 'settled', ?)`, [id, auth.id, amount, Math.floor(now() / 1000), now()]);
          const [[updated]] = await conn.execute('SELECT balance FROM users WHERE id = ?', [auth.id]);
          await conn.commit();
          return send(res, 200, { ok: true, balance: updated.balance });
        } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
      }
      if (pathname === '/api/dbms/query') {
        const query = typeof body?.sql === 'string' ? body.sql.trim() : '';
        if (!query) throw new HttpError(400, 'SQL query required');
        if (!/^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i.test(query) || query.includes(';')) throw new HttpError(403, 'Only one read-only SELECT, SHOW, DESCRIBE, or EXPLAIN query is allowed');
        const [rows] = await pool.query(query);
        if (!Array.isArray(rows)) throw new HttpError(400, 'Query did not return rows');
        return send(res, 200, { ok: true, rows, count: rows.length });
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('MySQL API error:', e);
      return send(res, 500, { error: 'Server error' });
    }
  }

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...SECURITY_HEADERS });
    res.end(body);
  }
  async function readJson(req, limit = 256 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Request too large'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  }
  let build = { at: 0, id: '' };
  function buildId() {
    if (build.id && now() - build.at < 2000) return build.id;
    const hash = crypto.createHash('sha1'); const swFile = path.join(publicDir, 'sw.js');
    const walk = (dir) => { for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const full = path.join(dir, ent.name); if (ent.isDirectory()) walk(full); else if (full !== swFile) hash.update(path.relative(publicDir, full)).update(fs.readFileSync(full)); } };
    walk(publicDir); build = { at: now(), id: hash.digest('hex').slice(0, 10) }; return build.id;
  }

  const handler = (req, res) => { const { pathname } = new URL(req.url, 'http://localhost'); return pathname.startsWith('/api/') ? handleApi(req, res, pathname) : serveStatic(req, res, pathname); };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  return {
    server, pool, database,
    listen: (listenPort = Number(process.env.PORT) || 3000, listenHost = process.env.HOST || '0.0.0.0') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, listenHost, () => resolve(server.address().port)); }),
    close: async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await pool.end(); },
  };
}

export async function startMySqlServer() {
  const tls = process.env.TLS_KEY && process.env.TLS_CERT ? { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) } : null;
  const app = await createMySqlApp({ topupEnabled: process.env.DEMO_TOPUP !== '0', tls });
  const port = await app.listen();
  console.log(`\n${CONFIG.appName} is running (${CONFIG.currency}, MySQL database ${app.database})`);
  console.log(`  This computer: http${tls ? 's' : ''}://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) for (const nic of list || []) if (nic.family === 'IPv4' && !nic.internal) console.log(`  Same network:  http${tls ? 's' : ''}://${nic.address}:${port}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
