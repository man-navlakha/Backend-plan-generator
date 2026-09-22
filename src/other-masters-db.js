const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OTHER_MASTERS_DB_PATH || path.join(__dirname, 'data/other-masters.db');
const READ_ONLY = process.env.DB_READONLY === '1' ? true
  : process.env.DB_READONLY === '0' ? false : Boolean(process.env.VERCEL);
let handle;

function open() {
  if (handle) return handle;
  if (READ_ONLY) handle = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  else {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    handle = new Database(DB_PATH);
    handle.pragma('journal_mode = WAL');
  }
  handle.pragma('foreign_keys = ON');
  return handle;
}

const db = new Proxy(Object.create(null), {
  get(_target, key) {
    const value = open()[key];
    return typeof value === 'function' ? value.bind(handle) : value;
  }
});

function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogs (
      slug TEXT PRIMARY KEY, label TEXT NOT NULL, workbook TEXT NOT NULL,
      imported_at TEXT NOT NULL, sheet_counts_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, catalog_slug TEXT NOT NULL REFERENCES catalogs(slug) ON DELETE CASCADE,
      source_row INTEGER NOT NULL, sku TEXT, name TEXT, description TEXT, image TEXT,
      image_url TEXT, status INTEGER, sort_order INTEGER, fields_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS related_rows (
      id INTEGER PRIMARY KEY, catalog_slug TEXT NOT NULL REFERENCES catalogs(slug) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      option_id INTEGER REFERENCES related_rows(id) ON DELETE CASCADE,
      sheet TEXT NOT NULL, source_row INTEGER NOT NULL, product_sku TEXT,
      option_sku TEXT, name TEXT, price REAL, buying_rate REAL, discounted_rate REAL,
      minimum_billing REAL, pricing_unit TEXT, image_url TEXT, fields_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS data_quality_issues (
      id INTEGER PRIMARY KEY, catalog_slug TEXT NOT NULL REFERENCES catalogs(slug) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      related_row_id INTEGER REFERENCES related_rows(id) ON DELETE CASCADE,
      sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('error','warning')),
      code TEXT NOT NULL, field TEXT NOT NULL, current_value TEXT,
      suggested_value TEXT, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_other_products_catalog ON products(catalog_slug,sku);
    CREATE INDEX IF NOT EXISTS idx_other_rows_catalog_sheet ON related_rows(catalog_slug,sheet);
    CREATE INDEX IF NOT EXISTS idx_other_rows_product ON related_rows(product_id,sheet);
    CREATE INDEX IF NOT EXISTS idx_other_rows_option ON related_rows(option_id,sheet);
    CREATE INDEX IF NOT EXISTS idx_other_issues_catalog ON data_quality_issues(catalog_slug,code);
    CREATE INDEX IF NOT EXISTS idx_other_issues_product ON data_quality_issues(product_id);
  `);
}

if (!READ_ONLY) initializeSchema();

function finalize() {
  if (READ_ONLY) return;
  const connection = open();
  connection.pragma('wal_checkpoint(TRUNCATE)');
  try {
    connection.pragma('journal_mode = DELETE');
  } catch (error) {
    if (error.code !== 'SQLITE_BUSY') throw error;
    console.warn('Shared catalog is in use; leaving SQLite in WAL mode for this local import.');
  }
  connection.close();
  handle = null;
}

module.exports = { db, DB_PATH, finalize };
