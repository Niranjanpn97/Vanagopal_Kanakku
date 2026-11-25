'use strict';
// Postgres access layer.
//  - DATABASE_URL set  -> real Postgres via `pg` (Neon on Vercel, or any Postgres).
//  - otherwise         -> embedded Postgres (PGlite) in a local folder, or in memory for tests.
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flats (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  owner_name  TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS categories (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq ON categories (lower(name));

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','owner')),
  flat_id       INTEGER REFERENCES flats(id),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (lower(username));

-- One row per ledger line, mirroring the Income_Expense sheet.
-- Amounts in paise (integer) to avoid floating point drift.
--   type = 'INC': maint_paise / corpus_paise = received into each fund
--   type = 'EXP': maint_paise / corpus_paise = paid out of each fund
CREATE TABLE IF NOT EXISTS transactions (
  id           SERIAL PRIMARY KEY,
  txn_date     TEXT NOT NULL CHECK (txn_date ~ '^\\d{4}-\\d{2}-\\d{2}$'),
  month        TEXT NOT NULL CHECK (month ~ '^\\d{4}-\\d{2}$'),
  type         TEXT NOT NULL CHECK (type IN ('INC','EXP')),
  flat_id      INTEGER REFERENCES flats(id),
  category_id  INTEGER REFERENCES categories(id),
  description  TEXT NOT NULL DEFAULT '',
  maint_paise  BIGINT NOT NULL DEFAULT 0 CHECK (maint_paise >= 0),
  corpus_paise BIGINT NOT NULL DEFAULT 0 CHECK (corpus_paise >= 0),
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (maint_paise + corpus_paise > 0),
  CHECK ((type = 'INC' AND flat_id IS NOT NULL) OR (type = 'EXP' AND category_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_txn_order ON transactions (txn_date, id);
CREATE INDEX IF NOT EXISTS idx_txn_month ON transactions (month);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

-- Login throttling lives in the DB so it works across serverless instances.
CREATE TABLE IF NOT EXISTS login_attempts (
  key      TEXT PRIMARY KEY,
  n        INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER REFERENCES users(id),
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id INTEGER,
  details   TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const DEFAULT_SETTINGS = {
  association_name: 'Vanagopal Enclave',
  monthly_maint_due_paise: '100000',  // ₹1000
  monthly_corpus_due_paise: '50000',  // ₹500
};
const DEFAULT_CATEGORIES = ['Plumbing', 'Electrical', 'Common area cleaning', 'Maintenance', 'Other'];

/** Wraps a "query function" (sql, params) => {rows, rowCount} with helpers. */
function wrap(q) {
  return {
    async all(sql, params = []) { return (await q(sql, params)).rows; },
    async get(sql, params = []) { return (await q(sql, params)).rows[0]; },
    async run(sql, params = []) { const r = await q(sql, params); return { changes: r.rowCount ?? r.affectedRows ?? 0, rows: r.rows }; },
  };
}

async function connect(opts = {}) {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  let base, txImpl, close;
  if (url) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (paise fit easily)
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 3),
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
    });
    base = (sql, params) => pool.query(sql, params);
    txImpl = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(wrap((s, p) => client.query(s, p)));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    };
    close = () => pool.end();
  } else {
    if (process.env.VERCEL) {
      throw new Error('DATABASE_URL is not set. Connect a Postgres database (e.g. Neon) to this Vercel project.');
    }
    const { PGlite } = require('@electric-sql/pglite');
    const dir = opts.dataDir ?? process.env.PGLITE_DIR ?? path.join(__dirname, '..', 'data', 'pglite');
    const pgl = new PGlite(dir === ':memory:' ? undefined : dir, { parsers: { 20: (v) => Number(v) } });
    base = (sql, params) => pgl.query(sql, params);
    txImpl = (fn) => pgl.transaction((t) => fn(wrap((s, p) => t.query(s, p))));
    close = () => pgl.close();
    base.exec = (sql) => pgl.exec(sql);
  }

  const db = wrap(base);
  db.tx = txImpl;
  db.close = close;

  // Schema + defaults (idempotent; safe to run on every cold start).
  if (base.exec) await base.exec(SCHEMA);
  else await base(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  const { n } = await db.get('SELECT COUNT(*)::int AS n FROM categories');
  if (n === 0) {
    for (const c of DEFAULT_CATEGORIES) {
      await db.run('INSERT INTO categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [c]);
    }
  }
  return db;
}

async function getSettings(db) {
  const out = {};
  for (const r of await db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

async function audit(db, userId, action, entity, entityId, details) {
  await db.run('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [userId ?? null, action, entity, entityId ?? null, details ? JSON.stringify(details) : null]);
}

const isUniqueViolation = (e) => e && (e.code === '23505' || /unique|duplicate key/i.test(e.message));

module.exports = { connect, getSettings, audit, isUniqueViolation };
