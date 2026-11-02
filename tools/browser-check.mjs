// tools/browser-check.mjs — optional end-to-end check in a real browser (needs Playwright).
//   npm i -D playwright && npx playwright install chromium && node tools/browser-check.mjs
// Walks through: create wallets, add money, STOP THE SERVER, reload (loads from the service-worker
// cache), pay offline, verify the code on the other phone, restart the server, watch both sync.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PIN = '123456';
const SHOTS = process.env.SHOTS || '';
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opay-browser-')), 'db.json');
let app = createApp({ dataFile });
const port = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [];
const results = [];

async function newPhone(name, colorScheme = 'light') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`[${name}] page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR/.test(m.text())) problems.push(`[${name}] console: ${m.text()}`); });
  page.on('requestfailed', () => {});
  return { name, context, page };
}
const shot = async (p, file) => { if (SHOTS) await p.page.screenshot({ path: path.join(SHOTS, `${p.name}-${file}.png`) }); };
const pin = async (page, digits = PIN) => { for (const d of digits) await page.keyboard.press(d); };

async function step(title, fn) {
  try { await fn(); results.push([true, title]); console.log('  ok  ', title); }
  catch (e) { results.push([false, title]); console.log('  FAIL', title, '\n       ', String(e.message).split('\n')[0]); }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

async function onboard(p, name) {
  const { page } = p;
  await page.goto(base + '/');
  await page.fill('#name', name);
  await shot(p, '01-welcome');
  await page.click('#create button[type=submit]');
  await page.waitForSelector('.pin-title:has-text("Create a PIN")');
  await pin(page);
  await page.waitForSelector('.pin-title:has-text("Confirm")');
  await pin(page);
  await page.waitForSelector('.hero-amount');
}
const idOf = (p) => p.page.textContent('.idchip span').then((t) => t.replace(/-/g, '').trim());
const hero = (p) => p.page.textContent('.hero-amount').then((t) => t.trim());

const alice = await newPhone('alice');
const bob = await newPhone('bob', 'dark');
let bobId, aliceId, proofCode;

console.log('\nOnline basics');
await step('Alice creates a wallet (name + PIN) and lands on Home', () => onboard(alice, 'Alice'));
await step('Bob creates a wallet', () => onboard(bob, 'Bob'));
await step('service worker installed and the app shell is cached', async () => {
  await alice.page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await alice.page.evaluate(async () => { const k = (await caches.keys())[0]; return (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname); });
  for (const f of ['/', '/index.html', '/js/app.js', '/js/wallet.js', '/css/styles.css', '/manifest.webmanifest']) check(cached.includes(f), `${f} not cached`);
});
await step('status chip says Online', async () => { await alice.page.waitForSelector('#status-text:has-text("Online")'); });
await step('Alice adds 100.00 demo money', async () => {
  await alice.page.waitForFunction(() => !document.querySelector('#status').hidden);
  await alice.page.click('[data-action=add-money]');
  await alice.page.click('.presets button:has-text("100")');
  await alice.page.click('#top-go');
  await alice.page.waitForFunction(() => /100\.00/.test(document.querySelector('.hero-amount')?.textContent || ''));
  await shot(alice, '02-home-funded');
});
aliceId = await idOf(alice);
bobId = await idOf(bob);

await step('Alice pays Bob 25.00 online: settles right away', async () => {
  await alice.page.goto(`${base}/#/pay?to=${bobId}&name=Bob`);
  await alice.page.fill('#amt', '25');
  await alice.page.fill('#note', 'lunch');
  await shot(alice, '03-pay');
  await alice.page.click('#pay-btn');
  await alice.page.waitForSelector('.pin');
  await pin(alice.page);
  await alice.page.waitForSelector('.receipt.settled');
  await shot(alice, '04-receipt-settled');
  check(/75\.00/.test(await (async () => { await alice.page.goto(`${base}/#/home`); await alice.page.waitForSelector('.hero-amount'); return hero(alice); })()), 'Alice should have 75.00 left');
});
await step('Bob sees 25.00 after his next sync', async () => {
  await bob.page.click('#status');
  await bob.page.waitForFunction(() => /25\.00/.test(document.querySelector('.hero-amount')?.textContent || ''));
});

