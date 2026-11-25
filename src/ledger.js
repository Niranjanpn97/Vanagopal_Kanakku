'use strict';
// Ledger queries: transactions with running balances, summaries, dues.

const TXN_SELECT = `
  SELECT t.id, t.txn_date, t.month, t.type, t.flat_id, t.category_id, t.description,
         t.maint_paise, t.corpus_paise, t.created_at, t.updated_at,
         f.code AS flat_code, f.owner_name, c.name AS category
  FROM transactions t
  LEFT JOIN flats f ON f.id = t.flat_id
  LEFT JOIN categories c ON c.id = t.category_id`;

function signed(t) {
  const s = t.type === 'INC' ? 1 : -1;
  return { m: s * t.maint_paise, c: s * t.corpus_paise };
}

/** All transactions in ledger order with running balances (same as columns L/M in the sheet). */
function listWithBalances(db, filters = {}) {
  const rows = db.prepare(`${TXN_SELECT} ORDER BY t.txn_date, t.id`).all();
  let m = 0, c = 0;
  const out = [];
  for (const r of rows) {
    const d = signed(r);
    m += d.m; c += d.c;
    r.running_maint_paise = m;
    r.running_corpus_paise = c;
    if (filters.month && r.month !== filters.month) continue;
    if (filters.from && r.txn_date < filters.from) continue;
    if (filters.to && r.txn_date > filters.to) continue;
    if (filters.type && r.type !== filters.type) continue;
    if (filters.flat_id && r.flat_id !== Number(filters.flat_id)) continue;
    if (filters.category_id && r.category_id !== Number(filters.category_id)) continue;
    out.push(r);
  }
  return out;
}

function getOne(db, id) {
  return db.prepare(`${TXN_SELECT} WHERE t.id = ?`).get(id);
}

function balances(db) {
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='INC' THEN maint_paise ELSE -maint_paise END),0) AS maint,
      COALESCE(SUM(CASE WHEN type='INC' THEN corpus_paise ELSE -corpus_paise END),0) AS corpus
    FROM transactions`).get();
  return { maint_paise: r.maint, corpus_paise: r.corpus };
}

/** Month-wise pivot, equivalent to the Summary sheet. */
function summary(db, { from, to } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('t.month >= ?'); args.push(from); }
  if (to) { where.push('t.month <= ?'); args.push(to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const income = db.prepare(`
    SELECT t.month, f.code AS flat_code, f.owner_name,
           SUM(t.maint_paise) AS maint_paise, SUM(t.corpus_paise) AS corpus_paise
    FROM transactions t JOIN flats f ON f.id = t.flat_id
    ${w ? w + " AND t.type='INC'" : "WHERE t.type='INC'"}
    GROUP BY t.month, f.id ORDER BY t.month DESC, f.code`).all(...args);

  const expense = db.prepare(`
    SELECT t.month, c.name AS category,
           SUM(t.maint_paise) AS maint_paise, SUM(t.corpus_paise) AS corpus_paise
    FROM transactions t JOIN categories c ON c.id = t.category_id
    ${w ? w + " AND t.type='EXP'" : "WHERE t.type='EXP'"}
    GROUP BY t.month, c.id ORDER BY t.month DESC, c.name`).all(...args);

  const months = new Map();
  const get = (mo) => {
    if (!months.has(mo)) months.set(mo, {
      month: mo, income: [], expense: [],
      income_maint_paise: 0, income_corpus_paise: 0,
      expense_maint_paise: 0, expense_corpus_paise: 0,
    });
    return months.get(mo);
  };
  for (const r of income) {
    const g = get(r.month);
    g.income.push(r);
    g.income_maint_paise += r.maint_paise;
    g.income_corpus_paise += r.corpus_paise;
  }
  for (const r of expense) {
    const g = get(r.month);
    g.expense.push(r);
    g.expense_maint_paise += r.maint_paise;
    g.expense_corpus_paise += r.corpus_paise;
  }
  const list = [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  const totals = list.reduce((a, g) => {
    a.income_maint_paise += g.income_maint_paise;
    a.income_corpus_paise += g.income_corpus_paise;
    a.expense_maint_paise += g.expense_maint_paise;
    a.expense_corpus_paise += g.expense_corpus_paise;
    return a;
  }, { income_maint_paise: 0, income_corpus_paise: 0, expense_maint_paise: 0, expense_corpus_paise: 0 });
  return { months: list, totals, balances: balances(db) };
}

/** Per-flat dues for a month: expected (from settings) vs collected. */
function dues(db, month, settings) {
  const dueM = Number(settings.monthly_maint_due_paise || 0);
  const dueC = Number(settings.monthly_corpus_due_paise || 0);
  const rows = db.prepare(`
    SELECT f.id AS flat_id, f.code AS flat_code, f.owner_name,
           COALESCE(SUM(t.maint_paise),0) AS paid_maint_paise,
           COALESCE(SUM(t.corpus_paise),0) AS paid_corpus_paise,
           MAX(t.txn_date) AS last_paid_on
    FROM flats f
    LEFT JOIN transactions t ON t.flat_id = f.id AND t.type = 'INC' AND t.month = ?
    WHERE f.active = 1
    GROUP BY f.id ORDER BY f.code`).all(month);
  return rows.map((r) => {
    const pendM = Math.max(0, dueM - r.paid_maint_paise);
    const pendC = Math.max(0, dueC - r.paid_corpus_paise);
    const status = pendM + pendC === 0 ? 'paid'
      : (r.paid_maint_paise + r.paid_corpus_paise > 0 ? 'partial' : 'unpaid');
    return { ...r, due_maint_paise: dueM, due_corpus_paise: dueC,
      pending_maint_paise: pendM, pending_corpus_paise: pendC, status };
  });
}

module.exports = { listWithBalances, getOne, balances, summary, dues };
