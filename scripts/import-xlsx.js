'use strict';
// Usage: node scripts/import-xlsx.js <file.xlsx> [--replace]
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db').open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'kanakku.db'));
const { importWorkbook } = require('../src/excel');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-xlsx.js <file.xlsx> [--replace]'); process.exit(1); }
const mode = process.argv.includes('--replace') ? 'replace' : 'append';
importWorkbook(db, fs.readFileSync(file), { mode })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); })
  .catch((e) => { console.error(e.message, e.details || ''); process.exit(1); });
