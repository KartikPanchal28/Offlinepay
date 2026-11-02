// app.js — screens, routing and wiring. All money logic lives in wallet.js; this file draws and listens.
import { CONFIG } from './config.js';
import * as P from './protocol.js';
import { openDatabase } from './db.js';
import { createWalletClient } from './wallet.js';
import { drawQR } from './qr.js';
import { fmtMoney, fmtPlain, parseMoney, initials, hueSlot, whenLabel, cleanNote, cleanName } from './format.js';
import { html, icon, render, toast, copyText, pinSheet, openSheet, playSuccessChime, launchConfetti, openScratchCard } from './ui.js';
import { startScanner } from './scanner.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
let wallet;

let cleanup = null; // runs when leaving a screen (stops the camera, ...)
let refresh = null; // repaints the live parts of the current screen when data changes
let routeToken = 0; // lets slow async work notice that the person has already moved on
let statusKnown = false; // false until the first connectivity check finishes
let syncingNow = false;
let installEvent = null;
let lockPromise = null;
let lastActive = Date.now();
let hiddenAt = 0;
let historyFilter = 'all';
let proofCode = '';

const idText = (id) => P.formatId(id);
const personName = (t) => t.peerName || (t.peer ? idText(t.peer) : '');
const go = (hash) => { location.hash = hash; };

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = h.split('?');
  const [name, ...rest] = path.split('/');
  return { name: name || 'home', arg: rest.join('/'), params: new URLSearchParams(qs) };
}

/* ====================================================================== chrome */

function setChrome({ top = true, title = CONFIG.appName, back = null, nav = null } = {}) {
  $('#topbar').hidden = !top;
  $('#title').textContent = title;
  const b = $('#back');
  b.hidden = !back;
  if (back) b.setAttribute('href', back);
  $('#tabs').hidden = !nav;
  document.querySelectorAll('#tabs [data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === nav));
  paintStatus();
}

async function paintStatus() {
  const chip = $('#status');
  if (!wallet?.profile || !wallet.isUnlocked() || $('#topbar').hidden) {
    chip.hidden = true;
    $('#banner').hidden = true;
    return;
  }
  chip.hidden = false;
  const s = await wallet.summary();
  const online = wallet.online;
  chip.className = 'chip ' + (statusKnown && !online ? 'offline' : 'online');
  const label = !statusKnown ? 'Checking' : syncingNow ? 'Syncing' : online ? 'Online' : 'Offline';
  $('#status-text').textContent = label + (s.pending ? ` · ${s.pending} pending` : '');
  $('#banner').hidden = !statusKnown || online;
}

/* ====================================================================== routing */

const ROUTES = {
  home: viewHome,
  scan: viewScan,
  pay: viewPay,
  receive: viewReceive,
  history: viewHistory,
  tx: viewTx,
  me: viewMe,
  dbms: viewDbms,
  success: viewSuccess,
};

async function route() {
  const token = ++routeToken;
  cleanup?.(); cleanup = null; refresh = null;
  if (!wallet.profile) { viewOnboarding(); return; }
  if (!wallet.isUnlocked()) {
    setChrome({ top: false });
    render(view, html``);
    await ensureUnlocked();
    if (token !== routeToken) return;
  }
  const { name, arg, params } = parseHash();
  const fn = ROUTES[name];
  if (!fn) { location.replace('#/home'); return; }
  window.scrollTo(0, 0);
  await fn({ arg, params, token });
}

function ensureUnlocked() {
  if (wallet.isUnlocked()) return Promise.resolve();
  lockPromise ||= pinSheet({
    title: 'Welcome back',
    subtitle: wallet.profile.name,
    fullscreen: true,
    cancellable: false,
    onPin: (pin) => wallet.unlock(pin),
  }).then(() => { lockPromise = null; lastActive = Date.now(); heartbeat(); });
  return lockPromise;
}

/* ====================================================================== onboarding */

function viewOnboarding() {
  setChrome({ top: false });
  render(view, html`
    <section class="welcome">
      <div class="mark">${icon('logo')}</div>
      <h1>${CONFIG.appName}</h1>
      <p class="lede">Pay and get paid, with or without internet.</p>
      <form id="create" autocomplete="off">
        <label class="field"><span>Your name</span>
          <input id="name" maxlength="${CONFIG.maxNameLength}" autocomplete="given-name" required></label>
        <button class="btn primary block" type="submit">Create wallet</button>
      </form>
      <ul class="points">
        <li>Your keys are made on this device and locked with a ${CONFIG.pinLength}-digit PIN.</li>
        <li>If you forget the PIN or clear this browser’s data, the wallet can’t be recovered.</li>
      </ul>
    </section>`);

  $('#create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = cleanName($('#name').value);
    if (!name) { toast('Enter your name'); return; }
    const first = await pinSheet({
      title: 'Create a PIN',
      subtitle: `${CONFIG.pinLength} digits. You’ll use it to open the app and approve payments.`,
      onPin: async (pin) => pin,
    });
    if (!first) return;
    const second = await pinSheet({
      title: 'Confirm your PIN',
      subtitle: 'Enter it once more.',
      onPin: async (pin) => { if (pin !== first.value) throw new Error('The PINs don’t match. Cancel and start again.'); return pin; },
    });
    if (!second) return;
    toast('Creating your wallet…');
    try {
      await wallet.create(name, first.value);
      await wallet.unlock(first.value);
    } catch (err) { toast(err.message); return; }
    navigator.storage?.persist?.().catch(() => {});
    lastActive = Date.now();
    go('#/home');
    route();
    heartbeat();
  });
}