console.log('\nServer goes away (this is the offline test)');
await app.close();
await step('Alice reloads with the server DOWN: the app still opens (from the service worker cache)', async () => {
  await alice.page.reload();
  await alice.page.waitForSelector('.pin-title:has-text("Welcome back")');
  await shot(alice, '05-lock');
  await pin(alice.page);
  await alice.page.waitForSelector('.hero-amount');
});
await step('Alice sees the Offline status and banner', async () => {
  await alice.page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await alice.page.waitForSelector('#status.offline');
  await alice.page.waitForSelector('#banner:not([hidden])');
});
await step('Alice pays Bob 12.50 OFFLINE: saved as pending, QR + code shown', async () => {
  await alice.page.goto(`${base}/#/pay?to=${bobId}&name=Bob`);
  await alice.page.fill('#amt', '12.50');
  await alice.page.fill('#note', 'taxi');
  await alice.page.click('#pay-btn');
  await alice.page.waitForSelector('.pin');
  await pin(alice.page);
  await alice.page.waitForSelector('.receipt.pending #proof-qr', { timeout: 15000 });
  proofCode = await alice.page.$eval('#proof-text', (el) => el.value);
  check(proofCode.startsWith('opay:proof:'), 'proof code missing');
  await shot(alice, '06-receipt-pending-qr');
  const png = await alice.page.$eval('#proof-qr', (c) => c.toDataURL('image/png').split(',')[1]);
  fs.writeFileSync('/tmp/shots/proof-qr.png', Buffer.from(png, 'base64'));
  fs.writeFileSync('/tmp/shots/proof-code.txt', proofCode);
});
await step('Alice’s spendable balance drops to 62.50 even though nothing has settled', async () => {
  await alice.page.goto(`${base}/#/home`);
  await alice.page.waitForFunction(() => /62\.50/.test(document.querySelector('.hero-amount')?.textContent || ''));
  await shot(alice, '07-home-offline');
});
await step('Bob (also offline) reloads, unlocks and checks the code with no internet', async () => {
  await bob.page.reload();
  await bob.page.waitForSelector('.pin-title:has-text("Welcome back")');
  await pin(bob.page);
  await bob.page.waitForSelector('.hero-amount');
  await bob.page.goto(`${base}/#/scan`);
  await bob.page.waitForSelector('[data-action=paste-code]');
  await bob.page.click('[data-action=paste-code]');
  await bob.page.fill('#pc', proofCode);
  await bob.page.click('#pc-go');
  await bob.page.waitForSelector('.receipt.pending');
  await shot(bob, '08-bob-verified-pending');
  const text = await bob.page.textContent('.receipt');
  check(/Code checked on this phone/.test(text) && /12\.50/.test(text), 'Bob should see a verified pending 12.50');
});
await step('a tampered code is refused', async () => {
  await bob.page.goto(`${base}/#/scan`);
  await bob.page.click('[data-action=paste-code]');
  await bob.page.fill('#pc', proofCode.replace('"a":1250', '"a":9250'));
  await bob.page.click('#pc-go');
  await bob.page.waitForSelector('#pc-err:has-text("isn’t valid")');
  await bob.page.keyboard.press('Escape');
});

console.log('\nServer comes back');
app = createApp({ dataFile });
await app.listen(port, '127.0.0.1');
await step('Bob syncs by himself: 12.50 settles', async () => {
  await bob.page.goto(`${base}/#/home`);
  await bob.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await bob.page.waitForFunction(() => /37\.50/.test(document.querySelector('.hero-amount')?.textContent || ''), null, { timeout: 15000 });
  await shot(bob, '09-bob-home-settled');
});
await step('Alice syncs by herself: her pending payment turns settled', async () => {
  await alice.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await alice.page.waitForSelector('#status.online', { timeout: 15000 });
  await alice.page.goto(`${base}/#/history`);
  await alice.page.waitForSelector('.tx-row');
  await alice.page.waitForFunction(() => !document.querySelector('.tx-amt.pending'), null, { timeout: 15000 });
  await shot(alice, '10-history');
  await alice.page.goto(`${base}/#/home`);
  check(/62\.50/.test(await hero(alice)), 'Alice should have 62.50');
});
await step('server ledger: exactly 2 settled payments, and money is conserved', async () => {
  const { state } = app;
  const pays = state.ledger.filter((e) => e.kind === 'pay' && e.status === 'settled');
  check(pays.length === 2, `expected 2 settled payments, got ${pays.length}`);
  const total = Object.values(state.users).reduce((n, u) => n + u.balance, 0);
  check(total === 10000, `balances should add up to 100.00, got ${total}`);
});

console.log('\nOther screens');
await step('Receive screen draws a QR code', async () => {
  await bob.page.goto(`${base}/#/receive`);
  await bob.page.waitForSelector('#req-qr');
  await bob.page.fill('#req-amt', '5');
  await bob.page.waitForFunction(() => /Asking for/.test(document.querySelector('#req-caption').textContent));
  await shot(bob, '11-receive');
  const png = await bob.page.$eval('#req-qr', (c) => c.toDataURL('image/png').split(',')[1]);
  fs.writeFileSync('/tmp/shots/request-qr.png', Buffer.from(png, 'base64'));
});
await step('Me screen renders', async () => { await alice.page.goto(`${base}/#/me`); await alice.page.waitForSelector('.menu'); await shot(alice, '12-me'); });
await step('wrong PIN is refused, right PIN unlocks, lock button locks', async () => {
  await alice.page.click('[data-action=lock]');
  await alice.page.waitForSelector('.pin-title:has-text("Welcome back")');
  await pin(alice.page, '000000');
  await alice.page.waitForSelector('.pin-err:has-text("Wrong PIN")');
  await pin(alice.page);
  await alice.page.waitForSelector('.menu');
});
await step('no page errors, no CSP violations', async () => { check(problems.length === 0, problems.join(' | ')); });

await browser.close();
await app.close();
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
