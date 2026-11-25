'use strict';
// Usage: node scripts/create-admin.js <username> <password> ["Display Name"]
// Uses DATABASE_URL if set (e.g. your Neon/Vercel database), otherwise the local embedded DB.
const { connect } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/auth');

(async () => {
  const [username, password, display] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: node scripts/create-admin.js <username> <password> ["Display Name"]');
    process.exit(1);
  }
  const err = validatePassword(password);
  if (err) { console.error(err); process.exit(1); }
  const db = await connect();
  const u = username.trim().toLowerCase();
  const hash = await hashPassword(password);
  const existing = await db.get('SELECT id FROM users WHERE lower(username) = $1', [u]);
  if (existing) {
    await db.run("UPDATE users SET password_hash = $1, role = 'admin', active = TRUE WHERE id = $2", [hash, existing.id]);
    console.log(`Updated ${u} to admin with new password.`);
  } else {
    await db.run(`INSERT INTO users (username, display_name, password_hash, role, must_change_password)
      VALUES ($1, $2, $3, 'admin', FALSE)`, [u, display || u, hash]);
    console.log(`Created admin ${u}.`);
  }
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
