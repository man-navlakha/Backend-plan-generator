const assert = require('node:assert/strict');
const { DB_PATH, SHEETS, quote, openMagazineDb } = require('../src/magazine-db');

const db = openMagazineDb();
try {
  const metadata = Object.fromEntries(
    db.prepare('SELECT key,value FROM import_metadata ORDER BY key').all()
      .map((row) => [row.key, row.value])
  );
  assert.equal(Number(metadata.sheet_count), SHEETS.length);
  assert.match(metadata.source_sha256, /^[a-f0-9]{64}$/);

  const manifest = db.prepare('SELECT * FROM workbook_sheets ORDER BY rowid').all();
  assert.equal(manifest.length, SHEETS.length);
  for (const definition of SHEETS) {
    const recorded = manifest.find((item) => item.sheet_name === definition.sheet);
    assert.ok(recorded, `Missing manifest row for ${definition.sheet}`);
    assert.equal(recorded.table_name, definition.table);
    const count = db.prepare(`SELECT COUNT(*) count FROM ${quote(definition.table)}`).get().count;
    assert.equal(count, recorded.row_count, `${definition.table}: count differs from import manifest`);
  }
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  console.log(`Magazine database OK: ${DB_PATH}`);
  console.table(Object.fromEntries(manifest.map((item) => [item.table_name, item.row_count])));
} finally {
  db.close();
}
