import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createWalletClient } from '../public/js/wallet.js';
import { openMemoryDatabase } from '../public/js/db.js';
import * as P from '../public/js/protocol.js';
import { LIMITS, CONFIG } from '../public/js/config.js';
import { generateWalletKey, unlockPrivateKey } from '../public/js/crypto.js';

const PIN = '123456';
const M = 10 ** CONFIG.decimals; // one major unit in minor units

/** A phone: its own storage, and a switch to simulate having no connection. */
function phone(apiBase) {
  const net = { offline: false };
  const fetchImpl = async (url, init) => {
    if (net.offline) throw new TypeError('fetch failed'); // what browsers do with no connection
    return fetch(url, init);
  };
  const wallet = createWalletClient({ db: openMemoryDatabase(), apiBase, fetchImpl });
  return { wallet, net };
}

async function newUser(apiBase, name) {
  const p = phone(apiBase);
  await p.wallet.init();
  await p.wallet.create(name, PIN);
  await p.wallet.unlock(PIN);
  return p;
}

const post = (base, route, body) =>
  fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

test('payments: online, offline, duplicates, tampering, failures, persistence', async (t) => {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opay-')), 'db.json');
  let app = createApp({ dataFile });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(() => app.close());

  const alice = await newUser(base, 'Alice');
  const bob = await newUser(base, 'Bob');
  const carol = await newUser(base, 'Carol');
  const A = alice.wallet, B = bob.wallet, C = carol.wallet;

  await t.test('wallets are created locally and register on first sync', async () => {
    assert.ok(P.isValidId(A.profile.id));
    assert.notEqual(A.profile.id, B.profile.id);
    assert.deepEqual(await A.sync(), { ok: true, pulled: true });
    assert.equal((await A.summary()).available, 0);
  });

  await t.test('add demo money', async () => {
    await A.topUp(100 * M);
    assert.equal((await A.summary()).available, 100 * M);
    await assert.rejects(A.topUp(CONFIG.maxTopupMinor + 1), (e) => e.code === 'BAD_AMOUNT');
  });

  await t.test('online payment settles immediately for both sides', async () => {
    const txn = await A.pay({ to: B.profile.id, toName: 'Bob', amount: 25 * M, note: 'lunch' }, PIN);
    assert.equal(txn.status, 'pending'); // signed + queued first
    assert.deepEqual(await A.sync(), { ok: true, pulled: true });
    assert.equal((await A.getTxn(txn.id)).status, 'settled');
    assert.equal((await A.summary()).available, 75 * M);
    await B.sync();
    const s = await B.summary();
    assert.equal(s.available, 25 * M);
    const inbound = (await B.listTxns()).find((x) => x.id === txn.id);
    assert.equal(inbound.dir, 'in');
    assert.equal(inbound.status, 'settled');
    assert.equal(inbound.peerName, 'Alice');
  });

  await t.test('client-side guards: wrong PIN, no funds, self, bad id', async () => {
    await assert.rejects(A.pay({ to: B.profile.id, amount: M }, '000000'), (e) => e.code === 'BAD_PIN');
    await assert.rejects(A.pay({ to: B.profile.id, amount: 90 * M }, PIN), (e) => e.code === 'NO_FUNDS');
    await assert.rejects(A.pay({ to: A.profile.id, amount: M }, PIN), (e) => e.code === 'SELF');
    await assert.rejects(A.pay({ to: 'AAAAAAAAAAAA', amount: M }, PIN), (e) => e.code === 'BAD_ID');
    await assert.rejects(A.pay({ to: B.profile.id, amount: 0 }, PIN), (e) => e.code === 'BAD_AMOUNT');
    await assert.rejects(A.pay({ to: B.profile.id, amount: CONFIG.maxPaymentMinor + 1 }, PIN), (e) => e.code === 'LIMIT');
  });

  let offlineOrder;
  await t.test('OFFLINE: payer signs, receiver verifies the code with no network', async () => {
    alice.net.offline = true;
    bob.net.offline = true;

    const txn = await A.pay({ to: B.profile.id, toName: 'Bob', amount: 10 * M, note: 'taxi' }, PIN);
    offlineOrder = txn.order;
    assert.equal(txn.status, 'pending');
    assert.deepEqual(await A.sync({ timeout: 500 }), { ok: false, offline: true });
    let s = await A.summary();
    assert.equal(s.confirmed, 75 * M); // server balance unchanged
    assert.equal(s.available, 65 * M); // but pending money is already reserved
    assert.equal(s.pendingOut, 10 * M);
    assert.equal(A.online, false);

    // the code that would be shown as a QR
    const code = P.encodeProof(txn.order);
    const parsed = P.parseCode(code);
    const got = await B.acceptProof(parsed.order);
    assert.equal(got.duplicate, false);
    assert.equal(got.txn.status, 'pending');
    s = await B.summary();
    assert.equal(s.available, 25 * M); // incoming money is not spendable yet
    assert.equal(s.pendingIn, 10 * M);
    assert.equal((await B.acceptProof(parsed.order)).duplicate, true);

    // and the receiver cannot spend what has not settled
    await assert.rejects(B.pay({ to: C.profile.id, amount: 30 * M }, PIN), (e) => e.code === 'NO_FUNDS');
  });

  await t.test('back online: either phone can deliver; settles exactly once', async () => {
    bob.net.offline = false;
    assert.deepEqual(await B.sync(), { ok: true, pulled: true });
    assert.equal((await B.summary()).available, 35 * M);
    assert.equal((await B.summary()).pending, 0);

    alice.net.offline = false;
    assert.deepEqual(await A.sync(), { ok: true, pulled: true }); // re-delivers the same order: a duplicate
    const s = await A.summary();
    assert.equal(s.available, 65 * M);
    assert.equal(s.pending, 0);
    assert.equal((await A.getTxn(offlineOrder.i)).status, 'settled');
    assert.equal(app.state.ledger.filter((e) => e.id === offlineOrder.i).length, 1);
  });

  await t.test('tampered, misaddressed, expired and forged proofs are refused', async () => {
    alice.net.offline = bob.net.offline = true;
    const toBob = await A.pay({ to: B.profile.id, amount: M, note: 'x' }, PIN);
    await assert.rejects(B.acceptProof({ ...toBob.order, a: 99 * M }), (e) => e.code === 'BAD_PROOF');
    const toCarol = await A.pay({ to: C.profile.id, amount: M, note: 'y' }, PIN);
    await assert.rejects(B.acceptProof(toCarol.order), (e) => e.code === 'NOT_FOR_ME');

    // an order that is validly signed but too old
    const { pub, enc } = await generateWalletKey(PIN);
    const dave = { pub, id: await P.idFromPub(P.unb64u(pub)), key: await unlockPrivateKey(PIN, enc) };
    const old = { v: 1, i: P.randomId(), f: dave.id, t: B.profile.id, a: M, c: CONFIG.currency, s: Math.floor(Date.now() / 1000) - 2 * CONFIG.proofMaxAgeSec, n: '', fn: 'Dave', k: dave.pub };
    old.g = P.b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dave.key, P.orderMessage(old)));
    assert.equal(await P.verifyOrder(old, LIMITS), null);
    await assert.rejects(B.acceptProof(old), (e) => e.code === 'EXPIRED');

    // wrong currency
    const eur = { ...old, i: P.randomId(), s: Math.floor(Date.now() / 1000), c: CONFIG.currency === 'EUR' ? 'USD' : 'EUR' };
    eur.g = P.b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dave.key, P.orderMessage(eur)));
    await assert.rejects(B.acceptProof(eur), (e) => e.code === 'CURRENCY');

    alice.net.offline = bob.net.offline = false;
    await A.sync(); await B.sync(); await C.sync();
  });

  await t.test('an unfunded sender (validly signed) is recorded as FAILED for both parties', async () => {
    const { pub, enc } = await generateWalletKey(PIN);
    const eve = { pub, id: await P.idFromPub(P.unb64u(pub)), key: await unlockPrivateKey(PIN, enc) };
    const before = (await B.summary()).confirmed;
    const order = await P.signOrder(eve.key, { from: eve.id, fromName: 'Eve', pub: eve.pub, to: B.profile.id, amount: 5 * M, currency: CONFIG.currency, note: 'IOU' });
    bob.net.offline = true;
    await B.acceptProof(order); // looked fine offline: the signature is valid...
    bob.net.offline = false;
    await B.sync(); // ...but the server knows Eve has no money
    const txn = await B.getTxn(order.i);
    assert.equal(txn.status, 'failed');
    assert.equal(txn.reason, 'Insufficient funds');
    assert.equal((await B.summary()).confirmed, before);
  });

  await t.test('server API: rejects forged orders, replays, bad signatures, oversized bodies', async () => {
    const order = (await A.pay({ to: B.profile.id, amount: M, note: 'z' }, PIN)).order;
    const bad = await post(base, '/api/orders', { orders: [{ ...order, a: order.a + 1 }, order] });
    assert.equal(bad.body.results[0].status, 'rejected');
    assert.equal(bad.body.results[1].status, 'settled');
    const again = await post(base, '/api/orders', { orders: [order] });
    assert.deepEqual(again.body.results[0], { status: 'settled', reason: '', duplicate: true });

    const nonce = P.randomId();
    // build a topup request by hand to replay it
    const alice2 = await newUser(base, 'Alice2');
    const k = await (async () => { // reach a signing key for alice2 via a second unlock of a fresh identity
      const { pub, enc } = await generateWalletKey(PIN);
      return { pub, id: await P.idFromPub(P.unb64u(pub)), key: await unlockPrivateKey(PIN, enc) };
    })();
    const auth = await P.signAuth(k.key, { op: 'topup', id: k.id, name: 'K', pub: k.pub, extra: [M, nonce] });
    assert.equal((await post(base, '/api/topup', { auth, amount: M, nonce })).status, 200);
    assert.equal((await post(base, '/api/topup', { auth, amount: M, nonce })).status, 409); // replay
    assert.equal((await post(base, '/api/topup', { auth, amount: 2 * M, nonce })).status, 401); // amount not signed for
    assert.equal((await post(base, '/api/sync', { auth, since: 0 })).status, 401); // topup auth cannot be reused for sync
    assert.equal((await post(base, '/api/sync', {})).status, 401);
    assert.equal((await post(base, '/api/orders', { orders: [] })).status, 400);
    const huge = await fetch(base + '/api/orders', { method: 'POST', body: 'x'.repeat(300 * 1024) });
    assert.equal(huge.status, 413);
    assert.equal((await fetch(base + '/api/nope')).status, 404);
    assert.equal((await fetch(base + '/api/orders')).status, 405);
    assert.equal(alice2.wallet.profile.name, 'Alice2');
  });

  await t.test('static files: no path traversal', async () => {
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/js/../../package.json']) {
      const r = await fetch(base + p);
      assert.notEqual(r.status, 200, p);
    }
    const h = await fetch(base + '/api/health');
    assert.deepEqual(Object.keys(await h.json()).sort(), ['currency', 'ok', 'time', 'topup']);
  });

  await t.test('money is conserved: balances always add up to what was added', async () => {
    const topups = app.state.ledger.filter((e) => e.kind === 'topup' && e.status === 'settled').reduce((n, e) => n + e.amount, 0);
    const balances = Object.values(app.state.users).reduce((n, u) => n + u.balance, 0);
    assert.equal(balances, topups);
    for (const u of Object.values(app.state.users)) assert.ok(u.balance >= 0);
  });

  await t.test('server restarts without losing anything', async () => {
    await A.sync(); await B.sync();
    const before = { a: (await A.summary()).confirmed, b: (await B.summary()).confirmed };
    await app.close();
    app = createApp({ dataFile });
    await app.listen(port, '127.0.0.1');
    await A.sync(); await B.sync();
    assert.equal((await A.summary()).confirmed, before.a);
    assert.equal((await B.summary()).confirmed, before.b);
    // a duplicate after restart is still a duplicate
    const r = await post(base, '/api/orders', { orders: [offlineOrder] });
    assert.equal(r.body.results[0].duplicate, true);
  });

  await t.test('PIN lockout after repeated wrong guesses', async () => {
    const p = phone(base);
    await p.wallet.init();
    await p.wallet.create('Zed', PIN);
    for (let i = 0; i < 4; i++) await assert.rejects(p.wallet.unlock('000000'), (e) => e.code === 'BAD_PIN');
    await assert.rejects(p.wallet.unlock('000000'), (e) => e.code === 'BAD_PIN' && /locked/.test(e.message));
    await assert.rejects(p.wallet.unlock(PIN), (e) => e.code === 'LOCKED_OUT'); // even the right PIN waits
  });
});

test('static server: serves the app, versions the service worker, sets security headers', async (t) => {
  const app = createApp({});
  const port = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await index.text(), /<script type="module" src="\/js\/app\.js">/);

  const sw = await (await fetch(base + '/sw.js')).text();
  assert.doesNotMatch(sw, /__BUILD__/);
  assert.match(sw, /const VERSION = '[0-9a-f]{10}';/);

  // every file the service worker precaches must really exist (otherwise install would fail offline)
  const list = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1));
  assert.ok(list.length > 10);
  for (const url of list) assert.equal((await fetch(base + url)).status, 200, `missing precache entry ${url}`);

  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  for (const icon of manifest.icons) assert.equal((await fetch(base + icon.src)).status, 200, icon.src);
  assert.equal((await fetch(base + '/js/nope.js')).status, 404);
});
