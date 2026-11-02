// wallet.js — everything the app does, with no DOM. Works in the browser and in Node tests.
//
// How offline payments work
//   1. A payment is a small order signed with your private key (ECDSA P-256). Signing needs
//      no network, and the signed order can be verified by anyone.
//   2. The order is stored in your OUTBOX and shown as "pending". It is delivered to the server
//      automatically as soon as a connection exists. The server settles each order exactly once.
//   3. For in-person payments with nobody online, the payer shows the order as a QR / code and
//      the receiver's app checks the signature on the spot, then delivers it later too.
//   4. Your spendable balance is what the server last confirmed minus your own pending payments,
//      so you cannot overspend while offline. Incoming pending money is not spendable until settled.

import { CONFIG, LIMITS } from './config.js';
import * as P from './protocol.js';
import { generateWalletKey, unlockPrivateKey } from './crypto.js';
import { WalletError } from './errors.js';
import { cleanName, cleanNote, fmtMoney } from './format.js';

const MAX_PIN_TRIES = 5;

export function createWalletClient({ db, apiBase = '', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  let profile = null;
  let key = null; // unlocked signing key (non-extractable). Memory only, never stored.
  let online = false;
  let simulatedOffline = false;
  let health = null;
  let syncing = null;
  let chain = Promise.resolve();
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* listener errors are not ours */ } } };
  const exclusive = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const setOnline = (v) => { if (online !== v) { online = v; emit(); } };

  const isNetworkOnline = () => {
    if (simulatedOffline) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return true;
  };

  /* ---------- network ---------- */

  async function api(path, body, { timeout = 8000 } = {}) {
    if (!isNetworkOnline()) {
      setOnline(false);
      throw new WalletError('OFFLINE', 'No connection to the server');
    }
    let res;
    try {
      res = await doFetch(apiBase + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      setOnline(false);
      throw new WalletError('OFFLINE', 'No connection to the server');
    }
    setOnline(true);
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new WalletError('SERVER', data?.error || `Server error (${res.status})`, { status: res.status });
    return data;
  }

  /** Is the server reachable right now? (Checks navigator.onLine + server ping) */
  async function ping() {
    if (!isNetworkOnline()) {
      setOnline(false);
      return false;
    }
    try { health = await api('/api/health', null, { timeout: 4000 }); } catch { /* offline */ }
    return online;
  }

  /* ---------- profile / PIN ---------- */

  async function init() {
    profile = (await db.kv.get('profile')) || null;
    return profile;
  }

  async function create(name, pin) {
    name = cleanName(name);
    if (!name) throw new WalletError('BAD_NAME', 'Enter your name');
    if (!new RegExp(`^\\d{${CONFIG.pinLength}}$`).test(pin)) throw new WalletError('BAD_PIN', `PIN must be ${CONFIG.pinLength} digits`);
    const { pub, enc } = await generateWalletKey(pin);
    const id = await P.idFromPub(P.unb64u(pub));
    profile = { id, name, pub, enc, createdAt: Date.now() };
    await db.kv.set('profile', profile);
    await db.kv.set('sync', { lastSeq: 0, balance: 0, lastSyncAt: 0 });
    emit();
    return profile;
  }

  async function unlock(pin, { syncOnUnlock = true } = {}) {
    if (!profile) throw new WalletError('NO_WALLET', 'No wallet on this device');
    const guard = (await db.kv.get('guard')) || { fails: 0, until: 0 };
    if (guard.until > Date.now()) {
      const secs = Math.ceil((guard.until - Date.now()) / 1000);
      throw new WalletError('LOCKED_OUT', `Too many wrong PINs. Try again in ${secs}s.`, { retryMs: guard.until - Date.now() });
    }
    try {
      key = await unlockPrivateKey(pin, profile.enc);
    } catch {
      guard.fails += 1;
      if (guard.fails >= MAX_PIN_TRIES) guard.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (guard.fails - MAX_PIN_TRIES));
      await db.kv.set('guard', guard);
      const left = Math.max(0, MAX_PIN_TRIES - guard.fails);
      throw new WalletError('BAD_PIN', left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong PIN. The wallet is locked for a while.');
    }
    await db.kv.set('guard', { fails: 0, until: 0 });
    emit();
    // Register/update this account as soon as it is unlocked. This is best-effort so
    // wallet creation and offline use still work when the server cannot be reached.
    if (syncOnUnlock) void sync();
    return true;
  }

  const lockNow = () => { key = null; emit(); };

  async function rename(name) {
    name = cleanName(name);
    if (!name) throw new WalletError('BAD_NAME', 'Enter a name');
    profile = { ...profile, name };
    await db.kv.set('profile', profile);
    emit();
  }

  async function reset() {
    await db.wipe();
    profile = null; key = null;
    emit();
  }

  /* ---------- reading state ---------- */

  async function summary() {
    const s = (await db.kv.get('sync')) || { balance: 0, lastSeq: 0, lastSyncAt: 0 };
    let pendingOut = 0, pendingIn = 0, pending = 0;
    for (const t of await db.txns.all()) {
      if (t.status !== 'pending') continue;
      pending++;
      if (t.dir === 'out') pendingOut += t.amount; else if (t.dir === 'in') pendingIn += t.amount;
    }
    return {
      confirmed: s.balance,
      available: Math.max(0, s.balance - pendingOut),
      pendingOut, pendingIn, pending,
      lastSyncAt: s.lastSyncAt,
    };
  }

  const listTxns = async () => (await db.txns.all()).sort((a, b) => b.ts - a.ts);
  const getTxn = (id) => db.txns.get(id);
  const listContacts = async () => (await db.contacts.all()).sort((a, b) => b.lastAt - a.lastAt);

  async function remember(id, name) {
    if (!id) return;
    const c = await db.contacts.get(id);
    await db.contacts.put({ id, name: name || c?.name || '', lastAt: Date.now() });
  }

  /* ---------- paying ---------- */

  /** Sign a payment and put it in the outbox. Works with no network at all. */
  function pay({ to, toName = '', amount, note = '' }, pin) {
    return exclusive(async () => {
      if (!profile) throw new WalletError('NO_WALLET', 'No wallet on this device');
      if (!P.isValidId(to)) throw new WalletError('BAD_ID', 'That ID doesn’t look right. Check it and try again.');
      if (to === profile.id) throw new WalletError('SELF', 'You can’t pay yourself.');
      if (!Number.isSafeInteger(amount) || amount < 1) throw new WalletError('BAD_AMOUNT', 'Enter an amount.');
      if (amount > CONFIG.maxPaymentMinor) throw new WalletError('LIMIT', `The limit per payment is ${fmtMoney(CONFIG.maxPaymentMinor)}.`);
      const s = await summary();
      if (amount > s.available) throw new WalletError('NO_FUNDS', `Not enough balance. You can spend ${fmtMoney(s.available)}.`);
      await unlock(pin, { syncOnUnlock: false }); // PIN check = the key can only be decrypted with the right PIN
      const order = await P.signOrder(key, {
        from: profile.id, fromName: profile.name, pub: profile.pub,
        to, amount, currency: CONFIG.currency, note: cleanNote(note),
      });
      const txn = { id: order.i, dir: 'out', peer: to, peerName: cleanName(toName), amount, note: order.n, ts: order.s * 1000, status: 'pending', order };
      await db.txns.put(txn);
      await db.outbox.put({ id: order.i, order, createdAt: Date.now() });
      await remember(to, txn.peerName);
      emit();
      return txn;
    });
  }

  /** Receiver side: check a payment proof from another phone and queue it for settlement. */
  function acceptProof(order) {
    return exclusive(async () => {
      if (!profile) throw new WalletError('NO_WALLET', 'No wallet on this device');
      const err = await P.verifyOrder(order, LIMITS);
      if (err) throw new WalletError('BAD_PROOF', `This payment code isn’t valid (${err}).`);
      if (order.t !== profile.id) throw new WalletError('NOT_FOR_ME', 'This payment is addressed to someone else.');
      if (order.c !== CONFIG.currency) throw new WalletError('CURRENCY', `This payment is in ${order.c}, but this wallet uses ${CONFIG.currency}.`);
      const nowS = Math.floor(Date.now() / 1000);
      if (order.s > nowS + CONFIG.futureSkewSec) throw new WalletError('BAD_PROOF', 'This payment is dated in the future. Check the clock on both phones.');
      if (nowS - order.s > CONFIG.proofMaxAgeSec) throw new WalletError('EXPIRED', 'This payment code has expired. Ask for a new one.');
      const old = await db.txns.get(order.i);
      if (old) return { txn: old, duplicate: true };
      const txn = { id: order.i, dir: 'in', peer: order.f, peerName: order.fn, amount: order.a, note: order.n, ts: order.s * 1000, status: 'pending', order };
      await db.txns.put(txn);
      await db.outbox.put({ id: order.i, order, createdAt: Date.now() });
      await remember(order.f, order.fn);
      emit();
      return { txn, duplicate: false };
    });
  }

  /* ---------- sync ---------- */

  async function flushOutbox(timeout) {
    const items = await db.outbox.all();
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const r = await api('/api/orders', { orders: batch.map((x) => x.order) }, { timeout });
      for (let j = 0; j < batch.length; j++) {
        const res = r.results?.[j];
        if (!res) continue;
        if (res.status === 'rejected') { // invalid order: it will never settle
          const t = await db.txns.get(batch[j].id);
          if (t) { t.status = 'failed'; t.reason = res.reason || 'Rejected'; delete t.order; await db.txns.put(t); }
        }
        // settled / failed: the ledger pull below updates status and balance together
        await db.outbox.delete(batch[j].id);
      }
    }
    if (items.length) emit();
  }

  async function applyEntry(e) {
    const dir = e.kind === 'topup' ? 'topup' : e.from === profile.id ? 'out' : 'in';
    const old = await db.txns.get(e.id);
    const peer = dir === 'out' ? e.to : dir === 'in' ? e.from : null;
    const peerName = (dir === 'out' ? e.toName : dir === 'in' ? e.fromName : '') || old?.peerName || '';
    await db.txns.put({
      id: e.id, dir, peer, peerName, amount: e.amount, note: e.note || '',
      ts: dir === 'topup' ? e.at : e.ts * 1000,
      status: e.status, reason: e.reason || '', settledAt: e.at,
    });
    await db.outbox.delete(e.id);
    if (peer) await remember(peer, peerName);
  }

  async function pull(timeout) {
    let st = (await db.kv.get('sync')) || { lastSeq: 0, balance: 0, lastSyncAt: 0 };
    for (let page = 0; page < 20; page++) {
      const auth = await P.signAuth(key, { op: 'sync', id: profile.id, name: profile.name, pub: profile.pub, extra: st.lastSeq });
      const r = await api('/api/sync', { auth, since: st.lastSeq }, { timeout });
      for (const e of r.entries) await applyEntry(e);
      st = { lastSeq: r.next, balance: r.balance, lastSyncAt: Date.now() };
      await db.kv.set('sync', st);
      emit();
      if (!r.more) break;
    }
  }

  async function doSync({ timeout = 8000 } = {}) {
    try {
      await flushOutbox(timeout); // needs no key: orders are already signed
      if (key) await pull(timeout); // needs the unlocked key to authenticate
      return { ok: true, pulled: !!key };
    } catch (e) {
      if (e.code === 'OFFLINE' || e.status >= 500) return { ok: false, offline: true };
      return { ok: false, error: e.message || String(e) };
    }
  }

  let nextSync = null;

  /** Deliver pending orders, then fetch balance and history. Never throws. */
  function sync(opts) {
    if (!profile) return Promise.resolve({ ok: false, error: 'No wallet' });
    if (syncing) {
      if (!nextSync) {
        nextSync = syncing.then(() => {
          nextSync = null;
          return sync(opts);
        });
      }
      return nextSync;
    }
    syncing = doSync(opts || {}).finally(() => { syncing = null; });
    return syncing;
  }

  /** Demo money. Only works while online and only if the server has demo top-ups enabled. */
  async function topUp(amount) {
    if (!key) throw new WalletError('LOCKED', 'Unlock the wallet first');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > CONFIG.maxTopupMinor) {
      throw new WalletError('BAD_AMOUNT', `Choose an amount up to ${fmtMoney(CONFIG.maxTopupMinor)}.`);
    }
    const nonce = P.randomId();
    const auth = await P.signAuth(key, { op: 'topup', id: profile.id, name: profile.name, pub: profile.pub, extra: [amount, nonce] });
    await api('/api/topup', { auth, amount, nonce });
    await pull(8000);
  }

  return {
    init, create, unlock, lockNow, rename, reset, ping, sync, summary, topUp,
    pay, acceptProof, listTxns, getTxn, listContacts,
    isUnlocked: () => !!key,
    get profile() { return profile; },
    get online() { return online; },
    get health() { return health; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setSimulatedOffline(v) {
      simulatedOffline = !!v;
      if (simulatedOffline) {
        setOnline(false);
      } else {
        ping();
      }
      emit();
    },
    isSimulatedOffline: () => simulatedOffline,
    setOffline: () => setOnline(false),
    getDbmsOverview: () => api('/api/dbms/overview', null, { timeout: 5000 }),
    runDbmsQuery: (sql) => api('/api/dbms/query', { sql }, { timeout: 5000 }),
  };
}
