/**
 * Exports the combined Cinema catalog to a portable SQLite file.
 *
 *   node --env-file=.env scripts/export-cinema-db.js [--out=path]
 *
 * Default output: src/data/cinema-catalog.db, beside the other generated catalogs.
 *
 * Why this exists. Postgres is where the plan generator reads from, but it is not
 * something you can hand someone. This is one file that opens in any SQLite browser
 * and holds the whole combined card in the shape the client sheet uses: the 17
 * columns of the Cinema template, in template order, one row per screen.
 *
 * Tables:
 *
 *   screens         every row of both workbooks, 17 client-sheet columns first, then
 *                   provenance. Nothing is dropped and nothing is cleaned away --
 *                   a blank stays blank so it can be found and filled.
 *   findings        what is missing or inconsistent, per screen, per field. This is
 *                   the worklist: fix the workbook, re-import, re-export, and the
 *                   rows that were fixed disappear from here.
 *   sources         the two workbooks and what each contributed.
 *   import_metadata when it was built and from what.
 *
 * Views:
 *
 *   quotable_screens   the screens a plan may actually quote (is_quotable = 1), which
 *                      is one row per real screen -- the superseded duplicate of a
 *                      screen that appears in both workbooks is excluded.
 *   missing_fields     field -> how many screens are missing it, worst first.
 *   plan_sheet         exactly the 17 columns, in template order, nothing else, so it
 *                      can be exported straight back to the client format.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { rows, one, close } = require('../src/pg');

const CATALOG = 'cinema';
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg
  ? path.resolve(outArg.slice('--out='.length))
  : path.join(__dirname, '..', 'src', 'data', 'cinema-catalog.db');

/** The client template's 17 columns, in sheet order, with the SQLite column for each. */
const SHEET_COLUMNS = [
  ['sr_no', 'INTEGER'],
  ['state', 'TEXT'],
  ['city', 'TEXT'],
  ['screen_code', 'TEXT'],
  ['locality', 'TEXT'],
  ['pincode', 'TEXT'],
  ['theatre_type', 'TEXT'],
  ['multiplex_name', 'TEXT'],
  ['address', 'TEXT'],
  ['tier', 'TEXT'],
  ['capacity_preference', 'TEXT'],
  ['total_screen', 'INTEGER'],
  ['audi_no', 'INTEGER'],
  ['audi_type', 'TEXT'],
  ['cinema_chain', 'TEXT'],
  ['seating_capacity', 'INTEGER'],
  ['rate_10s_1week', 'REAL']
];

const SCHEMA = `
PRAGMA journal_mode = DELETE;

CREATE TABLE sources (
  key            TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  workbook       TEXT,
  sheets         INTEGER,
  screens        INTEGER,
  quotable       INTEGER,
  rate_basis     TEXT
);

CREATE TABLE screens (
  id                     INTEGER PRIMARY KEY,   -- matches masters.products.id in Postgres

  -- The 17 columns of the Cinema client template, in template order.
  ${SHEET_COLUMNS.map(([name, type]) => `${name.padEnd(22)} ${type},`).join('\n  ')}

  -- Where this row came from and whether a plan may quote it.
  source_file            TEXT NOT NULL,
  source_sheet           TEXT,
  source_row             INTEGER,
  is_quotable            INTEGER NOT NULL,      -- 0 = superseded by the newer workbook
  superseded             INTEGER NOT NULL DEFAULT 0,
  linked_screen_code     TEXT,                  -- the same screen in the other workbook
  other_source_rate      REAL,                  -- what the other workbook quoted
  filled_from            TEXT,                  -- JSON: field -> workbook a blank was filled from

  -- Derived, kept so the file is useful without recomputing anything.
  zone                   TEXT,
  venue_key              TEXT,
  rate_per_second_week   REAL,                  -- what the costing engine multiplies
  blank_field_count      INTEGER NOT NULL DEFAULT 0,

  FOREIGN KEY (source_file) REFERENCES sources(key)
);

CREATE TABLE findings (
  id            INTEGER PRIMARY KEY,
  screen_id     INTEGER REFERENCES screens(id) ON DELETE CASCADE,
  severity      TEXT NOT NULL,
  code          TEXT NOT NULL,
  field         TEXT,
  current_value TEXT,
  message       TEXT NOT NULL,
  source_sheet  TEXT,
  source_row    INTEGER
);

CREATE TABLE import_metadata (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX screens_city_idx      ON screens (city);
CREATE INDEX screens_state_idx     ON screens (state);
CREATE INDEX screens_chain_idx     ON screens (cinema_chain);
CREATE INDEX screens_code_idx      ON screens (screen_code);
CREATE INDEX screens_quotable_idx  ON screens (is_quotable);
CREATE INDEX screens_source_idx    ON screens (source_file);
CREATE INDEX screens_venue_idx     ON screens (venue_key);
CREATE INDEX findings_screen_idx   ON findings (screen_id);
CREATE INDEX findings_code_idx     ON findings (code);
CREATE INDEX findings_field_idx    ON findings (field);

-- One row per real screen: what a plan may quote.
CREATE VIEW quotable_screens AS
  SELECT * FROM screens WHERE is_quotable = 1;

-- The worklist, worst field first.
CREATE VIEW missing_fields AS
  SELECT field, COUNT(*) AS screens_affected
    FROM findings
   WHERE code LIKE 'MISSING_%'
   GROUP BY field
   ORDER BY screens_affected DESC;

-- The client sheet, exactly: 17 columns, template order, quotable screens only.
CREATE VIEW plan_sheet AS
  SELECT ${SHEET_COLUMNS.map(([n]) => n).join(', ')}
    FROM screens
   WHERE is_quotable = 1
   ORDER BY state, city, multiplex_name, audi_no;
`;

