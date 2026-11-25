'use strict';
/* Vanagopal Kanakku – single-page frontend (no build step). */

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const money = (p) => inr.format((p || 0) / 100);
const moneyOrDash = (p) => (p ? money(p) : '<span class="muted">–</span>');
const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => localISO();
const thisMonth = () => localISO().slice(0, 7);
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
const dateLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

let me = null;
let cache = { flats: null, categories: null };

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    if (opts.raw) { init.body = opts.body; init.headers['Content-Type'] = opts.contentType; }
    else { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(`/api${path}`, init);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && path !== '/login') { me = null; route('#/login'); throw new Error('Session expired'); }
  if (!res.ok) {
    const e = new Error(data?.error || `Request failed (${res.status})`);
    e.details = data?.details;
    throw e;
  }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2500);
}

function openModal(html, onMount) {
  const d = $('#modal');
  $('#modal-body').innerHTML = html;
  d.showModal();
  onMount?.($('#modal-body'));
}
const closeModal = () => $('#modal').close();

async function flats(force) { if (force || !cache.flats) cache.flats = await api('/flats'); return cache.flats; }
async function categories(force) { if (force || !cache.categories) cache.categories = await api('/categories'); return cache.categories; }
const isAdmin = () => me?.role === 'admin';

// ---------------- Routing ----------------
const routes = {
  '/login': viewLogin,
  '/': viewDashboard,
  '/ledger': viewLedger,
  '/dues': viewDues,
  '/summary': viewSummary,
  '/manage': viewManage,
  '/users': viewUsers,
  '/account': viewAccount,
};

function navLinks() {
  const items = [['/', 'Dashboard'], ['/ledger', 'Ledger'], ['/dues', 'Dues'], ['/summary', 'Summary']];
  if (isAdmin()) items.push(['/manage', 'Flats & Settings'], ['/users', 'Users']);
  items.push(['/account', 'My account']);
  const cur = location.hash.slice(1) || '/';
  $('#nav').innerHTML = items.map(([h, l]) =>
    `<a href="#${h}" class="${cur.split('?')[0] === h ? 'active' : ''}">${l}</a>`).join('');
}

async function route(hash) {
  if (hash && location.hash !== hash) { location.hash = hash; return; }
  const path = (location.hash.slice(1) || '/').split('?')[0];
  if (!me && path !== '/login') {
    try { me = await api('/me'); } catch { me = null; }
    if (!me) { location.hash = '#/login'; return; }
  }
  const header = $('#topbar');
  header.hidden = !me;
  if (me) {
    $('#assoc-name').textContent = me.settings.association_name || 'Apartment';
    $('#who-name').textContent = me.display_name;
    $('#who-role').textContent = me.role === 'admin' ? 'Admin' : 'Owner (view only)';
    $('#who-role').className = `pill ${me.role === 'admin' ? 'admin' : ''}`;
    navLinks();
  }
  const view = routes[path] || viewDashboard;
  const el = $('#view');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try { await view(el); } catch (e) { el.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', () => route());
$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {} }).catch(() => {});
  me = null; cache = { flats: null, categories: null };
  route('#/login');
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ---------------- Login ----------------
async function viewLogin(el) {
  $('#topbar').hidden = true;
  const setup = await api('/setup').catch(() => ({}));
  if (setup.needs_setup) return viewSetup(el, setup);
  el.innerHTML = `
    <div class="card login">
      <h1>Vanagopal Enclave<br><span class="muted" style="font-size:.95rem;font-weight:400">Maintenance accounts</span></h1>
      <form id="f">
        <label>Username <input name="username" autocomplete="username" required autofocus></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <div class="err" id="err"></div>
        <button class="btn primary">Sign in</button>
      </form>
    </div>`;
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/login', { method: 'POST', body: Object.fromEntries(fd) });
      me = await api('/me');
      route(me.must_change_password ? '#/account' : '#/');
    } catch (err) { $('#err').textContent = err.message; }
  });
}

