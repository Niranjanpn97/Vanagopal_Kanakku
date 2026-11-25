'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE = 'vk_session';

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function checkPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  return null;
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_TTL_MS);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
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
function loadUser(db) {
  const q = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.flat_id, u.must_change_password, s.token
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? q.get(token, Date.now()) || null : null;
    next();
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

// Very small in-memory limiter for login attempts (per IP + username).
const attempts = new Map();
function loginLimited(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, reset: now + 15 * 60 * 1000 };
  if (now > a.reset) { a.n = 0; a.reset = now + 15 * 60 * 1000; }
  attempts.set(key, a);
  return a.n >= 10;
}
function loginFailed(key) { const a = attempts.get(key); if (a) a.n++; }
function loginOk(key) { attempts.delete(key); }

module.exports = {
  COOKIE, hashPassword, checkPassword, validatePassword, createSession, cookieHeader,
  loadUser, requireAuth, requireAdmin, loginLimited, loginFailed, loginOk,
};