/** Counts how many of the 17 sheet columns are blank on a row. */
function blankCount(row) {
  return SHEET_COLUMNS.reduce(
    (n, [name]) => (row[name] === null || row[name] === undefined || row[name] === '' ? n + 1 : n),
    0
  );
}

async function main() {
  const catalog = await one('select * from masters.catalogs where slug=$1', [CATALOG]);
  if (!catalog) {
    throw new Error(`catalog ${CATALOG} is not loaded — run npm run db:import:cinema first`);
  }

  console.log('Reading from Postgres ...');
  const products = await rows(`
    select p.id, p.sort_order, p.state, p.city, p.locality, p.zone, p.status,
           p.attrs, po.offer_rate, po.template
      from masters.products p
      left join masters.price_options po on po.product_id = p.id
     where p.catalog = $1
     order by p.id
  `, [CATALOG]);

  const findings = await rows(`
    select id, product_id, severity, code, field, current_value, message,
           source_sheet, source_row
      from masters.data_quality_issues
     where catalog = $1
     order by id
  `, [CATALOG]);

  console.log(`  ${products.length} screens, ${findings.length} findings`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  /*
   * Rebuild in place rather than deleting the file first.
   *
   * On Windows, deleting a file any other process holds a handle on fails with EPERM,
   * and the obvious other process is the SQLite browser someone left the last export
   * open in. Dropping and recreating the objects inside the existing file works while
   * a reader is attached, and VACUUM at the end reclaims what the old rows used, so
   * the result is the same file a fresh build would produce.
   *
   * Only this exporter's own objects are dropped, and only ours are named here, so a
   * stray table someone added by hand is left alone rather than silently destroyed.
   */
  const db = new Database(OUT);
  try {
    for (const view of ['plan_sheet', 'quotable_screens', 'missing_fields']) {
      db.exec(`DROP VIEW IF EXISTS ${view}`);
    }
    for (const table of ['findings', 'screens', 'sources', 'import_metadata']) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(SCHEMA);

    const sourceMeta = {
      pan_india_2025: {
        label: 'PAN India card, 07-04-2025',
        workbook: 'Cinema PAN India 07-04-2025 old.xlsx',
        sheets: 26,
        rate_basis: 'column "Rates for 10 Sec :A/V Slide  (1 Week)" as printed'
      },
      from_csvs_2026: {
        label: 'Generated from current master CSVs, 2026',
        workbook: 'Cinema_PAN_India_From_CSVs.xlsx',
        sheets: 33,
        rate_basis: 'column headed "A/V Slide" but verified to be the master Ad Film offer rate x 10'
      }
    };

    const screenColumnNames = SHEET_COLUMNS.map(([n]) => n);
    const insertScreen = db.prepare(`
      INSERT INTO screens (
        id, ${screenColumnNames.join(', ')},
        source_file, source_sheet, source_row, is_quotable, superseded,
        linked_screen_code, other_source_rate, filled_from,
        zone, venue_key, rate_per_second_week, blank_field_count
      ) VALUES (
        @id, ${screenColumnNames.map((n) => `@${n}`).join(', ')},
        @source_file, @source_sheet, @source_row, @is_quotable, @superseded,
        @linked_screen_code, @other_source_rate, @filled_from,
        @zone, @venue_key, @rate_per_second_week, @blank_field_count
      )
    `);

    const insertFinding = db.prepare(`
      INSERT INTO findings (id, screen_id, severity, code, field, current_value,
                            message, source_sheet, source_row)
      VALUES (@id, @screen_id, @severity, @code, @field, @current_value,
              @message, @source_sheet, @source_row)
    `);

    const insertSource = db.prepare(`
      INSERT INTO sources (key, label, workbook, sheets, screens, quotable, rate_basis)
      VALUES (@key, @label, @workbook, @sheets, @screens, @quotable, @rate_basis)
    `);

    const insertMeta = db.prepare('INSERT INTO import_metadata (key, value) VALUES (?, ?)');

    const tally = new Map();

    const load = db.transaction(() => {
      for (const [key, meta] of Object.entries(sourceMeta)) {
        insertSource.run({ key, ...meta, screens: 0, quotable: 0 });
      }

      for (const p of products) {
        const a = p.attrs || {};
        const row = {
          id: Number(p.id),
          sr_no: p.sort_order,
          state: p.state,
          city: p.city,
          screen_code: a.screen_code ?? null,
          locality: p.locality,
          pincode: a.pincode ?? null,
          theatre_type: a.theatre_type ?? null,
          multiplex_name: a.multiplex_name ?? null,
          address: a.address ?? null,
          tier: a.tier ?? null,
          capacity_preference: a.capacity_preference ?? null,
          total_screen: a.total_screen ?? null,
          audi_no: a.audi_no ?? null,
          audi_type: a.audi_type ?? null,
          cinema_chain: a.cinema_chain ?? null,
          seating_capacity: a.seating_capacity ?? null,
          rate_10s_1week: a.rate_10s_week ?? null,

          source_file: a.source_file || 'unknown',
          source_sheet: a.source_sheet ?? null,
          source_row: p.source_row ?? null,
          is_quotable: p.status === 1 ? 1 : 0,
          superseded: a.superseded ? 1 : 0,
          linked_screen_code: a.linked_screen_code ?? null,
          other_source_rate: a.other_source_rate_10s_week ?? null,
          filled_from: a.filled_from ? JSON.stringify(a.filled_from) : null,
          zone: p.zone,
          venue_key: a.venue_key ?? null,
          rate_per_second_week: p.offer_rate === null ? null : Number(p.offer_rate),
          blank_field_count: 0
        };
        row.blank_field_count = blankCount(row);
        insertScreen.run(row);

        const t = tally.get(row.source_file) || { screens: 0, quotable: 0 };
        t.screens += 1;
        t.quotable += row.is_quotable;
        tally.set(row.source_file, t);
      }

      for (const f of findings) {
        insertFinding.run({
          id: Number(f.id),
          screen_id: f.product_id === null ? null : Number(f.product_id),
          severity: f.severity,
          code: f.code,
          field: f.field,
          current_value: f.current_value,
          message: f.message,
          source_sheet: f.source_sheet,
          source_row: f.source_row
        });
      }

      const updateSource = db.prepare('UPDATE sources SET screens=?, quotable=? WHERE key=?');
      for (const [key, t] of tally) updateSource.run(t.screens, t.quotable, key);

      for (const [key, value] of Object.entries({
        catalog: CATALOG,
        label: catalog.label,
        workbooks: catalog.workbook,
        postgres_imported_at: catalog.imported_at.toISOString(),
        exported_at: new Date().toISOString(),
        row_counts: JSON.stringify(catalog.row_counts),
        screens: String(products.length),
        findings: String(findings.length),
        rate_note: 'rate_10s_1week is the figure the client sheet prints (10 seconds, '
          + '1 week). rate_per_second_week is that divided by 10, which is what the '
          + 'costing engine multiplies by seconds and weeks.',
        completeness_note: 'Rows with blank fields are kept on purpose. blank_field_count '
          + 'says how many of the 17 columns are empty; the findings table says which.'
      })) {
        insertMeta.run(key, value);
      }
    });

    load();

    /*
     * No `optimize` pragma here.
     *
     * It runs ANALYZE, which writes sqlite_stat1 and sqlite_stat4 -- query-planner
     * statistics that hold no cinema data but show up as two extra tables in every
     * SQLite browser, next to the four that matter. This file is handed to people to
     * read, and 20,665 rows behind the indexes below do not need a planner hint.
     * Dropped defensively too, in case an earlier build of this file left them.
     */
    db.exec('DROP TABLE IF EXISTS sqlite_stat1');
    db.exec('DROP TABLE IF EXISTS sqlite_stat4');
    db.exec('VACUUM');

    const check = db.prepare('SELECT COUNT(*) n FROM screens').get().n;
    const quot = db.prepare('SELECT COUNT(*) n FROM quotable_screens').get().n;
    const find = db.prepare('SELECT COUNT(*) n FROM findings').get().n;
    const integrity = db.pragma('integrity_check');

    console.log(`\nWrote ${OUT}`);
    console.log(`  ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`  screens ${check}, quotable ${quot}, findings ${find}`);
    console.log(`  integrity_check: ${JSON.stringify(integrity)}`);

    console.log('\nsources:');
    console.table(db.prepare('SELECT key, sheets, screens, quotable FROM sources').all());
    console.log('\nmissing_fields (the worklist):');
    console.table(db.prepare('SELECT * FROM missing_fields').all());
    console.log('\nquotable screens by chain:');
    console.table(db.prepare(
      'SELECT cinema_chain, COUNT(*) screens FROM quotable_screens GROUP BY 1 ORDER BY 2 DESC'
    ).all());
  } finally {
    db.close();
  }
}

main()
  .then(() => close())
  .catch(async (error) => {
    console.error('\nFailed:', error.message);
    // The one failure with an obvious cause and an obvious fix: something else has the
    // file open for writing. Say so instead of leaving a stack trace to interpret.
    if (/SQLITE_BUSY|database is locked|EPERM|EBUSY/i.test(error.message)) {
      console.error(
        `\n${OUT} is locked by another program.\n`
        + 'Close it in your SQLite browser and run this again, '
        + 'or write elsewhere with --out=some/other/path.db'
      );
    } else {
      console.error(error.stack);
    }
    await close();
    process.exit(1);
  });
