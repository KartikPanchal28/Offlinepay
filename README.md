# OfflinePay

A Google Pay–style wallet that runs in the browser (a Progressive Web App) and keeps working with no internet.
Plain JavaScript in the browser, a small Node.js server, and MySQL for server-side account and payment records.

> **Play money only.** Nothing here moves real money. "Add money" is a demo faucet. Real payments need a licensed
> payment provider or bank behind the server (see [Going further](#going-further)).

## What you get

- **Wallet on your device.** Keys are created in the browser and locked with a 6-digit PIN. No sign-up.
- **Works offline.** After the first visit the whole app loads from a service-worker cache: open it, pay, receive and browse history with no connection.
- **Offline payments between two phones.** The payer's phone signs a payment and shows it as a QR code (or text). The receiver's phone checks the signature on the spot. No internet needed on either side.
- **Syncs by itself.** Pending payments are delivered when a connection returns, from either phone. The server settles each payment exactly once.
- **Honest balances.** You can spend only money that has settled, minus your own pending payments, so you can't overspend while offline.
- Installable, dark mode, QR code generator built in (no library).

## Install and run

1. **Install Node.js 20 or newer** and a local MySQL Server. Check Node with `node -v` and make sure MySQL is running.
2. **Unzip** the project and open a terminal in the `offline-pay` folder.
3. **Install server dependencies** with `npm install`.
4. **Configure MySQL.** Copy `.env.example` to `.env` and enter your local MySQL username and password there. Defaults are host `127.0.0.1`, port `3306`, user `root`, and database `offlinepay`. The app creates its database and tables on first start; the MySQL account must be allowed to create databases. `.env` is ignored by Git.
5. **Start the server.**
   ```
   npm start
   ```
   (the same as `node server.js`). You should see `This computer: http://localhost:3000`.
6. **Open <http://localhost:3000>** in Chrome or Edge. Enter your name and choose a 6-digit PIN twice.
   Wait for the message *"Saved for offline use"*. From that moment the app works with no network.
7. Tap **Add money** and pick an amount.

> Open the app **once while online** before going offline. A browser can't run a web app it has never loaded.

## Try the offline mode (2 minutes)

You need two "phones". On one computer use two browser profiles, or one normal window and one Incognito window.

1. Window A: create **Alice** and add money. Window B: create **Bob**. In window B tap Bob's ID chip on Home to copy his ID.
2. **Stop the server** (Ctrl+C in the terminal). This is "no internet".
3. Window A: reload the page (it still opens). Tap **Send**, paste Bob's ID, enter an amount, enter the PIN.
   Alice sees a **pending** receipt with a QR code and a "Show code as text" box. Her spendable balance already dropped.
4. Window B: reload, tap **Scan**, then **Enter a code instead**, paste the code. Bob sees **"Code checked on this phone"**. The signature was verified with no server.
5. **Start the server again** (`npm start`). Within about 15 seconds both windows sync by themselves (or tap the status chip at the top right). The payment turns **settled** for both.

## Use it on a phone

Camera access, service workers and the crypto the wallet uses only work on **HTTPS pages or `localhost`**.
A plain `http://192.168.x.x` address will show "Secure page needed". Pick one:

- **Android + USB cable (easiest).** On the phone enable USB debugging. In desktop Chrome open `chrome://inspect/#devices`,
  click *Port forwarding*, add `3000` → `localhost:3000`, then open `http://localhost:3000` in Chrome on the phone.
- **HTTPS tunnel.** Run a tunnel such as `npx cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`
  and open the `https://…` address on each phone. A wallet belongs to one web address, so keep using the same address.
- **Deploy it.** Run `npm start` on a host with Node 20+, HTTPS, and MySQL. The host's `PORT` variable is respected.

Then, on each phone, use the browser menu → **Install app** / **Add to Home Screen**.
On iPhone, installing to the Home Screen also keeps your data longer.

**Scanning QR codes with the camera** uses the browser's built-in detector (Chrome and Edge on Android and many desktops).
Where it is missing (iPhone Safari, Firefox) use **Enter a code instead**, or add the optional jsQR library: see `public/js/vendor/README.txt`.

## Settings

Edit **`public/js/config.js`**, then restart the server (it is shared by the server and the app):

| Setting | Default | Meaning |
|---|---|---|
| `CURRENCY` | `USD` | Any ISO code (`INR`, `EUR`, `GBP`, ...). Decimal places follow the currency. |
| `maxPaymentMinor` | 1000.00 | Largest single payment |
| `maxTopupMinor` | 500.00 | Largest single demo "Add money" |
| `proofMaxAgeSec` | 24 h | A receiver refuses payment codes older than this |
| `autoLockSec` / `idleLockSec` | 90 s / 5 min | Lock after this long in the background / without touching the screen |

Server options: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `PORT` (3000), `DEMO_TOPUP=0` (turn off Add money), `TLS_KEY`, and `TLS_CERT`. Set `DB_ENGINE=sqlite` to use the legacy SQLite backend instead.

The app's **DBMS** screen shows the live database. For MySQL Workbench or the CLI, run `sql/inspect.sql` (for example, `mysql -u root -p offlinepay < sql/inspect.sql`). When MySQL is empty and `data/offlinepay.db` exists, startup imports its users and ledger once without deleting the old file. See `sql/schema.mysql.sql` for the MySQL tables.

Changed a file in `public/`? `node server.js` fingerprints the files and gives the service worker a new version automatically,
so the next reload fetches everything again and shows "A new version is ready". If you host the files elsewhere, set `VERSION` in `public/sw.js` by hand and change it with every edit.

## How it works

1. A payment is a small **order signed with your private key** (ECDSA P-256, WebCrypto). Signing needs no network and anyone can verify the result.
2. The order goes into your **outbox** and shows as *pending*. It is delivered automatically when a connection exists
   (when the app is open, or through Background Sync in Chrome even if it is closed).
3. The **server verifies the signature and settles each order once** (orders are idempotent by id), so it doesn't matter which phone delivers it or how many times.
4. For two phones with no connection, the payer's phone shows the signed order as a **QR code**. The receiver's phone verifies it immediately and delivers it later.
5. Your wallet ID is derived from your public key (12 characters with a checksum), so no server is needed to create an account.
6. Your private key is stored **encrypted with your PIN** (PBKDF2 → AES-GCM). Wrong PINs are rate-limited.

```
server.js              server: serves public/, settles orders, keeps the ledger (data/db.json)
public/
  index.html, css/     the app shell and styles
  sw.js                service worker: offline cache + background delivery
  manifest.webmanifest installable-app settings
  js/protocol.js       IDs, signed orders, payment codes (shared by app and server)
  js/wallet.js         all wallet logic: PIN, payments, outbox, sync (no DOM)
  js/crypto.js db.js   PIN-encrypted key, IndexedDB storage
  js/qr.js             QR code generator
  js/app.js ui.js scanner.js format.js config.js errors.js   screens and helpers
test/                  npm test: 24 tests, including offline scenarios against a real server
tools/browser-check.mjs  optional real-browser run (needs Playwright)
```

## Tests

```
npm test
```

Covers signatures and tampering, ID checksums, PIN lock-out, payments online and offline, duplicate delivery,
unfunded senders, expired and misaddressed codes, replayed requests, path traversal, server restart, and money conservation.
Optional: `tools/browser-check.mjs` drives two real browsers through creating wallets, stopping the server, paying offline and syncing (`npm i -D playwright && npx playwright install chromium`).

## Going further

This is a working prototype, not a bank. Before real money, think about:

- **A real payment rail.** Replace the balance changes in `settleOrder()` (server.js) with calls to a licensed provider or bank API
  (for example Stripe, Razorpay or a UPI/bank API), and add identity checks (KYC), fraud monitoring and the regulatory approvals your country requires.
- **Offline double-spend.** A receiver who accepts a code offline can't know the payer really has the money. A modified app could sign more than its balance;
  the server then marks the payment *failed*. Real offline schemes limit the risk with small per-payment limits, a pre-funded offline allowance the server signs, and hardware-backed keys.
- **Key recovery.** If the PIN is forgotten or browser data is cleared, the wallet is gone. Add an encrypted backup or passkeys.
- **Identity.** Names are self-declared. The 12-character ID is what identifies a person, so always check it on the confirmation screen.
- **Hardening.** 6-digit PINs can be brute-forced by someone who copies the browser's storage (200,000 PBKDF2 rounds slow this down). Add rate limiting and monitoring to the server.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Secure page needed" | Use `http://localhost:3000` on the computer, or HTTPS (see *Use it on a phone*). |
| Camera won't start | Allow camera access for the site; use **Enter a code instead** if the browser has no QR detector. |
| App shows old screens after an edit | Reload twice, or in DevTools → Application → Service Workers → *Unregister*, then *Clear site data*. |
| Offline page is blank the very first time | The app must be opened once online so it can save itself. |
| Status says "Offline" while online | The server isn't reachable from that device. Check the address and that `npm start` is running. |
