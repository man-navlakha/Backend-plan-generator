const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const {
  DB_PATH,
  SHEETS,
  quote,
  initializeSchema,
  ensureDatabaseDirectory
} = require('../src/magazine-db');

const DEFAULT_WORKBOOK = path.join(
  __dirname,
  '../src/assets/Masters/print/Magazine/Magazine-Master-22-09-2026.xlsx'
);
const workbookPath = path.resolve(process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]) || DEFAULT_WORKBOOK);
const targetPath = path.resolve(process.env.MAGAZINE_DB_PATH || DB_PATH);
const replace = process.argv.includes('--replace');
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 5;

function cellValue(input) {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) return input.toISOString();
  if (typeof input !== 'object') return input;
  if (Array.isArray(input.richText)) return input.richText.map((part) => part.text).join('');
  if (Object.hasOwn(input, 'result')) return cellValue(input.result);
  if (Object.hasOwn(input, 'text')) return input.text;
  if (Object.hasOwn(input, 'error')) return input.error;
  return JSON.stringify(input);
}

function sourceRows(sheet, definition) {
  const headers = definition.columns.map(([, header]) => header);
  const actualHeaders = headers.map((_header, index) =>
    cellValue(sheet.getRow(HEADER_ROW).getCell(index + 1).value)
  );
  assert.deepEqual(
    actualHeaders,
    headers,
    `${sheet.name}: row ${HEADER_ROW} does not match the expected workbook columns`
  );

  const rows = [];
  for (let sourceRow = FIRST_DATA_ROW; sourceRow <= sheet.actualRowCount; sourceRow += 1) {
    const values = headers.map((_header, index) =>
      cellValue(sheet.getRow(sourceRow).getCell(index + 1).value)
    );
    if (!values.some((value) => value !== null && value !== '')) continue;
    rows.push({
      sourceRow,
      values,
      raw: Object.fromEntries(headers.map((header, index) => [header, values[index]]))
    });
  }
  return rows;
}

function verifyDatabase(db, imported) {
  for (const definition of SHEETS) {
    const expected = imported.get(definition.sheet);
    const columns = definition.columns.map(([name]) => quote(name)).join(', ');
    const actual = db.prepare(
      `SELECT source_row, ${columns}, raw_json FROM ${quote(definition.table)} ORDER BY source_row`
    ).all();
    assert.equal(actual.length, expected.length, `${definition.sheet}: row count changed during import`);
    expected.forEach((source, index) => {
      const row = actual[index];
      assert.equal(row.source_row, source.sourceRow, `${definition.sheet}: source row changed`);
      definition.columns.forEach(([name], columnIndex) => {
        assert.deepEqual(
          row[name],
          source.values[columnIndex],
          `${definition.sheet}!${definition.columns[columnIndex][1]}${source.sourceRow} changed during import`
        );
      });
      assert.deepEqual(JSON.parse(row.raw_json), source.raw, `${definition.sheet}: raw row changed`);
    });
  }
  const integrity = db.pragma('integrity_check');
  assert.deepEqual(integrity, [{ integrity_check: 'ok' }]);
}

async function main() {
  if (!fs.existsSync(workbookPath)) throw new Error(`Magazine workbook not found: ${workbookPath}`);
  if (fs.existsSync(targetPath) && !replace) {
    throw new Error(`Magazine database already exists: ${targetPath}. Use --replace to create a verified replacement.`);
  }

  ensureDatabaseDirectory(targetPath);
  const temporaryPath = `${targetPath}.import-${process.pid}-${Date.now()}`;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const workbookSheets = workbook.worksheets.map((sheet) => sheet.name);
  assert.deepEqual(
    workbookSheets,
    SHEETS.map((definition) => definition.sheet),
    'Workbook sheets changed; no sheet was imported because the database must remain one-to-one with the workbook'
  );

  const imported = new Map();
  for (const definition of SHEETS) {
    imported.set(definition.sheet, sourceRows(workbook.getWorksheet(definition.sheet), definition));
  }

  let db;
  try {
    db = new Database(temporaryPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('foreign_keys = ON');
    initializeSchema(db);

    db.transaction(() => {
      for (const definition of SHEETS) {
        const names = definition.columns.map(([name]) => name);
        const placeholders = Array(names.length + 2).fill('?').join(', ');
        const insert = db.prepare(`INSERT INTO ${quote(definition.table)}
          (source_row, ${names.map(quote).join(', ')}, raw_json)
          VALUES (${placeholders})`);
        const rows = imported.get(definition.sheet);
        for (const row of rows) insert.run(row.sourceRow, ...row.values, JSON.stringify(row.raw));
        db.prepare(`INSERT INTO workbook_sheets
          (sheet_name,table_name,header_row,first_data_row,row_count,columns_json)
          VALUES (?,?,?,?,?,?)`).run(
          definition.sheet,
          definition.table,
          HEADER_ROW,
          FIRST_DATA_ROW,
          rows.length,
          JSON.stringify(definition.columns.map(([name, header, type]) => ({ name, header, type })))
        );
      }

      const metadata = db.prepare('INSERT INTO import_metadata (key,value) VALUES (?,?)');
      metadata.run('source_file', workbookPath);
      metadata.run('source_sha256', crypto.createHash('sha256').update(fs.readFileSync(workbookPath)).digest('hex'));
      metadata.run('imported_at', new Date().toISOString());
      metadata.run('workbook_name', path.basename(workbookPath));
      metadata.run('sheet_count', String(SHEETS.length));
    })();

    verifyDatabase(db, imported);
    db.close();
    db = null;

    if (fs.existsSync(targetPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extension = path.extname(targetPath);
      const base = path.basename(targetPath, extension);
      const backupPath = path.join(path.dirname(targetPath), `${base}.backup-${stamp}${extension}`);
      fs.renameSync(targetPath, backupPath);
      console.log(`Preserved previous database at ${backupPath}`);
    }
    fs.renameSync(temporaryPath, targetPath);

    console.log(`Imported Magazine master without changing the workbook: ${workbookPath}`);
    console.log(`Database: ${targetPath}`);
    console.table(Object.fromEntries(SHEETS.map((definition) => [
      definition.table,
      imported.get(definition.sheet).length
    ])));
  } catch (error) {
    if (db) db.close();
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