async function viewSetup(el, setup) {
  if (!setup.setup_enabled) {
    el.innerHTML = `<div class="card login"><h1>Setup required</h1>
      <p>No admin account exists yet. Set the <code>SETUP_TOKEN</code> environment variable on the server,
      or run <code>npm run create-admin</code>, then reload this page.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="card login">
      <h1>Create the first admin</h1>
      <p class="muted">This screen only works once. After an admin exists, it is disabled.</p>
      <form id="f">
        <label>Setup code <input name="setup_token" required autocomplete="off"></label>
        <label>Your name <input name="display_name" required></label>
        <label>Username <input name="username" required pattern="[a-zA-Z0-9._\\-]{3,32}" autocomplete="username"></label>
        <label>Password (min 8 chars) <input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <div class="err" id="err"></div>
        <button class="btn primary">Create admin & sign in</button>
      </form>
    </div>`;
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/setup', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      me = await api('/me');
      route('#/');
    } catch (err) { $('#err').textContent = err.message; }
  });
}

// ---------------- Dashboard ----------------
async function viewDashboard(el) {
  const month = thisMonth();
  const [sum, dues, recent] = await Promise.all([
    api('/summary'), api(`/dues?month=${month}`), api('/transactions'),
  ]);
  const cur = sum.months.find((m) => m.month === month) || { income_maint_paise: 0, income_corpus_paise: 0, expense_maint_paise: 0, expense_corpus_paise: 0 };
  const paid = dues.rows.filter((r) => r.status === 'paid').length;
  const pending = dues.rows.reduce((a, r) => a + r.pending_maint_paise + r.pending_corpus_paise, 0);
  const last = recent.slice(-8).reverse();
  el.innerHTML = `
    ${me.must_change_password ? '<div class="notice">You are using a temporary password. <a href="#/account">Change it now</a>.</div>' : ''}
    <h1>Overview</h1>
    <div class="grid">
      <div class="card stat"><div class="label">Maintenance fund balance</div><div class="value">${money(sum.balances.maint_paise)}</div><div class="sub">Running balance across all months</div></div>
      <div class="card stat"><div class="label">Corpus fund balance</div><div class="value">${money(sum.balances.corpus_paise)}</div><div class="sub">Reserved for major works</div></div>
      <div class="card stat"><div class="label">${esc(monthLabel(month))} collection</div><div class="value">${paid} / ${dues.rows.length} <span style="font-size:1rem" class="muted">flats</span></div><div class="sub">${pending ? `${money(pending)} pending` : 'All dues collected'}</div></div>
      <div class="card stat"><div class="label">${esc(monthLabel(month))} spend</div><div class="value exp">${money(cur.expense_maint_paise + cur.expense_corpus_paise)}</div><div class="sub">Income ${money(cur.income_maint_paise + cur.income_corpus_paise)}</div></div>
    </div>
    <div class="card">
      <div class="toolbar"><h2 style="margin:0">Recent transactions</h2><span class="spacer"></span>
        ${isAdmin() ? '<button class="btn primary" id="add">+ Add entry</button>' : ''}
        <a class="btn" href="#/ledger">Full ledger</a></div>
      ${txnTable(last, { compact: true })}
    </div>`;
  $('#add')?.addEventListener('click', () => txnForm());
}

