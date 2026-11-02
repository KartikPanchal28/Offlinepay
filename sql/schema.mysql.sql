-- OfflinePay MySQL schema. The app creates the database and tables on startup.
CREATE DATABASE IF NOT EXISTS offlinepay CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
USE offlinepay;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(80) NOT NULL DEFAULT '',
  pub VARCHAR(100) NOT NULL DEFAULT '',
  balance BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ledger (
  seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entry_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  kind VARCHAR(20) NOT NULL DEFAULT '',
  from_id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  note VARCHAR(500) NOT NULL DEFAULT '',
  ts BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT '',
  reason VARCHAR(255) NOT NULL DEFAULT '',
  settled_at BIGINT NOT NULL DEFAULT 0,
  order_json LONGTEXT NULL,
  INDEX idx_ledger_from (from_id),
  INDEX idx_ledger_to (to_id),
  CONSTRAINT fk_ledger_from FOREIGN KEY (from_id) REFERENCES users(id),
  CONSTRAINT fk_ledger_to FOREIGN KEY (to_id) REFERENCES users(id)
) ENGINE=InnoDB;
