const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.PRIVATE_RADIO_DB_PATH || path.join(DATA_DIR, 'private-radio.db');

// Same read-only/read-write split as radio-db.js: a serverless host mounts the
// bundle read-only, so the catalog must already exist there; the import script
// overrides DB_READONLY=0 to build it.
const READ_ONLY =
  process.env.DB_READONLY === '1' ? true
  : process.env.DB_READONLY === '0' ? false
  : Boolean(process.env.VERCEL);

let handle = null;

function open() {
  if (handle) return handle;

  if (READ_ONLY) {
    handle = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    handle.pragma('foreign_keys = ON');
  } else {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    handle = new Database(DB_PATH);
    handle.pragma('foreign_keys = ON');
    handle.pragma('journal_mode = WAL');
  }
  return handle;
}

const db = new Proxy(Object.create(null), {
  get(_target, property) {
    const value = open()[property];
    return typeof value === 'function' ? value.bind(handle) : value;
  },
  set(_target, property, value) {
    open()[property] = value;
    return true;
  },
});

/**
 * One row per state-sheet product: a station's slot in a city, priced by the
 * second. There is no Location/Variant/Attribute breakdown in this workbook --
 * each sheet row is already the complete, generic rate card entry -- so this
 * schema stays a flat products/price_options pair instead of radio-db's full
 * typed-import shape.
 */
function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, source_sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
      name TEXT NOT NULL, sku TEXT NOT NULL UNIQUE,
      station TEXT NOT NULL, frequency REAL, city TEXT, state TEXT NOT NULL,
      time_band TEXT, listenership TEXT, rank REAL, status INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS price_options (
      id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL, name TEXT NOT NULL, sku TEXT NOT NULL,
      offer_rate REAL, pricing_unit TEXT, gst REAL,
      spot_duration_seconds REAL, spot_repetition_daily REAL, campaign_duration_days REAL,
      total_seconds REAL, sample_cost REAL, sample_gst REAL, sample_total_cost REAL,
      status INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS data_quality_issues (
      id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('error','warning')),
      code TEXT NOT NULL, field TEXT NOT NULL, current_value TEXT,
      suggested_value TEXT, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_private_radio_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_private_radio_products_state ON products(state);
    CREATE INDEX IF NOT EXISTS idx_private_radio_products_city ON products(city);
    CREATE INDEX IF NOT EXISTS idx_private_radio_price_options_product ON price_options(product_id);
    CREATE INDEX IF NOT EXISTS idx_private_radio_issues_product ON data_quality_issues(product_id);
  `);
}

if (!READ_ONLY) initializeSchema();

function finalize() {
  if (READ_ONLY) return;
  const handle = open();
  handle.pragma('wal_checkpoint(TRUNCATE)');
  handle.pragma('journal_mode = DELETE');
  handle.close();
}

module.exports = { db, DB_PATH, initializeSchema, finalize };
