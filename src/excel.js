'use strict';
// Import from / export to the association's existing Excel layout
// (sheets: Income_Expense, Apartment_Info, Summary).
const ExcelJS = require('exceljs');
const { audit } = require('./db');
const ledger = require('./ledger');

const toPaise = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error(`Bad amount: ${v}`);
  return Math.round(n * 100);
};

function cellValue(c) {
  const v = c.value;
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return v.result;      // formula
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
}

function isoDate(v) {
  if (v instanceof Date) {
    // Excel dates come in as UTC midnight.
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'string') {
    const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** "F2 - V RAJA PRATHAP SINGH" / "T2- MURALITHARAN. M. M" -> { code, name } */
function splitFlatLabel(label) {
  const m = String(label || '').trim().match(/^([A-Za-z]+\d+)\s*-\s*(.+)$/);
  if (!m) return null;
  return { code: m[1].toUpperCase(), name: m[2].trim() };
}

/**
 * Import a workbook buffer. Returns { flats, categories, transactions, errors }.
 * mode 'replace' wipes existing transactions first; 'append' adds to them.
 */
async function importWorkbook(db, buffer, { userId, mode = 'append' } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const info = wb.getWorksheet('Apartment_Info');
  const ledgerWs = wb.getWorksheet('Income_Expense');
  if (!ledgerWs) throw new Error('Sheet "Income_Expense" not found');

  const result = { flats: 0, categories: 0, transactions: 0, errors: [] };

  // 1) Parse everything in memory first (Postgres aborts a transaction on the first error,
  //    so all validation happens before touching the database).
  const infoFlats = [];
  const infoCats = [];
  if (info) {
    info.eachRow((row, i) => {
      if (i === 1) return;
      const code = cellValue(row.getCell(1));
      const label = cellValue(row.getCell(2));
      if (code && label) {
        const sp = splitFlatLabel(label);
        infoFlats.push({ code: String(code).trim().toUpperCase(), name: sp ? sp.name : String(label).trim() });
      }
      const cat = cellValue(row.getCell(6));
      if (cat) infoCats.push(String(cat).trim());
    });
  }

  const entries = [];
  ledgerWs.eachRow((row, i) => {
    if (i <= 2) return; // two header rows
    const typeRaw = cellValue(row.getCell(4));
    if (!typeRaw) return; // empty/formula-only row
    try {
      const up = String(typeRaw).toUpperCase();
      const type = up.startsWith('INC') ? 'INC' : up.startsWith('EXP') ? 'EXP' : null;
      if (!type) throw new Error(`Unknown Tran. Type "${typeRaw}"`);
      const date = isoDate(cellValue(row.getCell(3)));
      if (!date) throw new Error('Missing/invalid Date');
      const month = (isoDate(cellValue(row.getCell(2))) || date).slice(0, 7);
      const e = { row: i, type, date, month, desc: String(cellValue(row.getCell(9)) || '').trim() };
      if (type === 'INC') {
        const sp = splitFlatLabel(cellValue(row.getCell(5)));
        if (!sp) throw new Error(`Cannot read flat from "${cellValue(row.getCell(5))}"`);
        e.flat = sp;
        e.maint = toPaise(cellValue(row.getCell(6)));
        e.corpus = toPaise(cellValue(row.getCell(7)));
      } else {
        e.category = String(cellValue(row.getCell(8)) || 'Other').trim();
        e.maint = toPaise(cellValue(row.getCell(10)));
        e.corpus = toPaise(cellValue(row.getCell(11)));
      }
      if (e.maint + e.corpus === 0) throw new Error('Amount is zero');
      entries.push(e);
    } catch (err) {
      result.errors.push(`Row ${i}: ${err.message}`);
    }
  });
  if (result.errors.length && mode === 'replace') {
    throw Object.assign(new Error('Import aborted, nothing was changed'), { details: result.errors });
  }

  // 2) Write in a single transaction.
  await db.tx(async (t) => {
    const upsertFlat = (code, name) => t.run(`INSERT INTO flats (code, owner_name) VALUES ($1, $2)
      ON CONFLICT (code) DO UPDATE SET owner_name = EXCLUDED.owner_name`, [code, name]);
    const flatId = async (code, name) => {
      let f = await t.get('SELECT id FROM flats WHERE code = $1', [code]);
      if (!f) { await upsertFlat(code, name); f = await t.get('SELECT id FROM flats WHERE code = $1', [code]); result.flats++; }
      return f.id;
    };
    const catId = async (name) => {
      let c = await t.get('SELECT id FROM categories WHERE lower(name) = lower($1)', [name]);
      if (!c) {
        c = await t.get('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name]);
        result.categories++;
      }
      return c.id;
    };

    for (const f of infoFlats) { await upsertFlat(f.code, f.name); result.flats++; }
    for (const c of infoCats) await catId(c);
    if (mode === 'replace') await t.run('DELETE FROM transactions');

    for (const e of entries) {
      const fid = e.type === 'INC' ? await flatId(e.flat.code, e.flat.name) : null;
      const cid = e.type === 'EXP' ? await catId(e.category) : null;
      await t.run(`INSERT INTO transactions
        (txn_date, month, type, flat_id, category_id, description, maint_paise, corpus_paise, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.date, e.month, e.type, fid, cid, e.desc, e.maint, e.corpus, userId ?? null]);
      result.transactions++;
    }
    await audit(t, userId, 'import', 'transactions', null, { mode, ...result });
  });
  return result;
}

const rupees = (p) => p / 100;
const monthDate = (m) => new Date(`${m}-01T00:00:00Z`);

/** Build a workbook in the same layout as the original sheet. */
async function exportWorkbook(db, settings) {
  const wb = new ExcelJS.Workbook();
  wb.creator = settings.association_name || 'Vanagopal Kanakku';

  // Sheet order matches the original workbook.
  const s = wb.addWorksheet('Summary');
  const ws = wb.addWorksheet('Income_Expense');
  const info = wb.addWorksheet('Apartment_Info');

  // --- Income_Expense ---
  ws.addRow(['Transaction No/Date', '', '', '', '', '', '', 'Expenses', '', '', '', 'Balance']);
  ws.addRow(['Transaction #', 'Month', 'Date', 'Tran. Type', 'Flat No & Owner Name', 'Maint. Fund',
    'Corpus Fund', 'Expense \nCategory', 'Description', 'Paid from Maint. Fund',
    'Paid from Corpus Fund', 'Running Balance\nin Maintenance', 'Running Balance\nin Corpus Fund']);
  ws.getRow(1).font = { bold: true };
  ws.getRow(2).font = { bold: true };
  const rows = await ledger.listWithBalances(db);
  rows.forEach((t, i) => {
    const r = i + 3;
    const inc = t.type === 'INC';
    const row = ws.addRow([
      i + 1, monthDate(t.month), new Date(`${t.txn_date}T00:00:00Z`),
      inc ? 'INC.' : 'EXP.',
      inc ? `${t.flat_code} - ${t.owner_name}` : null,
      inc && t.maint_paise ? rupees(t.maint_paise) : null,
      inc && t.corpus_paise ? rupees(t.corpus_paise) : null,
      inc ? null : t.category,
      t.description || null,
      !inc && t.maint_paise ? rupees(t.maint_paise) : null,
      !inc && t.corpus_paise ? rupees(t.corpus_paise) : null,
      { formula: r === 3 ? 'F3-J3' : `L${r - 1}+F${r}-J${r}`, result: rupees(t.running_maint_paise) },
      { formula: r === 3 ? 'G3-K3' : `M${r - 1}+G${r}-K${r}`, result: rupees(t.running_corpus_paise) },
    ]);
    row.getCell(2).numFmt = 'mmm-yy';
    row.getCell(3).numFmt = 'dd-mm-yyyy';
  });
  ws.columns.forEach((c, i) => { c.width = [6, 10, 12, 8, 32, 12, 12, 22, 30, 14, 14, 16, 16][i]; });

  // --- Apartment_Info ---
  info.addRow(['Flat NO', 'Owner', '', 'Source of Fund', '', 'Expense Category', '', 'Tran. Type']);
  info.getRow(1).font = { bold: true };
  const flats = await db.all('SELECT code, owner_name FROM flats WHERE active ORDER BY code');
  const cats = await db.all('SELECT name FROM categories WHERE active ORDER BY id');
  const funds = ['Maint. Fund', 'Corpus Fund'];
  const types = ['INC.', 'EXP.'];
  const n = Math.max(flats.length, cats.length, 2);
  for (let i = 0; i < n; i++) {
    info.addRow([
      flats[i]?.code ?? null, flats[i] ? `${flats[i].code} - ${flats[i].owner_name}` : null, null,
      funds[i] ?? null, null, cats[i]?.name ?? null, null, types[i] ?? null,
    ]);
  }
  info.getColumn(2).width = 32;
  info.getColumn(6).width = 22;

  // --- Summary (static values, month-wise) ---
  const sum = await ledger.summary(db);
  s.addRow([`${settings.association_name || ''} Apartment Maintenance Accounts`]).font = { bold: true, size: 14 };
  s.addRow([]);
  s.addRow(['Month', 'Income: Maint. Fund', 'Income: Corpus Fund', 'Expense: Maint. Fund', 'Expense: Corpus Fund'])
    .font = { bold: true };
  for (const m of sum.months) {
    s.addRow([monthDate(m.month), rupees(m.income_maint_paise), rupees(m.income_corpus_paise),
      rupees(m.expense_maint_paise), rupees(m.expense_corpus_paise)]).getCell(1).numFmt = 'mmm-yy';
  }
  s.addRow(['Grand Total', rupees(sum.totals.income_maint_paise), rupees(sum.totals.income_corpus_paise),
    rupees(sum.totals.expense_maint_paise), rupees(sum.totals.expense_corpus_paise)]).font = { bold: true };
  s.addRow([]);
  s.addRow(['Balance in Maintenance Fund', rupees(sum.balances.maint_paise)]).font = { bold: true };
  s.addRow(['Balance in Corpus Fund', rupees(sum.balances.corpus_paise)]).font = { bold: true };
  s.columns.forEach((c) => { c.width = 22; });

  return wb.xlsx.writeBuffer();
}

module.exports = { importWorkbook, exportWorkbook, splitFlatLabel, toPaise };
