'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE = 'vk_session';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;

const hashPassword = (pw) => bcrypt.hash(pw, 10);
const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  return null;
}

// Tokens are stored hashed so a leaked DB backup can't be used to hijack sessions.
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash(token), userId, Date.now() + SESSION_TTL_MS]);
  await db.run('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
  return token;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token, { secure, clear } = {}) {
  const attrs = [`${COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  attrs.push(clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  return attrs.join('; ');
}

/** Express middleware: attaches req.user if a valid session cookie is present. */
function loadUser(getDb) {
  return async (req, _res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      req.user = null;
      if (token) {
        const db = await getDb();
        const u = await db.get(`
          SELECT u.id, u.username, u.display_name, u.role, u.flat_id, u.must_change_password, s.token
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = $1 AND s.expires_at > $2 AND u.active`, [tokenHash(token), Date.now()]);
        req.user = u || null;
      }
      next();
    } catch (e) { next(e); }
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

async function loginLimited(db, key) {
  const now = Date.now();
  const r = await db.get('SELECT n, reset_at FROM login_attempts WHERE key = $1', [key]);
  return !!r && r.reset_at > now && r.n >= LOGIN_MAX;
}
async function loginFailed(db, key) {
  const now = Date.now();
  await db.run(`INSERT INTO login_attempts (key, n, reset_at) VALUES ($1, 1, $2)
    ON CONFLICT (key) DO UPDATE SET
      n = CASE WHEN login_attempts.reset_at < $3 THEN 1 ELSE login_attempts.n + 1 END,
      reset_at = CASE WHEN login_attempts.reset_at < $3 THEN $2 ELSE login_attempts.reset_at END`,
  [key, now + LOGIN_WINDOW_MS, now]);
}
async function loginOk(db, key) {
  await db.run('DELETE FROM login_attempts WHERE key = $1 OR reset_at < $2', [key, Date.now()]);
}

module.exports = {
  COOKIE, hashPassword, checkPassword, validatePassword, createSession, cookieHeader, tokenHash,
  loadUser, requireAuth, requireAdmin, loginLimited, loginFailed, loginOk,
};
