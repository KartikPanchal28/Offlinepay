// protocol.js — wire format, account IDs, signing and verification.
// Runs unchanged in browsers (secure context) and in Node 20+. No DOM, no Node-only imports.

const subtle = globalThis.crypto?.subtle;
const te = new TextEncoder();

export const cryptoAvailable = !!subtle;

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

/* ---------- base64url ---------- */

export function b64u(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export const randomId = () => b64u(crypto.getRandomValues(new Uint8Array(16))); // 22 chars

/* ---------- account IDs ----------
   ID = 10 base32 chars of SHA-256(public key) + 2 checksum chars, shown as XXXX-XXXX-XXXX.
   Because the ID is derived from the key, nobody can claim someone else's ID, and a wallet
   can be created with no server at all. The checksum catches most typing mistakes. */

function checksum(ten) {
  let s = 0;
  for (const ch of ten) s = (s * 33 + B32.indexOf(ch) + 1) % 1024;
  return B32[s >> 5] + B32[s & 31];
}

export async function idFromPub(pubBytes) {
  const h = new Uint8Array(await subtle.digest('SHA-256', pubBytes));
  let out = '', acc = 0, bits = 0, i = 0;
  while (out.length < 10) {
    if (bits < 5) { acc = (acc << 8) | h[i++]; bits += 8; }
    bits -= 5;
    out += B32[(acc >> bits) & 31];
    acc &= (1 << bits) - 1;
  }
  return out + checksum(out);
}

export const isValidId = (id) =>
  typeof id === 'string' && /^[0-9A-HJKMNP-TV-Z]{12}$/.test(id) && checksum(id.slice(0, 10)) === id.slice(10);

export const normalizeId = (s) =>
  String(s ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

export const formatId = (id) => String(id).replace(/(.{4})(?=.)/g, '$1-');

/* ---------- signed payment orders ----------
   Compact JSON: { v, i: order id, f: from, t: to, a: amount (minor units), c: currency,
                   s: unix seconds, n: note, fn: sender name, k: sender public key, g: signature } */

export function orderMessage(o) {
  return te.encode(JSON.stringify(['opay1', o.i, o.f, o.t, o.a, o.c, o.s, o.n, o.fn]));
}

export function checkOrderShape(o, limits) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'Malformed order';
  if (o.v !== 1) return 'Unsupported version';
  if (typeof o.i !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(o.i)) return 'Bad order id';
  if (!isValidId(o.f) || !isValidId(o.t)) return 'Bad account id';
  if (o.f === o.t) return 'Cannot pay yourself';
  if (!Number.isSafeInteger(o.a) || o.a < 1 || o.a > limits.maxAmount) return 'Bad amount';
  if (typeof o.c !== 'string' || !/^[A-Z]{3}$/.test(o.c)) return 'Bad currency';
  if (!Number.isSafeInteger(o.s) || o.s < 1) return 'Bad time';
  if (typeof o.n !== 'string' || o.n.length > limits.maxNote) return 'Bad note';
  if (typeof o.fn !== 'string' || o.fn.length > limits.maxName) return 'Bad name';
  if (typeof o.k !== 'string' || o.k.length !== 87) return 'Bad key';
  if (typeof o.g !== 'string' || o.g.length !== 86) return 'Bad signature';
  return null;
}

/** Full check: shape + key matches sender id + signature. Returns null if valid, else a reason. */
export async function verifyOrder(o, limits) {
  const bad = checkOrderShape(o, limits);
  if (bad) return bad;
  let pub, sig;
  try { pub = unb64u(o.k); sig = unb64u(o.g); } catch { return 'Bad encoding'; }
  if (pub.length !== 65 || pub[0] !== 4 || sig.length !== 64) return 'Bad key or signature';
  if ((await idFromPub(pub)) !== o.f) return 'Sender key does not match sender id';
  let key;
  try { key = await subtle.importKey('raw', pub, ECDSA, false, ['verify']); } catch { return 'Bad public key'; }
  const ok = await subtle.verify(SIGN, key, sig, orderMessage(o));
  return ok ? null : 'Signature check failed';
}

export async function signOrder(privKey, { from, fromName, pub, to, amount, currency, note }) {
  const o = {
    v: 1, i: randomId(), f: from, t: to, a: amount, c: currency,
    s: Math.floor(Date.now() / 1000), n: note || '', fn: fromName || '', k: pub,
  };
  o.g = b64u(await subtle.sign(SIGN, privKey, orderMessage(o)));
  return o;
}

/* ---------- request authentication (device -> server) ---------- */

export const authMessage = (op, id, ts, extra) =>
  te.encode(JSON.stringify(['opay1-auth', op, id, ts, extra]));

export async function signAuth(privKey, { op, id, name, pub, extra = 0 }) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = b64u(await subtle.sign(SIGN, privKey, authMessage(op, id, ts, extra)));
  return { id, name, pub, ts, sig };
}

