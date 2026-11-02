// ui.js — small DOM helpers. Everything dynamic goes through `html` so text is escaped by default.
import { CONFIG } from './config.js';

/* ---------- safe templates ---------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(s);
const part = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(part).join('') : v instanceof Raw ? v.s : esc(v));

/** Tagged template: interpolated values are HTML-escaped unless they came from another html`` call. */
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const render = (el, tpl) => { el.innerHTML = String(tpl); };

/* ---------- icons (stroke paths, 24x24) ---------- */

const ICONS = {
  logo: '<circle cx="12" cy="12" r="9"/><path d="M9 15l6-6"/><path d="M10 9h5v5"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"/><path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/><path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M8 12h8"/>',
  send: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  receive: '<path d="M17 7 7 17"/><path d="M16 17H7V8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  share: '<path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  edit: '<path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 3 3L9 18z"/>',
  download: '<path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M5 19.5h14"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/>',
  backspace: '<path d="M9 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5-6z"/><path d="m12.5 10 4 4M16.5 10l-4 4"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
  wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
  sparkle: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
};
export const icon = (name) => raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`);

/* ---------- toast ---------- */

let toastTimer = 0;
export function toast(message, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------- clipboard ---------- */

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'offscreen';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/* ---------- bottom sheet ---------- */

export function openSheet(content, { label = 'Dialog', onMount, onClose, dismissable = true } = {}) {
  document.getElementById('toast').classList.remove('show');
  const root = document.getElementById('overlay');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="grab"></div>${String(content)}</div>`;
  root.appendChild(scrim);
  const sheet = scrim.firstElementChild;
  const previous = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  function close() {
    if (!scrim.isConnected) return;
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    previous?.focus?.();
    onClose?.();
  }
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', (e) => { if (e.target === scrim && dismissable) close(); });
  onMount?.(sheet, close);
  return { el: sheet, close };
}

/** Yes/no question. Resolves true or false (closing the sheet any other way counts as "no"). */
export function confirmSheet({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const { el, close } = openSheet(html`
      <h2 class="sheet-title">${title}</h2>
      <p class="muted">${body}</p>
      <div class="pad-top">
        <button class="btn ${danger ? 'danger' : 'primary'} block" data-yes type="button">${confirmLabel}</button>
        <button class="btn secondary block" data-no type="button">Cancel</button>
      </div>`, { label: title, onClose: () => resolve(answer) });
    el.querySelector('[data-yes]').addEventListener('click', () => { answer = true; close(); });
    el.querySelector('[data-no]').addEventListener('click', () => close());
  });
}

/* ---------- PIN pad ----------
   onPin(pin) is called when all digits are entered. It may throw (the message is shown and the
   person can try again). Resolves { value } on success, or null if cancelled. */

