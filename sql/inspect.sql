-- OfflinePay MySQL inspection queries.
-- Example (PowerShell): mysql -u root -p offlinepay < sql/inspect.sql

-- Database tables and indexes
SHOW TABLES;
SHOW CREATE TABLE users;
SHOW CREATE TABLE ledger;

-- Registered accounts and current settled balances (minor currency units).
SELECT id, name, pub AS public_key, balance, created_at
FROM users
ORDER BY created_at DESC;

-- Complete ledger with participant names.
SELECT
  l.seq,
  l.entry_id,
  l.kind,
  l.from_id,
  sender.name AS from_name,
  l.to_id,
  recipient.name AS to_name,
  l.amount,
  l.note,
  l.status,
  l.reason,
  FROM_UNIXTIME(l.ts) AS occurred_at,
  FROM_UNIXTIME(l.settled_at / 1000) AS recorded_at
FROM ledger AS l
LEFT JOIN users AS sender ON sender.id = l.from_id
LEFT JOIN users AS recipient ON recipient.id = l.to_id
ORDER BY l.seq DESC;

-- Totals by transaction type and status.
SELECT kind, status, COUNT(*) AS transaction_count, SUM(amount) AS total_minor_units
FROM ledger
GROUP BY kind, status
ORDER BY kind, status;

-- Transactions rejected for insufficient settled balance.
SELECT entry_id, from_id, to_id, amount, reason,
       FROM_UNIXTIME(settled_at / 1000) AS recorded_at
FROM ledger
WHERE status = 'failed'
ORDER BY seq DESC;

-- Check table health.
CHECK TABLE users, ledger;