function viewInsecure() {
  setChrome({ top: false });
  render(view, html`
    <section class="welcome">
      <div class="mark">${icon('lock')}</div>
      <h1>Secure page needed</h1>
      <p class="lede">Wallet keys can only be created on an HTTPS page, or on localhost.</p>
      <p class="muted">Open this app at http://localhost:3000 on the computer running the server, or use an HTTPS address. The README explains how to do this for a phone.</p>
    </section>`);
}

/* ====================================================================== home */

async function viewHome({ token }) {
  setChrome({ nav: 'home' });
  render(view, html`<div id="home"></div>`);
  refresh = async () => {
    const [s, txns, contacts] = await Promise.all([wallet.summary(), wallet.listTxns(), wallet.listContacts()]);
    if (token !== routeToken) return;
    render($('#home'), homeTemplate(s, txns.slice(0, 6), contacts));
  };
  await refresh();
}

function homeTemplate(s, txns, contacts = []) {
  const me = wallet.profile;
  const canAdd = wallet.health?.topup !== false;
  return html`
    <section class="hero">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <p class="hero-label">Available to spend</p>
          <p class="hero-amount">${fmtMoney(s.available)}</p>
        </div>
        ${canAdd ? html`<button class="btn secondary" data-action="add-money" type="button" style="min-height:36px;padding:0 14px;font-size:13px;margin-top:6px">${icon('plus')}Add money</button>` : ''}
      </div>
      <div class="hero-meta">
        ${s.pendingIn ? html`<span class="pend">${icon('receive')}${fmtMoney(s.pendingIn)} incoming</span>` : ''}
        ${s.pendingOut ? html`<span class="pend">${icon('send')}${fmtMoney(s.pendingOut)} pending</span>` : ''}
        <button class="idchip" data-action="copy-id" type="button" aria-label="Copy your ID">${icon('copy')}<span>${idText(me.id)}</span></button>
        <button class="net-toggle ${wallet.isSimulatedOffline() ? 'sim-off' : ''}" data-action="toggle-offline" type="button" title="Click to test offline/online mode">
          ${icon(wallet.online ? 'wifi' : 'wifiOff')}<span>${wallet.online ? 'Online' : 'Offline Mode'}</span>
        </button>
      </div>
      <p class="asof">${s.lastSyncAt ? `Balance confirmed ${whenLabel(s.lastSyncAt)}` : 'Balance not confirmed yet. Connect once to sync.'}</p>
    </section>

    <nav class="actions" aria-label="Quick actions">
      <a class="act primary" href="#/scan"><span class="act-ic">${icon('scan')}</span>Scan QR</a>
      <a class="act" href="#/pay"><span class="act-ic">${icon('send')}</span>Send</a>
      <a class="act" href="#/receive"><span class="act-ic">${icon('receive')}</span>Receive</a>
      <a class="act" href="#/dbms"><span class="act-ic" style="color:#A78BFA">${icon('database')}</span>DBMS</a>
    </nav>

    <!-- Google Pay People Row -->
    <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px 6px">
      <h2 class="sec flush" style="margin:0">People & Contacts</h2>
      <a class="link fine" href="#/pay">+ New pay</a>
    </div>
    <div style="display:flex;gap:14px;overflow-x:auto;padding:8px 20px 14px;scrollbar-width:none;-webkit-overflow-scrolling:touch">
      ${contacts.length ? contacts.slice(0, 8).map(c => html`
        <a href="#/pay?to=${c.id}&name=${encodeURIComponent(c.name)}" style="display:flex;flex-direction:column;align-items:center;gap:6px;text-decoration:none;min-width:64px">
          <span class="av lg" data-c="${hueSlot(c.id)}">${initials(c.name)}</span>
          <span style="font-size:12px;font-weight:600;max-width:68px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);text-align:center">${c.name || 'Friend'}</span>
        </a>
      `) : html`
        <a href="#/pay" style="display:flex;align-items:center;gap:10px;text-decoration:none;padding:10px 16px;background:var(--bg-surface);border-radius:999px;border:1px solid var(--line-strong)">
          <span class="act-ic" style="width:36px;height:36px;margin:0">${icon('send')}</span>
          <span style="font-size:13px;font-weight:600;color:var(--ink)">Pay your first friend</span>
        </a>
      `}
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px 4px">
      <h2 class="sec flush" style="margin:0">Recent Activity</h2>
      <a class="link fine" href="#/history">View all</a>
    </div>
    ${txns.length
      ? html`<ul>${txns.map((t) => txRow(t))}</ul><p class="center pad-top"><a class="link" href="#/history">See all activity</a></p>`
      : html`<p class="empty">No payments yet. Add some demo money, then send a payment or share your code.</p>`}`;
}

function txRow(t) {
  const name = t.dir === 'topup' ? 'Added money' : personName(t) || 'Unknown';
  const sign = t.dir === 'out' ? '−' : '+';
  const kind = t.status === 'pending' ? 'pending' : t.status === 'failed' ? 'failed' : t.dir;
  let sub;
  if (t.status === 'pending') sub = t.dir === 'in' ? 'Verified, waiting to settle' : 'Saved, waiting to send';
  else if (t.status === 'failed') sub = t.reason || 'Failed';
  else sub = [t.dir === 'topup' ? '' : t.note, whenLabel(t.ts)].filter(Boolean).join(' · ');
  return html`<li><a class="tx-row" href="#/tx/${encodeURIComponent(t.id)}">
    <span class="av" data-c="${t.dir === 'topup' ? 1 : hueSlot(t.peer || t.id)}">${t.dir === 'topup' ? '+' : initials(name)}</span>
    <span class="tx-main"><span class="tx-name">${name}</span><span class="tx-sub">${sub}</span></span>
    <span class="tx-amt ${kind}">${sign}${fmtMoney(t.amount)}</span></a></li>`;
}

