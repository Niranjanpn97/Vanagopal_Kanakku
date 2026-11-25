'use strict';
// Import from / export to the association's existing Excel layout
// (sheets: Income_Expense, Apartment_Info, Summary).
const ExcelJS = require('exceljs');
const { tx, audit } = require('./db');
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

  tx(db, () => {
    const upsertFlat = db.prepare(`INSERT INTO flats (code, owner_name) VALUES (?, ?)
      ON CONFLICT(code) DO UPDATE SET owner_name = excluded.owner_name`);
    const insCat = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');

    if (info) {
      info.eachRow((row, i) => {
        if (i === 1) return;
        const code = cellValue(row.getCell(1));
        const label = cellValue(row.getCell(2));
        if (code && label) {
          const s = splitFlatLabel(label);
          upsertFlat.run(String(code).trim().toUpperCase(), s ? s.name : String(label).trim());
          result.flats++;
        }
        const cat = cellValue(row.getCell(6));
        if (cat && insCat.run(String(cat).trim()).changes) result.categories++;
      });
    }

    if (mode === 'replace') db.exec('DELETE FROM transactions');

    const flatByCode = db.prepare('SELECT id FROM flats WHERE code = ?');
    const catByName = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE');
    const ins = db.prepare(`INSERT INTO transactions
      (txn_date, month, type, flat_id, category_id, description, maint_paise, corpus_paise, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    ledgerWs.eachRow((row, i) => {
      if (i <= 2) return; // two header rows
      const typeRaw = cellValue(row.getCell(4));
      if (!typeRaw) return; // empty/formula-only row
      try {
        const type = String(typeRaw).toUpperCase().startsWith('INC') ? 'INC'
          : String(typeRaw).toUpperCase().startsWith('EXP') ? 'EXP' : null;
        if (!type) throw new Error(`Unknown Tran. Type "${typeRaw}"`);
        const date = isoDate(cellValue(row.getCell(3)));
        if (!date) throw new Error('Missing/invalid Date');
        const monthIso = isoDate(cellValue(row.getCell(2)));
        const month = (monthIso || date).slice(0, 7);
        let flatId = null, catId = null, maint, corpus;
        const desc = String(cellValue(row.getCell(9)) || '').trim();
        if (type === 'INC') {
          const s = splitFlatLabel(cellValue(row.getCell(5)));
          if (!s) throw new Error(`Cannot read flat from "${cellValue(row.getCell(5))}"`);
          let f = flatByCode.get(s.code);
          if (!f) { upsertFlat.run(s.code, s.name); f = flatByCode.get(s.code); result.flats++; }
          flatId = f.id;
          maint = toPaise(cellValue(row.getCell(6)));
          corpus = toPaise(cellValue(row.getCell(7)));
        } else {
          const name = String(cellValue(row.getCell(8)) || 'Other').trim();
          let c = catByName.get(name);
          if (!c) { insCat.run(name); c = catByName.get(name); result.categories++; }
          catId = c.id;
          maint = toPaise(cellValue(row.getCell(10)));
          corpus = toPaise(cellValue(row.getCell(11)));
        }
        if (maint + corpus === 0) throw new Error('Amount is zero');
        ins.run(date, month, type, flatId, catId, desc, maint, corpus, userId ?? null);
        result.transactions++;
      } catch (e) {
        result.errors.push(`Row ${i}: ${e.message}`);
      }
    });
    if (result.errors.length && mode === 'replace') {
      throw Object.assign(new Error('Import aborted'), { details: result.errors });
    }
    audit(db, userId, 'import', 'transactions', null, { mode, ...result });
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
  const rows = ledger.listWithBalances(db);
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
  const flats = db.prepare('SELECT code, owner_name FROM flats WHERE active = 1 ORDER BY code').all();
  const cats = db.prepare('SELECT name FROM categories WHERE active = 1 ORDER BY id').all();
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
  const sum = ledger.summary(db);
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
