// Shared by the browser app AND the Node server. Edit here, in one place.

const CURRENCY = 'USD'; // ISO 4217 code, e.g. 'USD', 'EUR', 'INR', 'GBP'
const DECIMALS = new Intl.NumberFormat('en', { style: 'currency', currency: CURRENCY })
  .resolvedOptions().maximumFractionDigits;
const minor = (major) => Math.round(major * 10 ** DECIMALS);

export const CONFIG = {
  appName: 'OfflinePay',
  currency: CURRENCY,
  decimals: DECIMALS,
  locale: undefined, // undefined = use the browser's language for number formatting

  // Limits (stored and compared as integer "minor units": cents, paise, ...)
  maxPaymentMinor: minor(1000), // largest single payment
  maxTopupMinor: minor(500), // largest single "add money" (demo) request
  topupPresets: [10, 50, 100, 500], // buttons on the Add money sheet (major units)
  maxNoteLength: 30,
  maxNameLength: 24,

  // Time windows (seconds)
  proofMaxAgeSec: 24 * 3600, // a receiver refuses payment codes older than this
  orderMaxAgeSec: 30 * 24 * 3600, // the server refuses orders older than this
  futureSkewSec: 600, // tolerated clock difference between devices

  // Security / UX
  pinLength: 6,
  autoLockSec: 90, // lock the app after this long in the background
  idleLockSec: 300, // ...or after this long without any touch or key press
};

// Limits handed to the shared validators in protocol.js
export const LIMITS = {
  maxAmount: CONFIG.maxPaymentMinor,
  maxNote: CONFIG.maxNoteLength,
  maxName: CONFIG.maxNameLength,
};
