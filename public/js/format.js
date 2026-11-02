// format.js — money parsing/formatting and small display helpers (no DOM).
import { CONFIG } from './config.js';

const nf = new Intl.NumberFormat(CONFIG.locale, { style: 'currency', currency: CONFIG.currency });
const SCALE = 10 ** CONFIG.decimals;

/** 1250 -> "$12.50" */
export const fmtMoney = (minor) => nf.format(minor / SCALE);

/** 1250 -> "12.50" (for filling an input) */
export const fmtPlain = (minor) => (minor / SCALE).toFixed(CONFIG.decimals);

/** "12.5" -> 1250. Returns null when the text is not a valid amount. */
export function parseMoney(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  const re = new RegExp(`^\\d+(\\.\\d{0,${CONFIG.decimals}})?$`);
  if (!re.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const minorPart = (frac + '0'.repeat(CONFIG.decimals)).slice(0, CONFIG.decimals);
  return Number(whole) * SCALE + Number(minorPart || 0);
}

export const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, CONFIG.maxNameLength);
export const cleanNote = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CONFIG.maxNoteLength);

export function initials(name, fallback = '?') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Stable colour slot 0-7 for an avatar, derived from an id string. */
export function hueSlot(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 8;
}

export function whenLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(CONFIG.locale, { hour: 'numeric', minute: '2-digit' });
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now.getTime() - 86400000);
  if (sameDay(d, now)) return `Today, ${time}`;
  if (sameDay(d, yesterday)) return `Yesterday, ${time}`;
  return d.toLocaleDateString(CONFIG.locale, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
