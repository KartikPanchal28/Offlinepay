import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../public/js/protocol.js';
import { LIMITS, CONFIG } from '../public/js/config.js';
import { generateWalletKey, unlockPrivateKey } from '../public/js/crypto.js';
import { parseMoney } from '../public/js/format.js';

async function newIdentity(pin = '123456') {
  const { pub, enc } = await generateWalletKey(pin);
  const id = await P.idFromPub(P.unb64u(pub));
  const key = await unlockPrivateKey(pin, enc);
  return { pub, enc, id, key };
}

test('account ids: derived from the key, checksummed, typo-tolerant input', async () => {
  const a = await newIdentity();
  assert.ok(P.isValidId(a.id));
  assert.equal(a.id.length, 12);
  assert.equal(P.normalizeId(P.formatId(a.id).toLowerCase()), a.id);
  assert.match(P.formatId(a.id), /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  // every single-character substitution must be caught by the checksum
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  for (let i = 0; i < 12; i++) {
    for (const ch of alphabet) {
      if (ch === a.id[i]) continue;
      const typo = a.id.slice(0, i) + ch + a.id.slice(i + 1);
      assert.equal(P.isValidId(typo), false, `typo at ${i} -> ${ch} was accepted`);
    }
  }
  assert.equal(P.isValidId('short'), false);
  assert.equal(P.isValidId(undefined), false);
});

test('signed orders verify, and any tampering is detected', async () => {
  const alice = await newIdentity();
  const bob = await newIdentity();
  const order = await P.signOrder(alice.key, { from: alice.id, fromName: 'Alice', pub: alice.pub, to: bob.id, amount: 2500, currency: 'USD', note: 'lunch' });
  assert.equal(await P.verifyOrder(order, LIMITS), null);

  const tampered = (patch) => ({ ...order, ...patch });
  assert.equal(await P.verifyOrder(tampered({ a: 9900 }), LIMITS), 'Signature check failed');
  assert.equal(await P.verifyOrder(tampered({ t: (await newIdentity()).id }), LIMITS), 'Signature check failed');
  assert.equal(await P.verifyOrder(tampered({ n: 'rent' }), LIMITS), 'Signature check failed');
  assert.equal(await P.verifyOrder(tampered({ fn: 'Mallory' }), LIMITS), 'Signature check failed');
  // a valid signature from a DIFFERENT key must not be accepted under Alice's id
  const mallory = await newIdentity();
  const forged = await P.signOrder(mallory.key, { from: alice.id, fromName: 'Alice', pub: mallory.pub, to: bob.id, amount: 100, currency: 'USD', note: '' });
  assert.equal(await P.verifyOrder(forged, LIMITS), 'Sender key does not match sender id');
  assert.match(await P.verifyOrder(tampered({ a: 0 }), LIMITS), /Bad amount/);
  assert.match(await P.verifyOrder(tampered({ a: 1.5 }), LIMITS), /Bad amount/);
  assert.match(await P.verifyOrder(tampered({ a: LIMITS.maxAmount + 1 }), LIMITS), /Bad amount/);
  assert.match(await P.verifyOrder(tampered({ t: alice.id }), LIMITS), /yourself/);
  assert.match(await P.verifyOrder(null, LIMITS), /Malformed/);
});

test('the private key can only be unlocked with the right PIN', async () => {
  const { enc } = await generateWalletKey('246810');
  await assert.rejects(unlockPrivateKey('111111', enc), /BAD_PIN/);
  const key = await unlockPrivateKey('246810', enc);
  assert.equal(key.extractable, false);
  assert.deepEqual(key.usages, ['sign']);
});

test('auth messages: signature, id binding, clock window, replay of other operations', async () => {
  const a = await newIdentity();
  const auth = await P.signAuth(a.key, { op: 'sync', id: a.id, name: 'A', pub: a.pub, extra: 7 });
  assert.equal(await P.verifyAuth(auth, 'sync', 7), null);
  assert.equal(await P.verifyAuth(auth, 'topup', 7), 'Signature check failed'); // different operation
  assert.equal(await P.verifyAuth(auth, 'sync', 8), 'Signature check failed'); // different payload
  assert.match(await P.verifyAuth(auth, 'sync', 7, { nowSec: auth.ts + 3600 }), /clock/);
  assert.equal(await P.verifyAuth({ ...auth, id: (await newIdentity()).id }, 'sync', 7), 'Key does not match id');
});

test('payment codes round-trip (including non-ASCII names) and stay ASCII-only', async () => {
  const a = await newIdentity();
  const b = await newIdentity();
  const order = await P.signOrder(a.key, { from: a.id, fromName: 'Zoë 李', pub: a.pub, to: b.id, amount: 1234, currency: 'USD', note: 'café ☕' });
  const code = P.encodeProof(order);
  assert.ok(/^[\x20-\x7e]+$/.test(code), 'proof code must be printable ASCII');
  const parsed = P.parseCode(code);
  assert.equal(parsed.type, 'proof');
  assert.deepEqual(parsed.order, order);
  assert.equal(await P.verifyOrder(parsed.order, LIMITS), null);

  const req = P.encodeRequest({ id: b.id, name: 'Bob & Co', amount: 500, currency: 'USD', note: 'tea' });
  assert.deepEqual(P.parseCode(req), { type: 'pay', id: b.id, name: 'Bob & Co', amount: 500, currency: 'USD', note: 'tea' });
  assert.equal(P.parseCode(P.formatId(b.id).toLowerCase()).id, b.id); // typed by hand
  assert.equal(P.parseCode('hello world'), null);
  assert.equal(P.parseCode('opay:pay?id=AAAAAAAAAAAA'), null); // bad checksum
  assert.equal(P.parseCode('opay:proof:{not json'), null);
});

test('money parsing is exact (no floating point drift)', () => {
  const d = CONFIG.decimals;
  assert.equal(parseMoney('0.1') + parseMoney('0.2'), parseMoney('0.3'));
  assert.equal(parseMoney('12'), 12 * 10 ** d);
  assert.equal(parseMoney('12.5'), d >= 1 ? 125 * 10 ** (d - 1) : null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('1.' + '9'.repeat(d + 1)), null); // too many decimals
});
