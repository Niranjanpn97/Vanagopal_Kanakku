'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const dbm = require('./db');
const auth = require('./auth');
const ledger = require('./ledger');
const excel = require('./excel');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
  return n;
};

function amountToPaise(v, label) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${label} must be a positive number`);
  return Math.round(n * 100);
}

async function validateTxn(db, b) {
  const type = b.type;
  if (type !== 'INC' && type !== 'EXP') throw bad('type must be INC or EXP');
  if (!DATE_RE.test(b.txn_date || '')) throw bad('txn_date must be YYYY-MM-DD');
  const month = b.month || b.txn_date.slice(0, 7);
  if (!MONTH_RE.test(month)) throw bad('month must be YYYY-MM');
  const maint = amountToPaise(b.maint_amount, 'Maintenance amount');
  const corpus = amountToPaise(b.corpus_amount, 'Corpus amount');
  if (maint + corpus === 0) throw bad('Enter an amount for at least one fund');
  let flatId = null, catId = null;
  if (type === 'INC') {
    flatId = Number(b.flat_id);
    if (!Number.isInteger(flatId) || !(await db.get('SELECT 1 FROM flats WHERE id = $1', [flatId]))) throw bad('Select a valid flat');
  } else {
    catId = Number(b.category_id);
    if (!Number.isInteger(catId) || !(await db.get('SELECT 1 FROM categories WHERE id = $1', [catId]))) throw bad('Select a valid category');
  }
  const description = String(b.description || '').trim().slice(0, 500);
  return { type, txn_date: b.txn_date, month, flat_id: flatId, category_id: catId,
    description, maint_paise: maint, corpus_paise: corpus };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Build the Express app. The DB connection is opened lazily (once per process / serverless instance).
 * opts.db: an already-connected db (tests); opts.dbOptions: passed to db.connect().
 */
function createApp(opts = {}) {
  const secureCookies = opts.secureCookies ?? (process.env.SECURE_COOKIES === '1' || !!process.env.VERCEL);
  const setupToken = opts.setupToken ?? process.env.SETUP_TOKEN;
  let dbPromise = opts.db ? Promise.resolve(opts.db) : null;
  const getDb = () => {
    if (!dbPromise) dbPromise = dbm.connect(opts.dbOptions).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  };

  const app = express();
  app.disable('x-powered-by');
  if (process.env.VERCEL || process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY || 1);
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // CSRF defence: SameSite=Strict cookie + state-changing requests must be JSON
  // (or the explicit xlsx upload type), which browsers can't send cross-site without CORS.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      const ct = req.headers['content-type'] || '';
      if (!ct.startsWith('application/json') && !ct.startsWith(XLSX_TYPE)) {
        return res.status(415).json({ error: 'Unsupported content type' });
      }
    }
    next();
  });
  app.use('/api', async (req, res, next) => {
    try { req.db = await getDb(); next(); } catch (e) { next(e); }
  });
  app.use('/api', auth.loadUser(getDb));

  const api = express.Router();

  // ---------- First-run setup ----------
  api.get('/setup', async (req, res) => {
    const r = await req.db.get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
    res.json({ needs_setup: r.n === 0, setup_enabled: !!setupToken });
  });

  api.post('/setup', async (req, res) => {
    const db = req.db;
    if (!setupToken) throw new HttpError(403, 'Setup is disabled (SETUP_TOKEN not configured)');
    const b = req.body || {};
    if (!safeEqual(b.setup_token || '', setupToken)) throw new HttpError(403, 'Wrong setup code');
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Username: 3-32 chars, letters/numbers/._-');
    const err = auth.validatePassword(b.password);
    if (err) throw bad(err);
    const hash = await auth.hashPassword(b.password);
    const created = await db.tx(async (t) => {
      // Lock so two concurrent setups can't both create an admin.
      await t.run('LOCK TABLE users IN EXCLUSIVE MODE');
      const r = await t.get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
      if (r.n > 0) return null;
      return t.get(`INSERT INTO users (username, display_name, password_hash, role, must_change_password)
        VALUES ($1, $2, $3, 'admin', FALSE) RETURNING id`, [username, String(b.display_name || username).trim(), hash]);
    });
    if (!created) throw new HttpError(409, 'Setup already completed');
    await dbm.audit(db, created.id, 'setup', 'user', created.id, { username });
    const token = await auth.createSession(db, created.id);
    res.set('Set-Cookie', auth.cookieHeader(token, { secure: secureCookies }));
    res.json({ ok: true });
  });

  // ---------- Auth ----------
  api.post('/login', async (req, res) => {
    const db = req.db;
    const { username, password } = req.body || {};
    const key = `${req.ip}|${String(username).toLowerCase()}`;
    if (await auth.loginLimited(db, key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = await db.get('SELECT * FROM users WHERE lower(username) = lower($1) AND active', [String(username || '')]);
    if (!u || !(await auth.checkPassword(String(password || ''), u.password_hash))) {
      await auth.loginFailed(db, key);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    await auth.loginOk(db, key);
    const token = await auth.createSession(db, u.id);
    res.set('Set-Cookie', auth.cookieHeader(token, { secure: secureCookies }));
    res.json({ ok: true });
  });

  api.post('/logout', async (req, res) => {
    if (req.user) await req.db.run('DELETE FROM sessions WHERE token = $1', [req.user.token]);
    res.set('Set-Cookie', auth.cookieHeader('', { secure: secureCookies, clear: true }));
    res.json({ ok: true });
  });

  api.get('/me', auth.requireAuth, async (req, res) => {
    const { token, ...u } = req.user;
    res.json({ ...u, settings: await dbm.getSettings(req.db) });
  });

  api.post('/me/password', auth.requireAuth, async (req, res) => {
    const db = req.db;
    const { current_password, new_password } = req.body || {};
    const u = await db.get('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await auth.checkPassword(String(current_password || ''), u.password_hash))) throw bad('Current password is wrong');
    const err = auth.validatePassword(new_password);
    if (err) throw bad(err);
    await db.run('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [await auth.hashPassword(new_password), req.user.id]);
    await db.run('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [req.user.id, req.user.token]);
    res.json({ ok: true });
  });

  // ---------- Read-only (owners + admin) ----------
  api.get('/flats', auth.requireAuth, async (req, res) => {
    res.json(await req.db.all('SELECT * FROM flats ORDER BY code'));
  });
  api.get('/categories', auth.requireAuth, async (req, res) => {
    res.json(await req.db.all('SELECT * FROM categories ORDER BY name'));
  });

  api.get('/transactions', auth.requireAuth, async (req, res) => {
    const f = {};
    for (const k of ['month', 'from', 'to', 'type', 'flat_id', 'category_id']) if (req.query[k]) f[k] = String(req.query[k]);
    res.json(await ledger.listWithBalances(req.db, f));
  });

  api.get('/summary', auth.requireAuth, async (req, res) => {
    const { from, to } = req.query;
    if (from && !MONTH_RE.test(from)) throw bad('from must be YYYY-MM');
    if (to && !MONTH_RE.test(to)) throw bad('to must be YYYY-MM');
    res.json(await ledger.summary(req.db, { from, to }));
  });

  api.get('/dues', auth.requireAuth, async (req, res) => {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!MONTH_RE.test(month)) throw bad('month must be YYYY-MM');
    res.json({ month, rows: await ledger.dues(req.db, month, await dbm.getSettings(req.db)) });
  });

  api.get('/export.xlsx', auth.requireAuth, async (req, res) => {
    const buf = await excel.exportWorkbook(req.db, await dbm.getSettings(req.db));
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', XLSX_TYPE);
    res.set('Content-Disposition', `attachment; filename="Vanagopal_Enclave_Accounts_${stamp}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  // ---------- Admin: transactions ----------
  api.post('/transactions', auth.requireAdmin, async (req, res) => {
    const db = req.db;
    const t = await validateTxn(db, req.body || {});
    const r = await db.get(`INSERT INTO transactions
      (txn_date, month, type, flat_id, category_id, description, maint_paise, corpus_paise, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [t.txn_date, t.month, t.type, t.flat_id, t.category_id, t.description, t.maint_paise, t.corpus_paise, req.user.id]);
    await dbm.audit(db, req.user.id, 'create', 'transaction', r.id, t);
    res.status(201).json(await ledger.getOne(db, r.id));
  });

  api.put('/transactions/:id', auth.requireAdmin, async (req, res) => {
    const db = req.db;
    const tid = id(req.params.id);
    const before = await ledger.getOne(db, tid);
    if (!before) throw new HttpError(404, 'Not found');
    const t = await validateTxn(db, req.body || {});
    await db.run(`UPDATE transactions SET txn_date=$1, month=$2, type=$3, flat_id=$4, category_id=$5,
      description=$6, maint_paise=$7, corpus_paise=$8, updated_at=now() WHERE id=$9`,
    [t.txn_date, t.month, t.type, t.flat_id, t.category_id, t.description, t.maint_paise, t.corpus_paise, tid]);
    await dbm.audit(db, req.user.id, 'update', 'transaction', tid, { before, after: t });
    res.json(await ledger.getOne(db, tid));
  });

  api.delete('/transactions/:id', auth.requireAdmin, async (req, res) => {
    const db = req.db;
    const tid = id(req.params.id);
    const before = await ledger.getOne(db, tid);
    if (!before) throw new HttpError(404, 'Not found');
    await db.run('DELETE FROM transactions WHERE id = $1', [tid]);
    await dbm.audit(db, req.user.id, 'delete', 'transaction', tid, before);
    res.json({ ok: true });
  });

  api.post('/import', auth.requireAdmin, express.raw({ type: XLSX_TYPE, limit: '4mb' }), async (req, res) => {
    const mode = req.query.mode === 'replace' ? 'replace' : 'append';
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Upload an .xlsx file');
    try {
      res.json(await excel.importWorkbook(req.db, req.body, { userId: req.user.id, mode }));
    } catch (e) {
      if (e.details) return res.status(400).json({ error: e.message, details: e.details });
      throw bad(`Could not read workbook: ${e.message}`);
    }
  });

  // ---------- Admin: flats ----------
  api.post('/flats', auth.requireAdmin, async (req, res) => {
    const code = String(req.body.code || '').trim().toUpperCase();
    const owner = String(req.body.owner_name || '').trim();
    if (!/^[A-Z]+\d+$/.test(code)) throw bad('Flat code must look like F1, S2, T3');
    if (!owner) throw bad('Owner name is required');
    try {
      const r = await req.db.get('INSERT INTO flats (code, owner_name) VALUES ($1, $2) RETURNING id', [code, owner]);
      await dbm.audit(req.db, req.user.id, 'create', 'flat', r.id, { code, owner });
      res.status(201).json({ id: r.id });
    } catch (e) {
      if (dbm.isUniqueViolation(e)) throw bad('Flat code already exists');
      throw e;
    }
  });

  api.put('/flats/:id', auth.requireAdmin, async (req, res) => {
    const fid = id(req.params.id);
    const owner = String(req.body.owner_name || '').trim();
    if (!owner) throw bad('Owner name is required');
    const active = req.body.active !== false;
    const r = await req.db.run('UPDATE flats SET owner_name = $1, active = $2 WHERE id = $3', [owner, active, fid]);
    if (!r.changes) throw new HttpError(404, 'Not found');
    await dbm.audit(req.db, req.user.id, 'update', 'flat', fid, { owner, active });
    res.json({ ok: true });
  });

  // ---------- Admin: categories ----------
  api.post('/categories', auth.requireAdmin, async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw bad('Name is required');
    try {
      const r = await req.db.get('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name]);
      await dbm.audit(req.db, req.user.id, 'create', 'category', r.id, { name });
      res.status(201).json({ id: r.id });
    } catch (e) {
      if (dbm.isUniqueViolation(e)) throw bad('Category already exists');
      throw e;
    }
  });

  api.put('/categories/:id', auth.requireAdmin, async (req, res) => {
    const cid = id(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!name) throw bad('Name is required');
    const active = req.body.active !== false;
    const r = await req.db.run('UPDATE categories SET name = $1, active = $2 WHERE id = $3', [name, active, cid]);
    if (!r.changes) throw new HttpError(404, 'Not found');
    await dbm.audit(req.db, req.user.id, 'update', 'category', cid, { name, active });
    res.json({ ok: true });
  });

  // ---------- Admin: users ----------
  api.get('/users', auth.requireAdmin, async (req, res) => {
    res.json(await req.db.all(`SELECT u.id, u.username, u.display_name, u.role, u.flat_id, u.active,
      u.must_change_password, u.created_at, f.code AS flat_code
      FROM users u LEFT JOIN flats f ON f.id = u.flat_id ORDER BY u.role, u.username`));
  });

  api.post('/users', auth.requireAdmin, async (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Username: 3-32 chars, letters/numbers/._-');
    const role = b.role === 'admin' ? 'admin' : 'owner';
    const err = auth.validatePassword(b.password);
    if (err) throw bad(err);
    const flatId = b.flat_id ? Number(b.flat_id) : null;
    const display = String(b.display_name || username).trim();
    try {
      const r = await req.db.get(`INSERT INTO users (username, display_name, password_hash, role, flat_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`, [username, display, await auth.hashPassword(b.password), role, flatId]);
      await dbm.audit(req.db, req.user.id, 'create', 'user', r.id, { username, role, flatId });
      res.status(201).json({ id: r.id });
    } catch (e) {
      if (dbm.isUniqueViolation(e)) throw bad('Username already exists');
      throw e;
    }
  });

  api.put('/users/:id', auth.requireAdmin, async (req, res) => {
    const db = req.db;
    const uid = id(req.params.id);
    const b = req.body || {};
    const u = await db.get('SELECT * FROM users WHERE id = $1', [uid]);
    if (!u) throw new HttpError(404, 'Not found');
    const role = b.role === 'admin' ? 'admin' : b.role === 'owner' ? 'owner' : u.role;
    const active = b.active === undefined ? u.active : !!b.active;
    if (u.role === 'admin' && (role !== 'admin' || !active)) {
      const { n } = await db.get("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND active");
      if (n <= 1) throw bad('Cannot remove the last active admin');
    }
    if (b.password) {
      const err = auth.validatePassword(b.password);
      if (err) throw bad(err);
    }
    const flatId = b.flat_id === undefined ? u.flat_id : (b.flat_id ? Number(b.flat_id) : null);
    const display = b.display_name ? String(b.display_name).trim() : u.display_name;
    await db.run('UPDATE users SET role=$1, active=$2, flat_id=$3, display_name=$4 WHERE id=$5',
      [role, active, flatId, display, uid]);
    if (b.password) {
      await db.run('UPDATE users SET password_hash=$1, must_change_password=TRUE WHERE id=$2',
        [await auth.hashPassword(b.password), uid]);
      await db.run('DELETE FROM sessions WHERE user_id = $1', [uid]);
    }
    if (!active) await db.run('DELETE FROM sessions WHERE user_id = $1', [uid]);
    await dbm.audit(db, req.user.id, 'update', 'user', uid, { role, active, flatId, passwordReset: !!b.password });
    res.json({ ok: true });
  });

  // ---------- Admin: settings & audit ----------
  api.put('/settings', auth.requireAdmin, async (req, res) => {
    const db = req.db;
    const b = req.body || {};
    const up = (k, v) => db.run('UPDATE settings SET value = $1 WHERE key = $2', [v, k]);
    if (b.association_name !== undefined) await up('association_name', String(b.association_name).trim());
    if (b.monthly_maint_due !== undefined) await up('monthly_maint_due_paise', String(amountToPaise(b.monthly_maint_due, 'Maintenance due')));
    if (b.monthly_corpus_due !== undefined) await up('monthly_corpus_due_paise', String(amountToPaise(b.monthly_corpus_due, 'Corpus due')));
    await dbm.audit(db, req.user.id, 'update', 'settings', null, b);
    res.json(await dbm.getSettings(db));
  });

  api.get('/audit', auth.requireAdmin, async (req, res) => {
    res.json(await req.db.all(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 200`));
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });

  app.locals.getDb = getDb;
  return app;
}

module.exports = { createApp };