/* ====================================================================== scan + codes */

/** Handle anything that was scanned or pasted. Returns { ok, message }. */
async function handleCode(text, { quiet = false } = {}) {
  const fail = (message) => { if (!quiet) toast(message); return { ok: false, message }; };
  const c = P.parseCode(text);
  if (!c) return fail('That isn’t an OfflinePay code.');

  if (c.type === 'pay') {
    if (c.id === wallet.profile.id) return fail('That’s your own code.');
    if (c.currency && c.currency !== CONFIG.currency) return fail(`That code is in ${c.currency}, but this wallet uses ${CONFIG.currency}.`);
    const q = new URLSearchParams({ to: c.id });
    if (c.name) q.set('name', c.name);
    if (c.amount) q.set('amount', String(c.amount));
    if (c.note) q.set('note', c.note);
    go('#/pay?' + q);
    return { ok: true };
  }

  try {
    const { txn, duplicate } = await wallet.acceptProof(c.order);
    queueBackgroundSync();
    wallet.sync({ timeout: 3500 });
    toast(duplicate ? 'You already have this payment.' : 'Payment code checked.');
    go('#/tx/' + encodeURIComponent(txn.id) + '?received=1');
    return { ok: true };
  } catch (e) {
    return fail(e.message);
  }
}

async function viewScan() {
  setChrome({ title: 'Scan', nav: 'scan' });
  render(view, html`
    <div class="viewfinder"><video id="cam" playsinline muted></video><div class="reticle"></div></div>
    <p class="scan-hint" id="scan-hint">Starting the camera…</p>
    <div class="pad"><button class="btn secondary block" data-action="paste-code" type="button">Enter a code instead</button></div>`);
  let scanner = null;
  let gone = false;
  cleanup = () => { gone = true; scanner?.stop(); };
  try {
    scanner = await startScanner($('#cam'), (text) => handleCode(text));
    if (gone) { scanner.stop(); return; }
    $('#scan-hint').textContent = 'Point the camera at an OfflinePay QR code.';
  } catch (e) {
    if (gone) return;
    $('.viewfinder').hidden = true;
    $('#scan-hint').textContent =
      e.code === 'DENIED' ? 'Camera access is blocked. Allow it in the browser settings, or enter the code instead.'
      : e.code === 'NO_DETECTOR' ? 'This browser can’t read QR codes from the camera. Enter the code instead.'
      : 'No camera is available. Enter the code instead.';
  }
}

function openPasteCode() {
  openSheet(html`
    <h2 class="sheet-title">Enter a code</h2>
    <p class="muted">Paste a payment code, a payment request, or someone’s ID.</p>
    <label class="field"><span class="sr">Code</span>
      <textarea class="code" id="pc" rows="4" autocapitalize="off" spellcheck="false"></textarea></label>
    <p class="err" id="pc-err" role="alert"></p>
    <button class="btn primary block" id="pc-go" type="button">Continue</button>`,
  {
    label: 'Enter a code',
    onMount: (el, close) => {
      el.querySelector('#pc').focus();
      el.querySelector('#pc-go').addEventListener('click', async () => {
        const r = await handleCode(el.querySelector('#pc').value, { quiet: true });
        if (r.ok) close(); else el.querySelector('#pc-err').textContent = r.message;
      });
    },
  });
}

/* ====================================================================== pay */

const contactRow = (c) => html`<li><a class="tx-row" href="#/pay?to=${c.id}${c.name ? '&name=' + encodeURIComponent(c.name) : ''}">
  <span class="av" data-c="${hueSlot(c.id)}">${initials(c.name)}</span>
  <span class="tx-main"><span class="tx-name">${c.name || 'Saved contact'}</span><span class="tx-sub mono">${idText(c.id)}</span></span></a></li>`;