export function pinSheet({ title, subtitle = '', fullscreen = false, cancellable = true, onPin }) {
  return new Promise((resolve) => {
    document.getElementById('toast').classList.remove('show');
    const root = document.getElementById('overlay');
    const scrim = document.createElement('div');
    scrim.className = 'scrim' + (fullscreen ? ' full' : '');
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('');
    scrim.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="grab"></div>
        <div class="pin">
          ${fullscreen ? `<div class="mark pin-mark"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS.logo}</svg></div>` : ''}
          <h2 class="pin-title">${esc(title)}</h2>
          <p class="pin-sub">${esc(subtitle)}</p>
          <div class="dots" aria-hidden="true">${'<i></i>'.repeat(CONFIG.pinLength)}</div>
          <p class="pin-err" role="alert"></p>
          <div class="keys">
            ${digits}
            ${cancellable ? '<button type="button" class="quiet" data-k="cancel">Cancel</button>' : '<span></span>'}
            <button type="button" data-k="0">0</button>
            <button type="button" class="quiet" data-k="back" aria-label="Delete last digit"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS.backspace}</svg></button>
          </div>
        </div>
      </div>`;
    root.appendChild(scrim);

    const pinEl = scrim.querySelector('.pin');
    const dots = [...scrim.querySelectorAll('.dots i')];
    const errEl = scrim.querySelector('.pin-err');
    let pin = '';
    let busy = false;

    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
    const finish = (result) => { document.removeEventListener('keydown', onKey); scrim.remove(); resolve(result); };

    async function submit() {
      busy = true;
      pinEl.classList.add('busy');
      try {
        const value = await onPin(pin);
        finish({ value });
      } catch (e) {
        busy = false;
        pin = '';
        paint();
        pinEl.classList.remove('busy', 'shake');
        void pinEl.offsetWidth; // restart the shake animation
        pinEl.classList.add('shake');
        errEl.textContent = e?.message || 'Something went wrong';
      }
    }

    function press(k) {
      if (busy) return;
      if (k === 'cancel') { if (cancellable) finish(null); return; }
      if (k === 'back') pin = pin.slice(0, -1);
      else if (/^\d$/.test(k) && pin.length < CONFIG.pinLength) { pin += k; errEl.textContent = ''; }
      paint();
      if (pin.length === CONFIG.pinLength) submit();
    }

    function onKey(e) {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Escape') press('cancel');
    }

    scrim.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (b) press(b.dataset.k);
      else if (e.target === scrim && cancellable) finish(null);
    });
    document.addEventListener('keydown', onKey);
  });
}

/* ---------- Google Pay audio chime (Web Audio API) ---------- */

export function playSuccessChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    // Google Pay style bright multi-tone arpeggio: C5 -> E5 -> G5 -> C6
    const freqs = [523.25, 659.25, 783.99, 1046.5];
    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.08);

      gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.08);
      gain.gain.linearRampToValueAtTime(0.28, ctx.currentTime + idx * 0.08 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.08 + 0.42);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.08);
      osc.stop(ctx.currentTime + idx * 0.08 + 0.45);
    });
  } catch { /* AudioContext might be unavailable or restricted */ }
}

/* ---------- Confetti celebration (HTML5 Canvas) ---------- */

export function launchConfetti(canvas) {
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth || 360;
  const h = canvas.offsetHeight || 500;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  // Vibrant GPay colors: Blue, Red, Yellow, Green, Purple, Turquoise
  const colors = ['#4285F4', '#EA4335', '#FBBC05', '#34A853', '#A855F7', '#EC4899', '#06B6D4', '#10B981'];
  const particles = [];
  const count = 90;

  for (let i = 0; i < count; i++) {
    particles.push({
      x: w / 2,
      y: h * 0.38,
      vx: (Math.random() - 0.5) * 16,
      vy: -(Math.random() * 14 + 6),
      size: Math.random() * 9 + 5,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 14,
      opacity: 1,
      shape: Math.random() > 0.35 ? 'rect' : 'circle',
    });
  }

  let animId;
  const startTime = performance.now();

  function renderFrame(now) {
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, w, h);
    let active = false;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.38; // gravity
      p.vx *= 0.985; // friction
      p.rotation += p.rotSpeed;
      if (elapsed > 1400) p.opacity -= 0.018;

      if (p.opacity > 0 && p.y < h + 20) {
        active = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;

        if (p.shape === 'rect') {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    if (active && elapsed < 3500) {
      animId = requestAnimationFrame(renderFrame);
    }
  }

  animId = requestAnimationFrame(renderFrame);
  return () => { cancelAnimationFrame(animId); };
}

/* ---------- Google Pay Style Scratch Card Modal ---------- */

export function openScratchCard({ reward, title = 'Google Pay Reward', badge = '🏆' }) {
  return new Promise((resolve) => {
    const { el, close } = openSheet(html`
      <div class="scratch-modal center">
        <h2 class="sheet-title">${title}</h2>
        <p class="muted">Scratch with your finger or mouse to reveal your reward!</p>
        <div class="scratch-container">
          <div class="scratch-reward">
            <div class="scratch-badge">${badge}</div>
            <div class="scratch-val">${reward.title}</div>
            <div class="fine muted">${reward.sub}</div>
          </div>
          <canvas class="scratch-canvas" width="280" height="180"></canvas>
        </div>
        <button class="btn primary block pad-top" id="scratch-done" type="button">Collect Reward</button>
      </div>`, { label: title, onClose: resolve });

    const canvas = el.querySelector('.scratch-canvas');
    const doneBtn = el.querySelector('#scratch-done');
    const ctx = canvas.getContext('2d');
    let isDrawing = false;
    let scratchedPixels = 0;
    let revealed = false;

    // Draw Google Pay style metallic foil cover
    const grad = ctx.createLinearGradient(0, 0, 280, 180);
    grad.addColorStop(0, '#3B82F6');
    grad.addColorStop(0.5, '#6366F1');
    grad.addColorStop(1, '#8B5CF6');
    ctx.fillStyle = grad;
    ctx.roundRect ? ctx.roundRect(0, 0, 280, 180, 16) : ctx.rect(0, 0, 280, 180);
    ctx.fill();

    // Add pattern / text on top of foil
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 16px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✨ SCRATCH HERE ✨', 140, 95);
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('DBMS Mini Project Reward', 140, 120);

    function scratch(x, y) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fill();
      scratchedPixels++;

      if (scratchedPixels > 25 && !revealed) {
        revealed = true;
        canvas.style.transition = 'opacity 0.5s ease-out';
        canvas.style.opacity = '0';
        playSuccessChime();
        setTimeout(() => { canvas.style.display = 'none'; }, 500);
      }
    }

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
      };
    }

    canvas.addEventListener('mousedown', (e) => { isDrawing = true; const p = getPos(e); scratch(p.x, p.y); });
    canvas.addEventListener('mousemove', (e) => { if (isDrawing) { const p = getPos(e); scratch(p.x, p.y); } });
    window.addEventListener('mouseup', () => { isDrawing = false; });

    canvas.addEventListener('touchstart', (e) => { isDrawing = true; const p = getPos(e); scratch(p.x, p.y); }, { passive: true });
    canvas.addEventListener('touchmove', (e) => { if (isDrawing) { const p = getPos(e); scratch(p.x, p.y); } }, { passive: true });
    window.addEventListener('touchend', () => { isDrawing = false; });

    doneBtn.addEventListener('click', close);
  });
}