// ---------------- Ledger ----------------
function txnTable(rows, { compact } = {}) {
  if (!rows.length) return '<p class="muted">No transactions yet.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Date</th>${compact ? '' : '<th class="hide-sm">Month</th>'}<th>Type</th><th>Flat / Category</th><th class="hide-sm">Description</th>
      <th class="num">Maint. fund</th><th class="num">Corpus fund</th>
      ${compact ? '' : '<th class="num hide-sm">Bal. maint.</th><th class="num hide-sm">Bal. corpus</th>'}
      ${isAdmin() && !compact ? '<th class="no-print"></th>' : ''}
    </tr></thead><tbody>
    ${rows.map((t) => {
      const sign = t.type === 'INC' ? '+' : '−';
      const cls = t.type === 'INC' ? 'inc' : 'exp';
      return `<tr>
        <td>${esc(dateLabel(t.txn_date))}</td>
        ${compact ? '' : `<td class="hide-sm">${esc(monthLabel(t.month))}</td>`}
        <td><span class="pill ${cls}">${t.type === 'INC' ? 'Income' : 'Expense'}</span></td>
        <td>${t.type === 'INC' ? `<b>${esc(t.flat_code)}</b> ${esc(t.owner_name)}` : esc(t.category)}</td>
        <td class="hide-sm">${esc(t.description)}</td>
        <td class="num ${cls}">${t.maint_paise ? sign + money(t.maint_paise) : '<span class="muted">–</span>'}</td>
        <td class="num ${cls}">${t.corpus_paise ? sign + money(t.corpus_paise) : '<span class="muted">–</span>'}</td>
        ${compact ? '' : `<td class="num hide-sm">${money(t.running_maint_paise)}</td><td class="num hide-sm">${money(t.running_corpus_paise)}</td>`}
        ${isAdmin() && !compact ? `<td class="no-print" style="white-space:nowrap">
          <button class="btn small" data-edit="${t.id}">Edit</button>
          <button class="btn small danger" data-del="${t.id}">Delete</button></td>` : ''}
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

async function viewLedger(el) {
  const [fl, cats] = await Promise.all([flats(), categories()]);
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  el.innerHTML = `
    <h1>Ledger</h1>
    <div class="toolbar">
      <label>Month <input type="month" id="f-month" value="${esc(q.get('month') || '')}"></label>
      <label>Type <select id="f-type"><option value="">All</option><option value="INC">Income</option><option value="EXP">Expense</option></select></label>
      <label>Flat <select id="f-flat"><option value="">All</option>${fl.map((f) => `<option value="${f.id}">${esc(f.code)} – ${esc(f.owner_name)}</option>`).join('')}</select></label>
      <label>Category <select id="f-cat"><option value="">All</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <span class="spacer"></span>
      <a class="btn" href="/api/export.xlsx">⬇ Excel</a>
      <button class="btn" onclick="window.print()">Print</button>
      ${isAdmin() ? '<button class="btn primary" id="add">+ Add entry</button>' : ''}
    </div>
    <div class="card" id="tbl"></div>`;
  $('#f-type').value = q.get('type') || '';
  $('#f-flat').value = q.get('flat_id') || '';
  $('#f-cat').value = q.get('category_id') || '';

  const load = async () => {
    const p = new URLSearchParams();
    if ($('#f-month').value) p.set('month', $('#f-month').value);
    if ($('#f-type').value) p.set('type', $('#f-type').value);
    if ($('#f-flat').value) p.set('flat_id', $('#f-flat').value);
    if ($('#f-cat').value) p.set('category_id', $('#f-cat').value);
    history.replaceState(null, '', `#/ledger${p.toString() ? `?${p}` : ''}`);
    const rows = await api(`/transactions?${p}`);
    const tot = rows.reduce((a, t) => {
      const s = t.type === 'INC' ? 1 : -1;
      a.m += s * t.maint_paise; a.c += s * t.corpus_paise; return a;
    }, { m: 0, c: 0 });
    $('#tbl').innerHTML = txnTable(rows) + (rows.length
      ? `<p class="muted" style="margin:.75rem 0 0">${rows.length} entries · Net for this view: maintenance <b>${money(tot.m)}</b>, corpus <b>${money(tot.c)}</b></p>` : '');
    $('#tbl').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => txnForm(rows.find((r) => r.id === Number(b.dataset.edit)), load)));
    $('#tbl').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const t = rows.find((r) => r.id === Number(b.dataset.del));
      if (!confirm(`Delete this ${t.type === 'INC' ? 'income' : 'expense'} entry of ${money(t.maint_paise + t.corpus_paise)} on ${dateLabel(t.txn_date)}?`)) return;
      try { await api(`/transactions/${t.id}`, { method: 'DELETE', body: {} }); toast('Deleted'); load(); } catch (e) { alert(e.message); }
    }));
  };
  ['#f-month', '#f-type', '#f-flat', '#f-cat'].forEach((s) => $(s).addEventListener('change', load));
  $('#add')?.addEventListener('click', () => txnForm(null, load));
  await load();
}