async function viewPay({ params }) {
  setChrome({ title: 'Send money', back: '#/home' });
  const to = P.normalizeId(params.get('to') || '');
  if (!to) return payPicker();
  if (!P.isValidId(to)) { toast('That ID doesn’t look right.'); go('#/pay'); return; }
  if (to === wallet.profile.id) { toast('You can’t pay yourself.'); go('#/pay'); return; }

  const contact = (await wallet.listContacts()).find((c) => c.id === to);
  const name = cleanName(params.get('name') || contact?.name || '');
  const prefill = Number(params.get('amount')) || 0;
  const note = cleanNote(params.get('note') || '');
  const s = await wallet.summary();

  render(view, html`
    <section class="pad">
      <div class="payee">
        <span class="av lg" data-c="${hueSlot(to)}">${initials(name)}</span>
        <div><p class="payee-name">${name || 'New recipient'}</p><p class="mono muted">${idText(to)}</p></div>
        <a class="link" href="#/pay">Change</a>
      </div>
      <label class="field"><span class="sr">Amount in ${CONFIG.currency}</span>
        <input id="amt" class="amount-input" inputmode="decimal" autocomplete="off" placeholder="${fmtPlain(0)}" value="${prefill ? fmtPlain(prefill) : ''}"></label>
      <p class="center muted">You can spend ${fmtMoney(s.available)}</p>
      <label class="field"><span>Note (optional)</span>
        <input id="note" maxlength="${CONFIG.maxNoteLength}" value="${note}" autocomplete="off"></label>
      <p class="err" id="pay-err" role="alert"></p>
      <button class="btn primary block" id="pay-btn" type="button">Pay</button>
      <p class="fine center pad-top">${wallet.online
        ? 'You’re online, so the payment settles right away.'
        : 'You’re offline. The payment is saved on this phone, and its code can be shown to the receiver. It settles when a phone gets back online.'}</p>
    </section>`);

  const err = $('#pay-err');
  $('#pay-btn').addEventListener('click', async () => {
    err.textContent = '';
    const amount = parseMoney($('#amt').value);
    if (!amount) { err.textContent = `Enter an amount like ${fmtPlain(1250)}.`; return; }
    if (amount > CONFIG.maxPaymentMinor) { err.textContent = `The limit per payment is ${fmtMoney(CONFIG.maxPaymentMinor)}.`; return; }
    const available = (await wallet.summary()).available;
    if (amount > available) { err.textContent = `You can spend up to ${fmtMoney(available)}.`; return; }
    const noteText = cleanNote($('#note').value);

    const res = await pinSheet({
      title: `Pay ${name || 'this person'}`,
      subtitle: `${fmtMoney(amount)} to ${idText(to)}`,
      onPin: (pin) => wallet.pay({ to, toName: name, amount, note: noteText }, pin),
    });
    if (!res) return;
    const txn = res.value;
    render(view, html`
      <div class="gpay-sending">
        <div class="sending-avatar-wrap">
          <div class="sending-ripple"></div>
          <div class="sending-ripple d2"></div>
          <div class="sending-ripple d3"></div>
          <span class="av lg" data-c="${hueSlot(to)}">${initials(name)}</span>
          <span class="coin-fly">🪙</span>
        </div>
        <h2 style="font-size:24px;font-weight:700;margin-bottom:6px">Paying ${fmtMoney(amount)}</h2>
        <p class="muted" style="font-size:16px">${name || idText(to)}</p>
        <p class="fine pad-top" style="color:var(--accent)">${wallet.online ? `⚡ Settling via ${wallet.health?.engine || 'SQL'} database transaction...` : '🔒 Signing payment offline with ECDSA P-256...'}</p>
      </div>`);
    await new Promise((r) => setTimeout(r, 600));
    queueBackgroundSync();
    if (wallet.online) await wallet.sync({ timeout: 2500 }).catch(() => {});
    go(`#/success/${encodeURIComponent(txn.id)}`);
  });
}

async function payPicker() {
  const contacts = await wallet.listContacts();
  render(view, html`
    <section class="pad">
      <h1 class="h1">Who are you paying?</h1>
      <form id="to-form" autocomplete="off">
        <label class="field"><span>Recipient ID</span>
          <input id="to-id" class="mono" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" maxlength="20"></label>
        <p class="err" id="to-err" role="alert"></p>
        <button class="btn primary block" type="submit">Continue</button>
      </form>
      <a class="btn secondary block" href="#/scan">${icon('scan')}Scan a QR code</a>
    </section>
    ${contacts.length ? html`<h2 class="sec">People you’ve paid</h2><ul>${contacts.slice(0, 8).map((c) => contactRow(c))}</ul>` : ''}`);
  $('#to-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = P.normalizeId($('#to-id').value);
    if (!P.isValidId(id)) { $('#to-err').textContent = 'That ID doesn’t look right. IDs have 12 letters and numbers.'; return; }
    if (id === wallet.profile.id) { $('#to-err').textContent = 'That’s your own ID.'; return; }
    go('#/pay?to=' + id);
  });
}

/* ====================================================================== receive */

async function viewReceive() {
  setChrome({ title: 'Receive', back: '#/home' });
  const me = wallet.profile;
  render(view, html`
    <section class="pad center">
      <p class="muted">Show this code. Anyone with OfflinePay can scan it to pay you.</p>
      <div class="qr-wrap"><canvas class="qr" id="req-qr" aria-label="Your payment request code"></canvas></div>
      <p class="payee-name">${me.name}</p>
      <p class="muted" id="req-caption">Any amount</p>
      <p class="pad-top"><button class="idchip" data-action="copy-id" type="button" aria-label="Copy your ID">${icon('copy')}<span>${idText(me.id)}</span></button></p>
      <label class="field"><span>Ask for a specific amount (optional)</span>
        <input id="req-amt" inputmode="decimal" autocomplete="off" placeholder="${fmtPlain(0)}"></label>
      <a class="btn secondary block" href="#/scan">${icon('scan')}Scan a payment code</a>
    </section>`);
  const canvas = $('#req-qr');
  const input = $('#req-amt');
  const paint = () => {
    const amount = parseMoney(input.value) || 0;
    drawQR(canvas, P.encodeRequest({ id: me.id, name: me.name, amount, currency: CONFIG.currency }), { ecc: 'M', px: 360 });
    $('#req-caption').textContent = amount ? `Asking for ${fmtMoney(amount)}` : 'Any amount';
  };
  input.addEventListener('input', paint);
  paint();
}

/* ====================================================================== history + receipt */

async function viewHistory({ token }) {
  setChrome({ title: 'Activity', nav: 'history' });
  render(view, html`<div id="hist"></div>`);
  refresh = async () => {
    const all = await wallet.listTxns();
    if (token !== routeToken) return;
    const list = historyFilter === 'pending' ? all.filter((t) => t.status === 'pending') : all;
    render($('#hist'), html`
      <div class="filters">
        <button class="pill ${historyFilter === 'all' ? 'on' : ''}" data-action="filter" data-f="all" type="button">All</button>
        <button class="pill ${historyFilter === 'pending' ? 'on' : ''}" data-action="filter" data-f="pending" type="button">Pending</button>
      </div>
      ${list.length
        ? html`<ul>${list.map((t) => txRow(t))}</ul>`
        : html`<p class="empty">${historyFilter === 'pending' ? 'Nothing is waiting to settle.' : 'No payments yet.'}</p>`}`);
  };
  await refresh();
}

