'use strict';
// Usage: node scripts/create-admin.js <username> <password> ["Display Name"]
const path = require('node:path');
const db = require('../src/db').open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'kanakku.db'));
const { hashPassword, validatePassword } = require('../src/auth');

const [username, password, display] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/create-admin.js <username> <password> ["Display Name"]');
  process.exit(1);
}
const err = validatePassword(password);
if (err) { console.error(err); process.exit(1); }
const u = username.trim().toLowerCase();
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'admin', active = 1 WHERE id = ?")
    .run(hashPassword(password), existing.id);
  console.log(`Updated ${u} to admin with new password.`);
} else {
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'admin', 0)")
    .run(u, display || u, hashPassword(password));
  console.log(`Created admin ${u}.`);
}