async function txnForm(t, after) {
  const [fl, cats] = await Promise.all([flats(), categories()]);
  let type = t?.type || 'INC';
  const s = me.settings;
  openModal(`
    <h2>${t ? 'Edit entry' : 'New entry'}</h2>
    <form class="form" id="tf">
      <div class="seg" id="seg"><button type="button" data-t="INC">Income (owner payment)</button><button type="button" data-t="EXP">Expense</button></div>
      <div class="row">
        <label>Date paid <input type="date" name="txn_date" required value="${esc(t?.txn_date || today())}"></label>
        <label>For month <input type="month" name="month" required value="${esc(t?.month || thisMonth())}"></label>
      </div>
      <label class="inc-only">Flat & owner <select name="flat_id">${fl.filter((f) => f.active || f.id === t?.flat_id).map((f) => `<option value="${f.id}">${esc(f.code)} – ${esc(f.owner_name)}</option>`).join('')}</select></label>
      <label class="exp-only">Expense category <select name="category_id">${cats.filter((c) => c.active || c.id === t?.category_id).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <div class="row">
        <label><span class="inc-only">Maintenance fund received (₹)</span><span class="exp-only">Paid from maintenance fund (₹)</span>
          <input type="number" name="maint_amount" min="0" step="0.01" inputmode="decimal" value="${t ? t.maint_paise / 100 || '' : ''}"></label>
        <label><span class="inc-only">Corpus fund received (₹)</span><span class="exp-only">Paid from corpus fund (₹)</span>
          <input type="number" name="corpus_amount" min="0" step="0.01" inputmode="decimal" value="${t ? t.corpus_paise / 100 || '' : ''}"></label>
      </div>
      <label>Description <input name="description" maxlength="500" placeholder="e.g. vendor, bill no., UPI ref" value="${esc(t?.description || '')}"></label>
      <div class="err" id="terr"></div>
      <div class="actions"><button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary">${t ? 'Save' : 'Add'}</button></div>
    </form>`, (m) => {
    const f = $('#tf', m);
    if (t?.flat_id) f.flat_id.value = t.flat_id;
    if (t?.category_id) f.category_id.value = t.category_id;
    const paint = () => {
      m.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.t === type));
      m.querySelectorAll('.inc-only').forEach((e) => { e.hidden = type !== 'INC'; });
      m.querySelectorAll('.exp-only').forEach((e) => { e.hidden = type !== 'EXP'; });
    };
    m.querySelectorAll('#seg button').forEach((b) => b.addEventListener('click', () => {
      type = b.dataset.t;
      if (!t && type === 'INC' && !f.maint_amount.value && !f.corpus_amount.value) prefillDues();
      paint();
    }));
    const prefillDues = () => {
      f.maint_amount.value = Number(s.monthly_maint_due_paise) / 100 || '';
      f.corpus_amount.value = Number(s.monthly_corpus_due_paise) / 100 || '';
    };
    if (!t) prefillDues();
    paint();
    $('#cancel', m).addEventListener('click', closeModal);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.type = type;
      try {
        await api(t ? `/transactions/${t.id}` : '/transactions', { method: t ? 'PUT' : 'POST', body });
        closeModal(); toast(t ? 'Saved' : 'Entry added');
        if (after) after(); else route();
      } catch (err) { $('#terr', m).textContent = err.message; }
    });
  });
}