export async function verifyAuth(auth, op, extra, { nowSec = Math.floor(Date.now() / 1000), skewSec = 600 } = {}) {
  if (!auth || typeof auth !== 'object') return 'Missing auth';
  const { id, pub, ts, sig } = auth;
  if (!isValidId(id)) return 'Bad id';
  if (typeof pub !== 'string' || pub.length !== 87 || typeof sig !== 'string' || sig.length !== 86) return 'Bad key or signature';
  if (!Number.isSafeInteger(ts) || Math.abs(nowSec - ts) > skewSec) return 'Your device clock is off by more than 10 minutes';
  let pubBytes, sigBytes;
  try { pubBytes = unb64u(pub); sigBytes = unb64u(sig); } catch { return 'Bad encoding'; }
  if (pubBytes.length !== 65 || pubBytes[0] !== 4 || sigBytes.length !== 64) return 'Bad key or signature';
  if ((await idFromPub(pubBytes)) !== id) return 'Key does not match id';
  let key;
  try { key = await subtle.importKey('raw', pubBytes, ECDSA, false, ['verify']); } catch { return 'Bad public key'; }
  const ok = await subtle.verify(SIGN, key, sigBytes, authMessage(op, id, ts, extra));
  return ok ? null : 'Signature check failed';
}

/* ---------- QR / paste codes ----------
   opay:pay?id=XXXX…&n=Name&a=1250&c=USD&m=note   "pay me" request (shown by the receiver)
   opay:proof:{…signed order JSON…}                 payment proof (shown by the payer)      */

const asciiJson = (v) =>
  JSON.stringify(v).replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

export const encodeProof = (order) => 'opay:proof:' + asciiJson(order);

export function encodeRequest({ id, name, amount, currency, note }) {
  const q = new URLSearchParams({ id });
  if (name) q.set('n', name);
  if (amount) { q.set('a', String(amount)); q.set('c', currency); }
  if (note) q.set('m', note);
  return 'opay:pay?' + q.toString();
}

export function parseCode(text) {
  const t = String(text ?? '').trim();
  if (t.startsWith('opay:proof:')) {
    try { return { type: 'proof', order: JSON.parse(t.slice(11)) }; } catch { return null; }
  }
  if (t.startsWith('opay:pay?')) {
    const q = new URLSearchParams(t.slice(9));
    const id = normalizeId(q.get('id') || '');
    if (!isValidId(id)) return null;
    const a = q.get('a') || '';
    return {
      type: 'pay', id,
      name: (q.get('n') || '').slice(0, 40),
      amount: /^\d{1,12}$/.test(a) ? Number(a) : 0,
      currency: q.get('c') || '',
      note: (q.get('m') || '').slice(0, 60),
    };
  }
  const id = normalizeId(t); // a bare ID typed or pasted by hand
  return isValidId(id) ? { type: 'pay', id, name: '', amount: 0, currency: '', note: '' } : null;
}
