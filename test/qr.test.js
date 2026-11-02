import test from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, dataCodewords } from '../public/js/qr.js';
import * as P from '../public/js/protocol.js';
import { generateWalletKey, unlockPrivateKey } from '../public/js/crypto.js';

test('data capacity table matches the QR standard', () => {
  const standard = { 1: [19, 16, 13, 9], 5: [108, 86, 62, 46], 10: [274, 216, 154, 122], 14: [461, 365, 261, 197], 20: [861, 669, 485, 385], 40: [2956, 2334, 1666, 1276] };
  for (const [v, row] of Object.entries(standard)) row.forEach((n, e) => assert.equal(dataCodewords(+v, e), n, `v${v} level ${e}`));
});

test('matrix structure: size, finder patterns, timing pattern, determinism', () => {
  const m = qrMatrix('opay:pay?id=TEST', 'M');
  assert.equal(m.size, 17 + 4 * m.version);
  const dark = (x, y) => m.modules[y][x];
  for (const [ox, oy] of [[0, 0], [m.size - 7, 0], [0, m.size - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.ok(dark(ox + i, oy) && dark(ox + i, oy + 6) && dark(ox, oy + i) && dark(ox + 6, oy + i), 'finder outer ring');
    }
    assert.ok(dark(ox + 3, oy + 3), 'finder centre');
    assert.ok(!dark(ox + 1, oy + 1) && !dark(ox + 5, oy + 5), 'finder inner ring is light');
  }
  for (let i = 8; i < m.size - 8; i++) assert.equal(dark(i, 6), i % 2 === 0, 'timing pattern');
  assert.deepEqual(qrMatrix('same', 'L').modules, qrMatrix('same', 'L').modules);
});

test('a real signed payment proof fits in a QR code of a comfortable size', async () => {
  const mk = async () => {
    const { pub, enc } = await generateWalletKey('123456');
    return { pub, id: await P.idFromPub(P.unb64u(pub)), key: await unlockPrivateKey('123456', enc) };
  };
  const a = await mk();
  const b = await mk();
  const order = await P.signOrder(a.key, { from: a.id, fromName: 'Alexandra', pub: a.pub, to: b.id, amount: 123456, currency: 'USD', note: 'Dinner at the market' });
  const m = qrMatrix(P.encodeProof(order), 'L');
  assert.ok(m.version <= 14, `version ${m.version} is denser than expected`);
  assert.throws(() => qrMatrix('x'.repeat(3000), 'L'), /too long/);
});