// ---------------- Dues ----------------
async function viewDues(el) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = q.get('month') || thisMonth();
  const d = await api(`/dues?month=${encodeURIComponent(month)}`);
  const tot = d.rows.reduce((a, r) => {
    a.due += r.due_maint_paise + r.due_corpus_paise;
    a.paid += r.paid_maint_paise + r.paid_corpus_paise;
    a.pend += r.pending_maint_paise + r.pending_corpus_paise; return a;
  }, { due: 0, paid: 0, pend: 0 });
  el.innerHTML = `
    <h1>Monthly dues</h1>
    <div class="toolbar">
      <label>Month <input type="month" id="m" value="${esc(month)}"></label>
      <span class="spacer"></span>
      <span class="muted">Expected per flat: maintenance ${money(+me.settings.monthly_maint_due_paise)}, corpus ${money(+me.settings.monthly_corpus_due_paise)}</span>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Flat</th><th>Owner</th><th>Status</th><th class="num">Maint. paid</th><th class="num">Corpus paid</th><th class="num">Pending</th><th class="hide-sm">Last paid on</th>${isAdmin() ? '<th class="no-print"></th>' : ''}</tr></thead>
      <tbody>${d.rows.map((r) => `<tr>
        <td><b>${esc(r.flat_code)}</b></td><td>${esc(r.owner_name)}</td>
        <td><span class="pill ${r.status}">${r.status}</span></td>
        <td class="num">${moneyOrDash(r.paid_maint_paise)}</td><td class="num">${moneyOrDash(r.paid_corpus_paise)}</td>
        <td class="num ${r.pending_maint_paise + r.pending_corpus_paise ? 'exp' : ''}">${moneyOrDash(r.pending_maint_paise + r.pending_corpus_paise)}</td>
        <td class="hide-sm">${r.last_paid_on ? esc(dateLabel(r.last_paid_on)) : '<span class="muted">–</span>'}</td>
        ${isAdmin() ? `<td class="no-print">${r.status !== 'paid' ? `<button class="btn small" data-pay="${r.flat_id}" data-m="${r.pending_maint_paise}" data-c="${r.pending_corpus_paise}">Record payment</button>` : ''}</td>` : ''}
      </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Total (${d.rows.filter((r) => r.status === 'paid').length}/${d.rows.length} paid)</td>
        <td class="num" colspan="2">${money(tot.paid)} of ${money(tot.due)}</td><td class="num exp">${moneyOrDash(tot.pend)}</td><td colspan="${isAdmin() ? 2 : 1}"></td></tr></tfoot>
    </table></div></div>
    <p class="muted">Payments count toward the month chosen in "For month" on the entry, not the date paid. Advance or late payments are therefore attributed correctly.</p>`;
  $('#m').addEventListener('change', (e) => { location.hash = `#/dues?month=${e.target.value}`; });
  el.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    await txnForm(null, () => route());
    const f = $('#tf');
    f.flat_id.value = b.dataset.pay;
    f.month.value = month;
    f.maint_amount.value = Number(b.dataset.m) / 100 || '';
    f.corpus_amount.value = Number(b.dataset.c) / 100 || '';
  }));
}

