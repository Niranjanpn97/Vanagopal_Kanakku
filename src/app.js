'use strict';
const path = require('node:path');
const express = require('express');
const dbm = require('./db');
const auth = require('./auth');
const ledger = require('./ledger');
const excel = require('./excel');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function amountToPaise(v, label) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${label} must be a positive number`);
  return Math.round(n * 100);
}

function validateTxn(db, b) {
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
    if (!db.prepare('SELECT 1 FROM flats WHERE id = ?').get(flatId)) throw bad('Select a valid flat');
  } else {
    catId = Number(b.category_id);
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(catId)) throw bad('Select a valid category');
  }
  const description = String(b.description || '').trim().slice(0, 500);
  return { type, txn_date: b.txn_date, month, flat_id: flatId, category_id: catId,
    description, maint_paise: maint, corpus_paise: corpus };
}

function createApp({ dbFile, secureCookies = false } = {}) {
  const db = dbm.open(dbFile || path.join(__dirname, '..', 'data', 'kanakku.db'));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(auth.loadUser(db));

  // CSRF defence: SameSite=Strict cookie + state-changing requests must be JSON
  // (or the explicit xlsx upload content-type), which browsers can't send cross-site without CORS.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      const ct = req.headers['content-type'] || '';
      if (!ct.startsWith('application/json') && !ct.startsWith('application/vnd.openxmlformats')) {
        return res.status(415).json({ error: 'Unsupported content type' });
      }
    }
    next();
  });

  const api = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // ---------- Auth ----------
  api.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const key = `${req.ip}|${String(username).toLowerCase()}`;
    if (auth.loginLimited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || ''));
    if (!u || !auth.checkPassword(String(password || ''), u.password_hash)) {
      auth.loginFailed(key);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    auth.loginOk(key);
    const token = auth.createSession(db, u.id);
    res.set('Set-Cookie', auth.cookieHeader(token, { secure: secureCookies }));
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    if (req.user) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.user.token);
    res.set('Set-Cookie', auth.cookieHeader('', { secure: secureCookies, clear: true }));
    res.json({ ok: true });
  });

  api.get('/me', auth.requireAuth, (req, res) => {
    const { token, ...u } = req.user;
    res.json({ ...u, settings: dbm.getSettings(db) });
  });

  api.post('/me/password', auth.requireAuth, (req, res) => {
    const { current_password, new_password } = req.body || {};
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!auth.checkPassword(String(current_password || ''), u.password_hash)) throw bad('Current password is wrong');
    const err = auth.validatePassword(new_password);
    if (err) throw bad(err);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(auth.hashPassword(new_password), req.user.id);
    // Log out other sessions.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.user.token);
    res.json({ ok: true });
  });

  // ---------- Read-only (owners + admin) ----------
  api.get('/flats', auth.requireAuth, (req, res) => {
    res.json(db.prepare('SELECT * FROM flats ORDER BY code').all());
  });
  api.get('/categories', auth.requireAuth, (req, res) => {
    res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
  });

  api.get('/transactions', auth.requireAuth, (req, res) => {
    const f = {};
    for (const k of ['month', 'from', 'to', 'type', 'flat_id', 'category_id']) if (req.query[k]) f[k] = String(req.query[k]);
    res.json(ledger.listWithBalances(db, f));
  });

  api.get('/summary', auth.requireAuth, (req, res) => {
    const { from, to } = req.query;
    if (from && !MONTH_RE.test(from)) throw bad('from must be YYYY-MM');
    if (to && !MONTH_RE.test(to)) throw bad('to must be YYYY-MM');
    res.json(ledger.summary(db, { from, to }));
  });

  api.get('/dues', auth.requireAuth, (req, res) => {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!MONTH_RE.test(month)) throw bad('month must be YYYY-MM');
    res.json({ month, rows: ledger.dues(db, month, dbm.getSettings(db)) });
  });

  api.get('/export.xlsx', auth.requireAuth, wrap(async (req, res) => {
    const buf = await excel.exportWorkbook(db, dbm.getSettings(db));
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="Vanagopal_Enclave_Accounts_${stamp}.xlsx"`);
    res.send(Buffer.from(buf));
  }));

  // ---------- Admin: transactions ----------
  api.post('/transactions', auth.requireAdmin, (req, res) => {
    const t = validateTxn(db, req.body || {});
    const r = db.prepare(`INSERT INTO transactions
      (txn_date, month, type, flat_id, category_id, description, maint_paise, corpus_paise, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.txn_date, t.month, t.type, t.flat_id, t.category_id, t.description, t.maint_paise, t.corpus_paise, req.user.id);
    const id = Number(r.lastInsertRowid);
    dbm.audit(db, req.user.id, 'create', 'transaction', id, t);
    res.status(201).json(ledger.getOne(db, id));
  });

  api.put('/transactions/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const before = ledger.getOne(db, id);
    if (!before) throw new HttpError(404, 'Not found');
    const t = validateTxn(db, req.body || {});
    db.prepare(`UPDATE transactions SET txn_date=?, month=?, type=?, flat_id=?, category_id=?,
      description=?, maint_paise=?, corpus_paise=?, updated_at=datetime('now') WHERE id=?`)
      .run(t.txn_date, t.month, t.type, t.flat_id, t.category_id, t.description, t.maint_paise, t.corpus_paise, id);
    dbm.audit(db, req.user.id, 'update', 'transaction', id, { before, after: t });
    res.json(ledger.getOne(db, id));
  });

  api.delete('/transactions/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const before = ledger.getOne(db, id);
    if (!before) throw new HttpError(404, 'Not found');
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    dbm.audit(db, req.user.id, 'delete', 'transaction', id, before);
    res.json({ ok: true });
  });

  api.post('/import', auth.requireAdmin,
    express.raw({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', limit: '10mb' }),
    wrap(async (req, res) => {
      const mode = req.query.mode === 'replace' ? 'replace' : 'append';
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Upload an .xlsx file');
      try {
        res.json(await excel.importWorkbook(db, req.body, { userId: req.user.id, mode }));
      } catch (e) {
        if (e.details) return res.status(400).json({ error: e.message, details: e.details });
        throw bad(`Could not read workbook: ${e.message}`);
      }
    }));

  // ---------- Admin: flats ----------
  api.post('/flats', auth.requireAdmin, (req, res) => {
    const code = String(req.body.code || '').trim().toUpperCase();
    const owner = String(req.body.owner_name || '').trim();
    if (!/^[A-Z]+\d+$/.test(code)) throw bad('Flat code must look like F1, S2, T3');
    if (!owner) throw bad('Owner name is required');
    try {
      const r = db.prepare('INSERT INTO flats (code, owner_name) VALUES (?, ?)').run(code, owner);
      dbm.audit(db, req.user.id, 'create', 'flat', Number(r.lastInsertRowid), { code, owner });
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Flat code already exists');
      throw e;
    }
  });

  api.put('/flats/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const owner = String(req.body.owner_name || '').trim();
    if (!owner) throw bad('Owner name is required');
    const active = req.body.active === false ? 0 : 1;
    const r = db.prepare('UPDATE flats SET owner_name = ?, active = ? WHERE id = ?').run(owner, active, id);
    if (!r.changes) throw new HttpError(404, 'Not found');
    dbm.audit(db, req.user.id, 'update', 'flat', id, { owner, active });
    res.json({ ok: true });
  });

  // ---------- Admin: categories ----------
  api.post('/categories', auth.requireAdmin, (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw bad('Name is required');
    try {
      const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
      dbm.audit(db, req.user.id, 'create', 'category', Number(r.lastInsertRowid), { name });
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Category already exists');
      throw e;
    }
  });

  api.put('/categories/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!name) throw bad('Name is required');
    const active = req.body.active === false ? 0 : 1;
    const r = db.prepare('UPDATE categories SET name = ?, active = ? WHERE id = ?').run(name, active, id);
    if (!r.changes) throw new HttpError(404, 'Not found');
    dbm.audit(db, req.user.id, 'update', 'category', id, { name, active });
    res.json({ ok: true });
  });

  // ---------- Admin: users ----------
  api.get('/users', auth.requireAdmin, (req, res) => {
    res.json(db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.flat_id, u.active,
      u.must_change_password, u.created_at, f.code AS flat_code
      FROM users u LEFT JOIN flats f ON f.id = u.flat_id ORDER BY u.role, u.username`).all());
  });

  api.post('/users', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Username: 3-32 chars, letters/numbers/._-');
    const role = b.role === 'admin' ? 'admin' : 'owner';
    const err = auth.validatePassword(b.password);
    if (err) throw bad(err);
    const flatId = b.flat_id ? Number(b.flat_id) : null;
    const display = String(b.display_name || username).trim();
    try {
      const r = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, flat_id)
        VALUES (?, ?, ?, ?, ?)`).run(username, display, auth.hashPassword(b.password), role, flatId);
      dbm.audit(db, req.user.id, 'create', 'user', Number(r.lastInsertRowid), { username, role, flatId });
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Username already exists');
      throw e;
    }
  });

  api.put('/users/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Not found');
    const role = b.role === 'admin' ? 'admin' : b.role === 'owner' ? 'owner' : u.role;
    const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
    if (u.role === 'admin' && (role !== 'admin' || !active)) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n;
      if (admins <= 1) throw bad('Cannot remove the last active admin');
    }
    const flatId = b.flat_id === undefined ? u.flat_id : (b.flat_id ? Number(b.flat_id) : null);
    const display = b.display_name ? String(b.display_name).trim() : u.display_name;
    db.prepare('UPDATE users SET role=?, active=?, flat_id=?, display_name=? WHERE id=?')
      .run(role, active, flatId, display, id);
    if (b.password) {
      const err = auth.validatePassword(b.password);
      if (err) throw bad(err);
      db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?')
        .run(auth.hashPassword(b.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    dbm.audit(db, req.user.id, 'update', 'user', id, { role, active, flatId, passwordReset: !!b.password });
    res.json({ ok: true });
  });

  // ---------- Admin: settings & audit ----------
  api.put('/settings', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    if (b.association_name !== undefined) up.run(String(b.association_name).trim(), 'association_name');
    if (b.monthly_maint_due !== undefined) up.run(String(amountToPaise(b.monthly_maint_due, 'Maintenance due')), 'monthly_maint_due_paise');
    if (b.monthly_corpus_due !== undefined) up.run(String(amountToPaise(b.monthly_corpus_due, 'Corpus due')), 'monthly_corpus_due_paise');
    dbm.audit(db, req.user.id, 'update', 'settings', null, b);
    res.json(dbm.getSettings(db));
  });

  api.get('/audit', auth.requireAdmin, (req, res) => {
    res.json(db.prepare(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 200`).all());
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
