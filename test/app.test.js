'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { connect } = require('../src/db');

let server, base, db;
before(async () => {
  db = await connect({ databaseUrl: '', dataDir: ':memory:' });
  const app = createApp({ db, setupToken: 'setup-secret-123', secureCookies: false });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server.close(); await db.close(); });

const json = (method, p, body, cookie) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
});

test('first-run setup creates the admin exactly once', async () => {
  assert.deepEqual(await (await fetch(`${base}/setup`)).json(), { needs_setup: true, setup_enabled: true });
  assert.equal((await json('POST', '/setup', { setup_token: 'wrong', username: 'admin', password: 'adminpass1' })).status, 403);
  const r = await json('POST', '/setup', { setup_token: 'setup-secret-123', username: 'admin', display_name: 'Admin', password: 'adminpass1' });
  assert.equal(r.status, 200, await r.text());
  assert.equal((await json('POST', '/setup', { setup_token: 'setup-secret-123', username: 'evil', password: 'evilpass1' })).status, 409);
  assert.equal((await (await fetch(`${base}/setup`)).json()).needs_setup, false);
  // seed fixtures for the remaining tests
  await db.run("INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner','Owner',$1,'owner')", [await hashPassword('ownerpass1')]);
  await db.run("INSERT INTO flats (code, owner_name) VALUES ('F1','A'),('F2','B')");
});

async function login(u, p) {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}
const call = (cookie, method, p, body) => fetch(`${base}${p}`, {
  method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await fetch(`${base}/transactions`)).status, 401);
  assert.equal((await json('POST', '/transactions', { type: 'EXP' })).status, 401);
});

test('wrong password rejected', async () => {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nope' }) });
  assert.equal(r.status, 401);
});

test('running balances match the spreadsheet formulas', async () => {
  const c = await login('admin', 'adminpass1');
  const ok = async (b) => { const r = await call(c, 'POST', '/transactions', b); assert.equal(r.status, 201, await r.text()); };
  await ok({ type: 'INC', txn_date: '2026-12-01', month: '2026-12', flat_id: 2, maint_amount: 1000, corpus_amount: 500 });
  await ok({ type: 'EXP', txn_date: '2026-12-01', category_id: 3, description: 'ABC', maint_amount: 1000 });
  await ok({ type: 'INC', txn_date: '2026-12-05', month: '2026-12', flat_id: 1, maint_amount: 1000.5, corpus_amount: 500 });
  await ok({ type: 'EXP', txn_date: '2026-12-06', category_id: 1, corpus_amount: 200 });
  const rows = await (await call(c, 'GET', '/transactions')).json();
  assert.deepEqual(rows.map((r) => [r.running_maint_paise, r.running_corpus_paise]),
    [[100000, 50000], [0, 50000], [100050, 100000], [100050, 80000]]);
  const s = await (await call(c, 'GET', '/summary')).json();
  assert.equal(s.balances.maint_paise, 100050);
  assert.equal(s.balances.corpus_paise, 80000);
  assert.equal(s.months[0].income_maint_paise, 200050);
  const d = await (await call(c, 'GET', '/dues?month=2026-12')).json();
  assert.deepEqual(d.rows.map((r) => r.status), ['paid', 'paid']);
  const d2 = await (await call(c, 'GET', '/dues?month=2027-01')).json();
  assert.deepEqual(d2.rows.map((r) => r.status), ['unpaid', 'unpaid']);
});

test('validation rejects bad entries', async () => {
  const c = await login('admin', 'adminpass1');
  for (const b of [
    { type: 'INC', txn_date: '2026-12-01', flat_id: 1 },                       // no amount
    { type: 'INC', txn_date: '2026-12-01', flat_id: 99, maint_amount: 10 },     // bad flat
    { type: 'EXP', txn_date: '2026-12-01', category_id: 1, maint_amount: -5 },  // negative
    { type: 'XXX', txn_date: '2026-12-01', maint_amount: 5 },
    { type: 'EXP', txn_date: '12/01/2026', category_id: 1, maint_amount: 5 },
  ]) assert.equal((await call(c, 'POST', '/transactions', b)).status, 400, JSON.stringify(b));
});

test('owner is read-only', async () => {
  const c = await login('owner', 'ownerpass1');
  assert.equal((await call(c, 'GET', '/transactions')).status, 200);
  assert.equal((await call(c, 'GET', '/summary')).status, 200);
  assert.equal((await call(c, 'GET', '/export.xlsx')).status, 200);
  assert.equal((await call(c, 'POST', '/transactions', { type: 'EXP', txn_date: '2026-12-01', category_id: 1, maint_amount: 5 })).status, 403);
  assert.equal((await call(c, 'DELETE', '/transactions/1', {})).status, 403);
  assert.equal((await call(c, 'PUT', '/settings', { monthly_maint_due: 1 })).status, 403);
  assert.equal((await call(c, 'GET', '/users')).status, 403);
  assert.equal((await call(c, 'POST', '/users', { username: 'x', password: 'xxxxxxxx' })).status, 403);
});

test('non-JSON writes are blocked (CSRF guard)', async () => {
  const c = await login('admin', 'adminpass1');
  const r = await fetch(`${base}/transactions`, { method: 'POST', headers: { cookie: c, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'type=EXP' });
  assert.equal(r.status, 415);
});

test('cannot remove last admin', async () => {
  const c = await login('admin', 'adminpass1');
  const r = await call(c, 'PUT', '/users/1', { role: 'owner' });
  assert.equal(r.status, 400);
});

test('excel export round-trips through import', async () => {
  const c = await login('admin', 'adminpass1');
  const buf = Buffer.from(await (await call(c, 'GET', '/export.xlsx')).arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Income_Expense', 'Apartment_Info']);
  const before = await (await call(c, 'GET', '/summary')).json();
  const r = await fetch(`${base}/import?mode=replace`, { method: 'POST', headers: { cookie: c, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: buf });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.transactions, 4);
  const afterS = await (await call(c, 'GET', '/summary')).json();
  assert.deepEqual(afterS.balances, before.balances);
});

const SAMPLE = process.env.SAMPLE_XLSX;
test('imports the original sample workbook', { skip: !SAMPLE || !fs.existsSync(SAMPLE || '') }, async () => {
  const c = await login('admin', 'adminpass1');
  const r = await fetch(`${base}/import?mode=replace`, { method: 'POST', headers: { cookie: c, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: fs.readFileSync(path.resolve(SAMPLE)) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.transactions, 2);
  const s = await (await call(c, 'GET', '/summary')).json();
  assert.equal(s.balances.maint_paise, 0);
  assert.equal(s.balances.corpus_paise, 50000);
  const flats = await (await call(c, 'GET', '/flats')).json();
  assert.equal(flats.length, 8);
});