// ---------------- Summary ----------------
async function viewSummary(el) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const from = q.get('from') || '';
  const to = q.get('to') || '';
  const p = new URLSearchParams(); if (from) p.set('from', from); if (to) p.set('to', to);
  const s = await api(`/summary?${p}`);
  el.innerHTML = `
    <h1>Summary</h1>
    <div class="toolbar">
      <label>From <input type="month" id="from" value="${esc(from)}"></label>
      <label>To <input type="month" id="to" value="${esc(to)}"></label>
      <span class="spacer"></span>
      <a class="btn" href="/api/export.xlsx">⬇ Excel</a>
      <button class="btn" onclick="window.print()">Print</button>
    </div>
    <div class="grid">
      <div class="card stat"><div class="label">Income (period)</div><div class="value inc">${money(s.totals.income_maint_paise + s.totals.income_corpus_paise)}</div>
        <div class="sub">Maint. ${money(s.totals.income_maint_paise)} · Corpus ${money(s.totals.income_corpus_paise)}</div></div>
      <div class="card stat"><div class="label">Expenses (period)</div><div class="value exp">${money(s.totals.expense_maint_paise + s.totals.expense_corpus_paise)}</div>
        <div class="sub">Maint. ${money(s.totals.expense_maint_paise)} · Corpus ${money(s.totals.expense_corpus_paise)}</div></div>
      <div class="card stat"><div class="label">Current balances</div><div class="value">${money(s.balances.maint_paise + s.balances.corpus_paise)}</div>
        <div class="sub">Maint. ${money(s.balances.maint_paise)} · Corpus ${money(s.balances.corpus_paise)}</div></div>
    </div>
    ${s.months.length ? '' : '<div class="card muted">No data for this period.</div>'}
    ${s.months.map((m) => `
      <div class="card">
        <h2>${esc(monthLabel(m.month))}</h2>
        <div class="grid" style="margin:0">
          <div class="table-wrap"><table>
            <thead><tr><th>Income · flat</th><th class="num">Maint.</th><th class="num">Corpus</th></tr></thead>
            <tbody>${m.income.map((r) => `<tr><td><b>${esc(r.flat_code)}</b> ${esc(r.owner_name)}</td><td class="num">${moneyOrDash(r.maint_paise)}</td><td class="num">${moneyOrDash(r.corpus_paise)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None</td></tr>'}</tbody>
            <tfoot><tr><td>Total</td><td class="num inc">${money(m.income_maint_paise)}</td><td class="num inc">${money(m.income_corpus_paise)}</td></tr></tfoot>
          </table></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Expense · category</th><th class="num">Maint.</th><th class="num">Corpus</th></tr></thead>
            <tbody>${m.expense.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${moneyOrDash(r.maint_paise)}</td><td class="num">${moneyOrDash(r.corpus_paise)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None</td></tr>'}</tbody>
            <tfoot><tr><td>Total</td><td class="num exp">${money(m.expense_maint_paise)}</td><td class="num exp">${money(m.expense_corpus_paise)}</td></tr></tfoot>
          </table></div>
        </div>
      </div>`).join('')}`;
  const go = () => {
    const n = new URLSearchParams();
    if ($('#from').value) n.set('from', $('#from').value);
    if ($('#to').value) n.set('to', $('#to').value);
    location.hash = `#/summary${n.toString() ? `?${n}` : ''}`;
  };
  $('#from').addEventListener('change', go);
  $('#to').addEventListener('change', go);
}

