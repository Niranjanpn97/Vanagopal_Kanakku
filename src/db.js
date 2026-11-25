'use strict';
// SQLite via Node's built-in driver (no native build step needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS flats (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- e.g. F1, S3
  owner_name  TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

-- One row per ledger line, mirroring the Income_Expense sheet.
-- Amounts are stored in paise (integer) to avoid floating point drift.
--   type = 'INC': maint_paise / corpus_paise = amount received into each fund
--   type = 'EXP': maint_paise / corpus_paise = amount paid out of each fund
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  txn_date     TEXT NOT NULL,                -- YYYY-MM-DD (date money moved)
  month        TEXT NOT NULL,                -- YYYY-MM (period it belongs to)
  type         TEXT NOT NULL CHECK (type IN ('INC','EXP')),
  flat_id      INTEGER REFERENCES flats(id),
  category_id  INTEGER REFERENCES categories(id),
  description  TEXT NOT NULL DEFAULT '',
  maint_paise  INTEGER NOT NULL DEFAULT 0 CHECK (maint_paise >= 0),
  corpus_paise INTEGER NOT NULL DEFAULT 0 CHECK (corpus_paise >= 0),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (maint_paise + corpus_paise > 0),
  CHECK ((type = 'INC' AND flat_id IS NOT NULL) OR (type = 'EXP' AND category_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_txn_order ON transactions (txn_date, id);
CREATE INDEX IF NOT EXISTS idx_txn_month ON transactions (month);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','owner')),
  flat_id       INTEGER REFERENCES flats(id),
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER REFERENCES users(id),
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id INTEGER,
  details   TEXT,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULT_SETTINGS = {
  association_name: 'Vanagopal Enclave',
  monthly_maint_due_paise: '100000',  // ₹1000
  monthly_corpus_due_paise: '50000',  // ₹500
};

const DEFAULT_CATEGORIES = ['Plumbing', 'Electrical', 'Common area cleaning', 'Maintenance', 'Other'];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
  const catCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (catCount === 0) {
    const ins = db.prepare('INSERT INTO categories (name) VALUES (?)');
    for (const c of DEFAULT_CATEGORIES) ins.run(c);
  }
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function audit(db, userId, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(userId ?? null, action, entity, entityId ?? null, details ? JSON.stringify(details) : null);
}

module.exports = { open, tx, getSettings, audit };
