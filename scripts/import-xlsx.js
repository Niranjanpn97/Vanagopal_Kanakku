'use strict';
// Usage: node scripts/import-xlsx.js <file.xlsx> [--replace]
const fs = require('node:fs');
const { connect } = require('../src/db');
const { importWorkbook } = require('../src/excel');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/import-xlsx.js <file.xlsx> [--replace]'); process.exit(1); }
  const mode = process.argv.includes('--replace') ? 'replace' : 'append';
  const db = await connect();
  console.log(JSON.stringify(await importWorkbook(db, fs.readFileSync(file), { mode }), null, 2));
  await db.close();
})().catch((e) => { console.error(e.message, e.details || ''); process.exit(1); });
