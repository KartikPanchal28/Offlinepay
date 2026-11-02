// crypto.js — the wallet's private key is encrypted with a key derived from the PIN
// (PBKDF2 -> AES-GCM). Without the PIN the key cannot be used, even by someone who
// copies the browser's storage. After unlocking it is held in memory as a NON-extractable key.

import { b64u, unb64u } from './protocol.js';

const subtle = globalThis.crypto?.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const ITERATIONS = 200_000;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

async function pinToAesKey(pin, salt, iter) {
  const base = await subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(pin, text) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pinToAesKey(pin, salt, ITERATIONS);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
  return { v: 1, iter: ITERATIONS, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) };
}

/** Create a new signing key pair. Returns the public key and the PIN-encrypted private key. */
export async function generateWalletKey(pin) {
  const kp = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const pub = b64u(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  return { pub, enc: await seal(pin, JSON.stringify(jwk)) };
}

/** Decrypt the private key with the PIN. Throws if the PIN is wrong. */
export async function unlockPrivateKey(pin, enc) {
  let plain;
  try {
    const key = await pinToAesKey(pin, unb64u(enc.salt), enc.iter);
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(enc.iv) }, key, unb64u(enc.ct));
  } catch {
    throw new Error('BAD_PIN'); // AES-GCM authentication fails when the PIN is wrong
  }
  return subtle.importKey('jwk', JSON.parse(td.decode(plain)), ECDSA, false, ['sign']);
}