async function viewTx({ arg, token }) {
  const id = decodeURIComponent(arg);
  setChrome({ title: 'Payment', back: '#/home' });
  refresh = async () => {
    const t = await wallet.getTxn(id);
    if (token !== routeToken) return;
    if (!t) {
      render(view, html`<section class="pad"><p>We couldn’t find that payment.</p><p class="pad-top"><a class="btn secondary block" href="#/home">Back to home</a></p></section>`);
      return;
    }
    render(view, receiptTemplate(t));
    mountReceipt(t);
  };
  await refresh();
}

function receiptTemplate(t) {
  const out = t.dir === 'out';
  const topup = t.dir === 'topup';
  const who = personName(t) || 'Unknown';
  const state = t.status;
  const title = topup ? 'Money added'
    : out ? (state === 'settled' ? `Paid to ${who}` : state === 'failed' ? `Payment to ${who}` : `Sending to ${who}`)
    : (state === 'settled' ? `Received from ${who}` : `From ${who}`);
  const headline = state === 'settled' ? (topup ? 'Added to your balance' : out ? 'Payment complete' : 'Payment received')
    : state === 'failed' ? 'Payment failed'
    : out ? 'Saved on this phone' : 'Code checked on this phone';
  let detail;
  if (state === 'pending') {
    detail = out
      ? (wallet.online ? 'Sending it now…' : 'It will be sent automatically when you’re online. The receiver can also deliver it using the code below.')
      : 'The signature is valid, but this money isn’t yours to spend until it settles. That happens when either phone is online.';
  } else if (state === 'failed') detail = t.reason || 'The payment could not be completed.';
  else detail = whenLabel(t.settledAt || t.ts);
  const badge = state === 'settled' ? icon('check') : state === 'failed' ? icon('x') : icon('clock');

  return html`
    <article class="receipt ${state}">
      <div class="rc-top">
        <div class="rc-badge">${badge}</div>
        <p class="rc-title">${title}</p>
        <p class="rc-amount">${fmtMoney(t.amount)}</p>
        <p class="rc-status">${headline}</p>
        <p class="rc-note">${detail}</p>
      </div>
      <div class="perf"><i></i><i></i></div>
      <dl class="rc-rows">
        ${topup ? '' : html`<div><dt>${out ? 'To' : 'From'}</dt><dd>${who}<br><span class="mono muted">${idText(t.peer)}</span></dd></div>`}
        ${t.note && !topup ? html`<div><dt>Note</dt><dd>${t.note}</dd></div>` : ''}
        <div><dt>Date</dt><dd>${whenLabel(t.ts)}</dd></div>
        <div><dt>Reference</dt><dd class="mono">${String(t.id).replace(/^topup:/, '').slice(0, 10)}</dd></div>
      </dl>
      ${state === 'pending' && out && t.order ? proofBlock(t) : ''}
    </article>
    <div class="pad"><a class="btn primary block" href="#/home">Done</a></div>`;
}

function proofBlock(t) {
  return html`
    <div class="perf"><i></i><i></i></div>
    <div class="stub">
      <h2>Show this code to ${t.peerName || 'the receiver'}</h2>
      <p class="fine">Their phone checks the signature without internet. The code is valid for 24 hours.</p>
      <div class="qr-wrap"><canvas class="qr" id="proof-qr" aria-label="Payment code"></canvas></div>
      <div class="row">
        <button class="btn secondary" data-action="copy-proof" type="button">${icon('copy')}Copy code</button>
        ${navigator.share ? html`<button class="btn secondary" data-action="share-proof" type="button">${icon('share')}Share</button>` : ''}
      </div>
      <details><summary>Show code as text</summary>
        <textarea class="code" id="proof-text" readonly rows="4" aria-label="Payment code as text"></textarea></details>
    </div>`;
}

function mountReceipt(t) {
  proofCode = '';
  const canvas = $('#proof-qr');
  if (!canvas) return;
  proofCode = P.encodeProof(t.order);
  try { drawQR(canvas, proofCode, { ecc: 'L', px: 360 }); } catch (e) { console.error(e); }
  $('#proof-text').value = proofCode;
}
/* ====================================================================== Google Pay Animated Payment Success ====================================================================== */

async function viewSuccess({ arg }) {
  const id = decodeURIComponent(arg);
  setChrome({ top: true, title: 'Payment Status', back: '#/home' });
  const t = await wallet.getTxn(id);
  if (!t) { go('#/home'); return; }

  const isOnline = t.status === 'settled';
  const who = personName(t) || 'Recipient';

  render(view, html`
    <section class="payment-result success">
      <canvas class="confetti-canvas" id="confetti-canvas"></canvas>
      <div class="result-icon">
        <svg class="result-check-svg" viewBox="0 0 52 52">
          <circle class="result-circle-bg" cx="26" cy="26" r="25"/>
          <path class="result-check-path" d="M14 27l8 8 16-16"/>
        </svg>
      </div>
      <div class="result-amount">${fmtMoney(t.amount)}</div>
      <div class="result-status">${isOnline ? 'Payment Successful' : 'Saved & Signed Offline'}</div>
      <div class="result-recipient">To ${who}</div>

      <!-- Google Pay Style Scratch Card Teaser -->
      <div style="width:100%;max-width:320px;margin-bottom:20px;background:linear-gradient(135deg,rgba(99,102,241,0.18),rgba(139,92,246,0.18));border:1px solid rgba(139,92,246,0.4);border-radius:18px;padding:14px;display:flex;align-items:center;gap:12px;cursor:pointer" id="claim-scratch">
        <span style="font-size:28px">🎁</span>
        <div style="flex:1;text-align:left">
          <div style="font-weight:700;font-size:14px;color:#FCD34D">You won a GPay Reward!</div>
          <div class="fine" style="color:var(--ink-2)">Tap to scratch and reveal surprise</div>
        </div>
        <button class="pill on" type="button" style="padding:6px 12px;font-size:12px">Scratch</button>
      </div>

      <div class="result-done" style="display:flex;flex-direction:column;gap:10px;width:100%">
        <a class="btn primary block" href="#/tx/${encodeURIComponent(t.id)}">View Receipt & QR Code</a>
        <a class="btn secondary block" href="#/home">Back to Home</a>
      </div>
    </section>`);

  // Audio chime
  playSuccessChime();

  // Launch confetti
  const canvas = $('#confetti-canvas');
  if (canvas) launchConfetti(canvas);

  // Scratch card click
  const scratchBanner = $('#claim-scratch');
  if (scratchBanner) {
    scratchBanner.addEventListener('click', () => {
      const rewards = [
        { title: '₹25 Cashback Won! 🪙', sub: 'Demo reward added to wallet' },
        { title: 'ACID Master 🏆', sub: 'Verified by atomic SQL transactions' },
        { title: 'Cryptographic Hero 🔐', sub: 'ECDSA P-256 Curve signature verified' },
        { title: 'Offline Pay Champion ⚡', sub: 'Zero-internet transaction completed' },
      ];
      const r = rewards[Math.floor(Math.random() * rewards.length)];
      openScratchCard({ reward: r, title: 'Google Pay Reward' });
    });
  }
}