// ---------------- Admin: flats, categories, settings, import ----------------
async function viewManage(el) {
  if (!isAdmin()) { el.innerHTML = '<div class="card">Admins only.</div>'; return; }
  const [fl, cats, audit] = await Promise.all([flats(true), categories(true), api('/audit')]);
  const s = me.settings;
  el.innerHTML = `
    <h1>Flats & settings</h1>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
      <div class="card">
        <h2>Flats</h2>
        <table><thead><tr><th>Flat</th><th>Owner</th><th></th></tr></thead><tbody>
        ${fl.map((f) => `<tr class="${f.active ? '' : 'muted'}"><td><b>${esc(f.code)}</b></td><td>${esc(f.owner_name)}${f.active ? '' : ' (inactive)'}</td>
          <td><button class="btn small" data-flat="${f.id}">Edit</button></td></tr>`).join('')}
        </tbody></table>
        <form class="toolbar" id="addflat" style="margin:.75rem 0 0">
          <label>Code <input name="code" placeholder="F1" size="4" required></label>
          <label style="flex:1">Owner name <input name="owner_name" required></label>
          <button class="btn">Add flat</button>
        </form>
      </div>
      <div class="card">
        <h2>Expense categories</h2>
        <table><tbody>
        ${cats.map((c) => `<tr class="${c.active ? '' : 'muted'}"><td>${esc(c.name)}${c.active ? '' : ' (hidden)'}</td>
          <td class="num"><button class="btn small" data-cat="${c.id}">${c.active ? 'Hide' : 'Show'}</button></td></tr>`).join('')}
        </tbody></table>
        <form class="toolbar" id="addcat" style="margin:.75rem 0 0">
          <label style="flex:1">New category <input name="name" required></label>
          <button class="btn">Add</button>
        </form>
      </div>
      <div class="card">
        <h2>Settings</h2>
        <form class="form" id="settings">
          <label>Association name <input name="association_name" value="${esc(s.association_name)}"></label>
          <div class="row">
            <label>Monthly maintenance due per flat (₹) <input type="number" min="0" step="0.01" name="monthly_maint_due" value="${+s.monthly_maint_due_paise / 100}"></label>
            <label>Monthly corpus due per flat (₹) <input type="number" min="0" step="0.01" name="monthly_corpus_due" value="${+s.monthly_corpus_due_paise / 100}"></label>
          </div>
          <div class="actions"><button class="btn primary">Save settings</button></div>
        </form>
      </div>
      <div class="card">
        <h2>Import from Excel</h2>
        <p class="muted">Upload a workbook in the same format as <i>Vanagopal_Enclave_Accounts.xlsx</i> (sheets Income_Expense and Apartment_Info).</p>
        <form class="form" id="imp">
          <input type="file" name="file" accept=".xlsx" required>
          <label><span><input type="checkbox" name="replace"> Replace all existing transactions (otherwise entries are appended)</span></label>
          <div class="err" id="imperr"></div>
          <div class="actions"><button class="btn primary">Import</button></div>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>Activity log</h2>
      <div class="table-wrap"><table><thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Item</th></tr></thead><tbody>
      ${audit.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.username || 'system')}</td><td>${esc(a.action)}</td><td>${esc(a.entity)}${a.entity_id ? ` #${a.entity_id}` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity yet</td></tr>'}
      </tbody></table></div>
    </div>`;

  el.querySelectorAll('[data-flat]').forEach((b) => b.addEventListener('click', () => {
    const f = fl.find((x) => x.id === Number(b.dataset.flat));
    openModal(`<h2>Flat ${esc(f.code)}</h2><form class="form" id="ef">
      <label>Owner name <input name="owner_name" value="${esc(f.owner_name)}" required></label>
      <label><span><input type="checkbox" name="active" ${f.active ? 'checked' : ''}> Active (counts for dues)</span></label>
      <div class="err" id="e"></div>
      <div class="actions"><button type="button" class="btn" id="c">Cancel</button><button class="btn primary">Save</button></div></form>`, (m) => {
      $('#c', m).addEventListener('click', closeModal);
      $('#ef', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(`/flats/${f.id}`, { method: 'PUT', body: { owner_name: e.target.owner_name.value, active: e.target.active.checked } });
          closeModal(); toast('Saved'); route();
        } catch (err) { $('#e', m).textContent = err.message; }
      });
    });
  }));
  el.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', async () => {
    const c = cats.find((x) => x.id === Number(b.dataset.cat));
    await api(`/categories/${c.id}`, { method: 'PUT', body: { name: c.name, active: !c.active } });
    route();
  }));
  $('#addflat').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/flats', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Flat added'); route(); }
    catch (err) { alert(err.message); }
  });
  $('#addcat').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/categories', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Category added'); route(); }
    catch (err) { alert(err.message); }
  });
  $('#settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      me.settings = await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      toast('Settings saved'); route();
    } catch (err) { alert(err.message); }
  });
  $('#imp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = e.target.file.files[0];
    const replace = e.target.replace.checked;
    if (replace && !confirm('This deletes ALL existing transactions and replaces them with the file. Continue?')) return;
    try {
      const r = await api(`/import?mode=${replace ? 'replace' : 'append'}`, {
        method: 'POST', raw: true, body: await file.arrayBuffer(),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      cache = { flats: null, categories: null };
      alert(`Imported ${r.transactions} transactions, ${r.flats} flats, ${r.categories} new categories.` +
        (r.errors.length ? `\n\nSkipped rows:\n${r.errors.join('\n')}` : ''));
      route();
    } catch (err) {
      $('#imperr').textContent = err.message + (err.details ? `: ${err.details.join('; ')}` : '');
    }
  });
}

// ---------------- Admin: users ----------------
async function viewUsers(el) {
  if (!isAdmin()) { el.innerHTML = '<div class="card">Admins only.</div>'; return; }
  const [users, fl] = await Promise.all([api('/users'), flats()]);
  const flatOpts = (sel) => `<option value="">—</option>${fl.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.code)} – ${esc(f.owner_name)}</option>`).join('')}`;
  el.innerHTML = `
    <h1>Users</h1>
    <p class="muted"><b>Admin</b> can add, edit and delete entries and manage users. <b>Owner</b> can view the ledger, dues and summaries, and download Excel, but cannot change anything.</p>
    <div class="toolbar"><span class="spacer"></span><button class="btn primary" id="add">+ Add user</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Flat</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr class="${u.active ? '' : 'muted'}">
        <td>${esc(u.username)}</td><td>${esc(u.display_name)}</td>
        <td><span class="pill ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span></td>
        <td>${esc(u.flat_code || '–')}</td>
        <td>${u.active ? (u.must_change_password ? 'Temp. password' : 'Active') : 'Disabled'}</td>
        <td><button class="btn small" data-u="${u.id}">Edit</button></td></tr>`).join('')}</tbody>
    </table></div></div>`;

  const form = (u) => openModal(`
    <h2>${u ? `Edit ${esc(u.username)}` : 'New user'}</h2>
    <form class="form" id="uf">
      ${u ? '' : '<label>Username <input name="username" required pattern="[a-zA-Z0-9._\\-]{3,32}" placeholder="e.g. s3-niranjan"></label>'}
      <label>Display name <input name="display_name" value="${esc(u?.display_name || '')}" required></label>
      <div class="row">
        <label>Role <select name="role"><option value="owner">Owner (view only)</option><option value="admin">Admin</option></select></label>
        <label>Flat <select name="flat_id">${flatOpts(u?.flat_id)}</select></label>
      </div>
      <label>${u ? 'Reset password (leave blank to keep)' : 'Temporary password'} <input name="password" type="text" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label>
      ${u ? `<label><span><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Account enabled</span></label>` : ''}
      <p class="muted" style="margin:0">The user will be asked to change a temporary password after signing in.</p>
      <div class="err" id="ue"></div>
      <div class="actions"><button type="button" class="btn" id="c">Cancel</button><button class="btn primary">${u ? 'Save' : 'Create'}</button></div>
    </form>`, (m) => {
    const f = $('#uf', m);
    f.role.value = u?.role || 'owner';
    f.flat_id.addEventListener('change', () => {
      if (!f.display_name.value) {
        const fo = fl.find((x) => x.id === Number(f.flat_id.value));
        if (fo) f.display_name.value = fo.owner_name;
      }
    });
    $('#c', m).addEventListener('click', closeModal);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      if (u) body.active = f.active.checked;
      if (u && !body.password) delete body.password;
      try {
        await api(u ? `/users/${u.id}` : '/users', { method: u ? 'PUT' : 'POST', body });
        closeModal(); toast('Saved'); route();
      } catch (err) { $('#ue', m).textContent = err.message; }
    });
  });
  $('#add').addEventListener('click', () => form(null));
  el.querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', () => form(users.find((x) => x.id === Number(b.dataset.u)))));
}

// ---------------- Account ----------------
async function viewAccount(el) {
  el.innerHTML = `
    <h1>My account</h1>
    ${me.must_change_password ? '<div class="notice">Please set your own password before continuing.</div>' : ''}
    <div class="card" style="max-width:420px">
      <p><b>${esc(me.display_name)}</b> · ${esc(me.username)} · ${me.role === 'admin' ? 'Admin' : 'Owner (view only)'}</p>
      <form class="form" id="pf">
        <label>Current password <input type="password" name="current_password" required autocomplete="current-password"></label>
        <label>New password (min 8 chars) <input type="password" name="new_password" minlength="8" required autocomplete="new-password"></label>
        <label>Confirm new password <input type="password" name="confirm" minlength="8" required autocomplete="new-password"></label>
        <div class="err" id="pe"></div>
        <div class="actions"><button class="btn primary">Change password</button></div>
      </form>
    </div>`;
  $('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    if (b.new_password !== b.confirm) { $('#pe').textContent = 'Passwords do not match'; return; }
    try {
      await api('/me/password', { method: 'POST', body: b });
      me.must_change_password = 0; toast('Password changed'); route('#/');
    } catch (err) { $('#pe').textContent = err.message; }
  });
}

route();