/* ====================================================================== DBMS Explorer Screen ====================================================================== */

async function viewDbms() {
  setChrome({ title: 'SQL Database', back: '#/home' });
  render(view, html`
    <section class="dbms-header">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h1 style="font-size:20px;font-weight:700;display:flex;align-items:center;gap:8px">
          ${icon('database')}<span style="background:linear-gradient(135deg,#60A5FA,#A78BFA);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DBMS Explorer</span>
        </h1>
        <span class="acid-badge" id="dbms-engine">SQL Database</span>
      </div>
      <p class="fine" style="color:var(--ink-2)">Live database connected to the server. User accounts, balances, and confirmed transactions are stored here.</p>
    </section>

    <div class="pad">
      <div id="dbms-stats" class="dbms-grid">
        <div class="dbms-card"><div class="spinner"></div></div>
      </div>

      <div style="background:var(--bg-surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:14px;margin-bottom:16px">
        <div style="font-weight:700;font-size:14px;margin-bottom:6px;display:flex;align-items:center;gap:6px">
          🛡️ ACID Properties in OfflinePay
        </div>
        <ul style="font-size:12px;color:var(--ink-2);line-height:1.6;padding-left:14px;list-style:disc">
          <li><strong>Atomicity:</strong> Double-entry debit & credit execute in a single SQL transaction.</li>
          <li><strong>Consistency:</strong> Schema constraints + ECDSA cryptographic check prevent unauthorized balance updates.</li>
          <li><strong>Isolation:</strong> Balance changes run inside atomic SQL transactions.</li>
          <li><strong>Durability:</strong> Confirmed transactions are saved by the configured SQL server.</li>
        </ul>
      </div>

      <h2 class="sec flush" style="margin:16px 0 8px">Interactive SQL Console</h2>
      <div class="query-presets">
        <button class="query-preset-btn" data-sql="SELECT * FROM users">SELECT * FROM users</button>
        <button class="query-preset-btn" data-sql="SELECT seq, entry_id, kind, from_id, to_id, amount, status FROM ledger ORDER BY seq DESC LIMIT 10">Recent Ledger</button>
        <button class="query-preset-btn" data-sql="SELECT * FROM users ORDER BY created_at DESC">All Users</button>
      </div>

      <div class="query-box">
        <textarea id="sql-input" class="mono" rows="3" style="font-size:13px;width:100%;border-radius:var(--radius-sm);padding:10px;background:var(--bg-card);border:1px solid var(--line);color:var(--ink)" placeholder="Enter SQL query...">SELECT seq, entry_id, kind, from_id, to_id, amount, status FROM ledger ORDER BY seq DESC LIMIT 10</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="fine muted" id="sql-count"></span>
          <button class="btn primary" id="sql-run" type="button" style="min-height:40px;padding:0 20px;font-size:14px">Run SQL</button>
        </div>
        <div id="sql-result" class="dbms-table-wrap"></div>
      </div>
    </div>
  `);

  async function loadOverview() {
    try {
      const data = await wallet.getDbmsOverview();
      const stats = data.stats || {};
      $('#dbms-engine').textContent = data.engine || 'SQL Database';
      render($('#dbms-stats'), html`
        <div class="dbms-card">
          <div class="dbms-card-val">${stats.usersCount ?? 0}</div>
          <div class="dbms-card-lbl">Registered Users</div>
        </div>
        <div class="dbms-card">
          <div class="dbms-card-val">${stats.ledgerCount ?? 0}</div>
          <div class="dbms-card-lbl">Ledger Entries</div>
        </div>
        <div class="dbms-card">
          <div class="dbms-card-val">${fmtMoney(stats.totalBalance || 0)}</div>
          <div class="dbms-card-lbl">Total Circulation</div>
        </div>
        <div class="dbms-card">
          <div class="dbms-card-val" style="font-size:16px;color:var(--green)">${data.journalMode?.toUpperCase() || 'WAL'}</div>
          <div class="dbms-card-lbl">Database Engine</div>
        </div>
      `);
    } catch {
      render($('#dbms-stats'), html`<p class="fine muted center pad">Database offline or server syncing...</p>`);
    }
  }

  async function runQuery(sql) {
    const resBox = $('#sql-result');
    const countBox = $('#sql-count');
    render(resBox, html`<div class="center pad"><div class="spinner"></div></div>`);
    try {
      const data = await wallet.runDbmsQuery(sql);
      const rows = data.rows || [];
      countBox.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} returned`;
      if (rows.length === 0) {
        render(resBox, html`<div class="empty">No rows returned.</div>`);
        return;
      }
      const cols = Object.keys(rows[0]);
      render(resBox, html`
        <table class="dbms-table">
          <thead><tr>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead>
          <tbody>
            ${rows.map((r) => html`<tr>${cols.map((c) => html`<td>${r[c] !== null && r[c] !== undefined ? String(r[c]) : '<span class="muted">NULL</span>'}</td>`)}</tr>`)}
          </tbody>
        </table>
      `);
    } catch (e) {
      countBox.textContent = '';
      render(resBox, html`<div class="pad" style="color:var(--red);font-size:13px">${e.message || 'SQL execution failed'}</div>`);
    }
  }

  $('#sql-run').addEventListener('click', () => runQuery($('#sql-input').value));
  document.querySelectorAll('.query-preset-btn').forEach((b) => {
    b.addEventListener('click', () => {
      $('#sql-input').value = b.dataset.sql;
      runQuery(b.dataset.sql);
    });
  });

  await loadOverview();
  runQuery($('#sql-input').value);
}

/* ====================================================================== me ====================================================================== */

async function viewMe() {
  setChrome({ title: 'Me', nav: 'me' });
  const me = wallet.profile;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const persisted = await (navigator.storage?.persisted?.() ?? Promise.resolve(false)).catch(() => false);
  render(view, html`
    <section class="me-head">
      <span class="av lg" data-c="${hueSlot(me.id)}">${initials(me.name)}</span>
      <div><p class="payee-name">${me.name}</p><p class="mono muted">${idText(me.id)}</p></div>
    </section>
    <ul class="menu">
      <li><a href="#/dbms">${icon('database')}SQL DBMS Explorer</a></li>
      <li><button data-action="toggle-offline" type="button">${icon(wallet.online ? 'wifiOff' : 'wifi')}Simulate ${wallet.online ? 'Offline' : 'Online'} Mode</button></li>
      <li><button data-action="copy-id" type="button">${icon('copy')}Copy my ID</button></li>
      <li><button data-action="rename" type="button">${icon('edit')}Change my name</button></li>
      <li><button data-action="sync" type="button">${icon('refresh')}Sync now</button></li>
      <li><button data-action="lock" type="button">${icon('lock')}Lock the app</button></li>
      ${installEvent && !standalone ? html`<li><button data-action="install" type="button">${icon('download')}Install on this device</button></li>` : ''}
    </ul>
    ${ios && !standalone ? html`<p class="about pad-top">To install on iPhone: tap Share, then “Add to Home Screen”. Installed apps keep their data longer on iOS.</p>` : ''}
    <h2 class="sec">How offline mode works</h2>
    <div class="about">
      <p>Payments are signed on this phone with a key that only your PIN can unlock. With no connection they’re saved here as pending.</p>
      <p>The receiver’s phone can check the signed code on the spot. Either phone delivers it later, and the server settles it exactly once.</p>
      <p>You can only spend money that has already settled, so you can’t overspend while offline.</p>
    </div>
    <div class="pad">
      <p class="fine">${persisted ? 'Storage is protected from automatic clean-up.' : 'The browser may clear this data if the device runs low on space.'}</p>
      <button class="btn danger block pad-top" data-action="erase" type="button">${icon('trash')}Erase wallet from this device</button>
    </div>`);
}

/* ====================================================================== sheets */

function openAddMoney() {
  if (wallet.health && wallet.health.topup === false) { toast('Adding demo money is turned off on this server.'); return; }
  if (!wallet.online) { toast('Adding money needs a connection.'); return; }
  const presets = CONFIG.topupPresets.map((n) => n * 10 ** CONFIG.decimals);
  openSheet(html`
    <h2 class="sheet-title">Add money</h2>
    <p class="muted">Demo money for testing. Nothing real is charged.</p>
    <div class="presets">${presets.map((m) => html`<button class="btn secondary" data-amt="${fmtPlain(m)}" type="button">${fmtMoney(m)}</button>`)}</div>
    <label class="field"><span>Other amount</span><input id="top-amt" inputmode="decimal" autocomplete="off" placeholder="${fmtPlain(0)}"></label>
    <p class="err" id="top-err" role="alert"></p>
    <button class="btn primary block" id="top-go" type="button">Add money</button>`,
  {
    label: 'Add money',
    onMount: (el, close) => {
      const input = el.querySelector('#top-amt');
      el.querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.amt; }));
      el.querySelector('#top-go').addEventListener('click', async (e) => {
        const amount = parseMoney(input.value);
        const err = el.querySelector('#top-err');
        if (!amount) { err.textContent = 'Choose or enter an amount.'; return; }
        e.target.disabled = true;
        try {
          await wallet.topUp(amount);
          close();
          toast(`${fmtMoney(amount)} added`);
        } catch (ex) {
          err.textContent = ex.code === 'OFFLINE' ? 'Adding money needs a connection.' : ex.message;
          e.target.disabled = false;
        }
      });
    },
  });
}

function openRename() {
  openSheet(html`
    <h2 class="sheet-title">Change your name</h2>
    <label class="field"><span>Shown to people you pay</span>
      <input id="rn" maxlength="${CONFIG.maxNameLength}" value="${wallet.profile.name}" autocomplete="off"></label>
    <p class="err" id="rn-err" role="alert"></p>
    <button class="btn primary block" id="rn-go" type="button">Save</button>`,
  {
    label: 'Change name',
    onMount: (el, close) => {
      const input = el.querySelector('#rn');
      input.focus(); input.select();
      el.querySelector('#rn-go').addEventListener('click', async () => {
        try { await wallet.rename(input.value); close(); toast('Name updated'); route(); wallet.sync(); }
        catch (e) { el.querySelector('#rn-err').textContent = e.message; }
      });
    },
  });
}

async function openErase() {
  const s = await wallet.summary();
  openSheet(html`
    <h2 class="sheet-title">Erase this wallet?</h2>
    <p class="muted">This deletes your keys and history from this device. Money in the wallet can’t be recovered without the keys.${s.pending ? ` You have ${s.pending} pending payment${s.pending === 1 ? '' : 's'} that would be lost.` : ''}</p>
    <label class="field"><span>Type ERASE to confirm</span><input id="er" autocapitalize="characters" autocomplete="off"></label>
    <button class="btn danger block" id="er-go" type="button" disabled>Erase wallet</button>`,
  {
    label: 'Erase wallet',
    onMount: (el, close) => {
      const input = el.querySelector('#er');
      const go2 = el.querySelector('#er-go');
      input.addEventListener('input', () => { go2.disabled = input.value.trim().toUpperCase() !== 'ERASE'; });
      go2.addEventListener('click', async () => {
        await wallet.reset();
        close();
        go('#/home');
        route();
      });
    },
  });
}

/* ====================================================================== actions */

async function manualSync() {
  if (syncingNow) return;
  syncingNow = true;
  paintStatus();
  await wallet.ping();
  statusKnown = true;
  const r = await wallet.sync();
  syncingNow = false;
  paintStatus();
  toast(r.ok ? 'Up to date.' : r.offline ? 'Still offline. Your payments are safe on this phone.' : r.error || 'Couldn’t sync.');
}

const ACTIONS = {
  'copy-id': async () => toast((await copyText(idText(wallet.profile.id))) ? 'ID copied' : 'Couldn’t copy. Select the ID and copy it by hand.'),
  'copy-proof': async () => toast((await copyText(proofCode)) ? 'Code copied' : 'Couldn’t copy. Open “Show code as text”.'),
  'share-proof': async () => { try { await navigator.share({ title: 'Payment code', text: proofCode }); } catch { /* cancelled */ } },
  'add-money': openAddMoney,
  'paste-code': openPasteCode,
  'toggle-offline': () => {
    const isOff = wallet.isSimulatedOffline();
    wallet.setSimulatedOffline(!isOff);
    paintStatus();
    refresh?.();
    toast(!isOff ? '⚡ Offline mode simulated! Payments will save locally.' : '🌐 Back online! Syncing payments...', 3000);
  },
  rename: openRename,
  erase: openErase,
  sync: manualSync,
  lock: () => wallet.lockNow(),
  filter: (el) => { historyFilter = el.dataset.f; refresh?.(); },
  install: async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    route();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  const fn = el && ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});

/* ====================================================================== background work */

async function queueBackgroundSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    await reg?.sync?.register('opay-flush'); // Chrome: deliver pending orders even if the app is closed
  } catch { /* not supported: the app delivers them next time it is open */ }
}

async function heartbeat() {
  if (document.hidden || !wallet.profile) return;
  await wallet.ping();
  statusKnown = true;
  const s = await wallet.summary();
  const stale = wallet.isUnlocked() && Date.now() - s.lastSyncAt > 60_000;
  if (wallet.online && (s.pending || stale)) wallet.sync();
  if (wallet.isUnlocked() && Date.now() - lastActive > CONFIG.idleLockSec * 1000) wallet.lockNow();
  paintStatus();
}

let changeTimer = 0;
let prevOnline = false;
let wasUnlocked = false;
function onWalletChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    paintStatus();
    const unlocked = wallet.isUnlocked();
    if (wallet.profile && wasUnlocked && !unlocked) route(); // it just locked
    wasUnlocked = unlocked;
    if (wallet.online && !prevOnline) wallet.sync(); // connection came back: deliver pending payments
    prevOnline = wallet.online;
    refresh?.();
  }, 60);
}

function startBackgroundTasks() {
  setInterval(heartbeat, 15_000);
  window.addEventListener('online', async () => {
    paintStatus();
    toast('🌐 Internet reconnected! Syncing payments...', 3000);
    await heartbeat();
  });
  window.addEventListener('offline', () => {
    wallet.setOffline();
    paintStatus();
    refresh?.();
    toast('⚡ Internet disconnected. Switched to offline mode.', 3000);
  });
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (wallet.isUnlocked() && Date.now() - hiddenAt > CONFIG.autoLockSec * 1000) wallet.lockNow();
    heartbeat();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
  window.addEventListener('appinstalled', () => { installEvent = null; });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const firstTime = !navigator.serviceWorker.controller;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) toast('A new version is ready. Reload to use it.', 6000);
      });
    });
    await navigator.serviceWorker.ready;
    if (firstTime) toast('Saved for offline use. This app now works without internet.', 4500);
  } catch (e) {
    console.warn('Service worker not registered:', e);
  }
}

/* ====================================================================== start */

async function boot() {
  if (!P.cryptoAvailable) { viewInsecure(); return; }
  try {
    wallet = createWalletClient({ db: openDatabase(), apiBase: '' });
    await wallet.init();
  } catch (e) {
    console.error(e);
    render(view, html`<section class="welcome"><h1>Storage unavailable</h1><p class="lede">This browser isn’t letting the app save data. Private browsing can cause this. Try a normal window.</p></section>`);
    return;
  }
  wallet.subscribe(onWalletChange);
  registerServiceWorker();
  window.addEventListener('hashchange', route);
  startBackgroundTasks();
  await route();
}

boot();
