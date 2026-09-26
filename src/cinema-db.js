const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.CINEMA_DB_PATH || path.join(__dirname, 'data/cinema.db');
const READ_ONLY = process.env.DB_READONLY === '1' ? true
  : process.env.DB_READONLY === '0' ? false : Boolean(process.env.VERCEL);
let handle;

function open() {
  if (handle) return handle;
  if (READ_ONLY) {
    handle = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } else {
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
    CREATE TABLE IF NOT EXISTS import_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, source_row INTEGER NOT NULL, name TEXT NOT NULL, sku TEXT NOT NULL,
      description TEXT, meta_title TEXT, meta_description TEXT, meta_keywords TEXT, image TEXT,
      sort_order INTEGER, status INTEGER, cinema_chain TEXT, screen_recommend INTEGER,
      audience_class TEXT, tier TEXT, seats INTEGER, screen TEXT, rank INTEGER,
      total_screen INTEGER, google_map_location TEXT
    );
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL, type TEXT, zone TEXT, state TEXT, city TEXT, locality TEXT,
      pincode INTEGER
    );
    CREATE TABLE IF NOT EXISTS price_options (
      id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL, product_name TEXT, product_sku TEXT, name TEXT NOT NULL,
      sku TEXT NOT NULL, template TEXT, minimum_billing REAL, offer_rate REAL,
      buying_rate REAL, discounted_rate REAL, pricing_unit TEXT, gst REAL, on_request TEXT,
      description_html TEXT, media_gallery TEXT, image TEXT, sort_order INTEGER, status INTEGER
    );
    CREATE TABLE IF NOT EXISTS price_units (
      id INTEGER PRIMARY KEY, price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL, name TEXT, code TEXT, step REAL, minimum REAL,
      maximum REAL, sort_order INTEGER
    );
    CREATE TABLE IF NOT EXISTS offer_rate_sources (
      id INTEGER PRIMARY KEY, price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL, price_option_sku TEXT NOT NULL, product_name TEXT,
      screen TEXT, rate_source TEXT, basis TEXT, source_rate REAL, divide_by REAL, offer_rate REAL
    );
    CREATE TABLE IF NOT EXISTS qube_rate_card (
      id INTEGER PRIMARY KEY, source_row INTEGER NOT NULL, section TEXT NOT NULL,
      name TEXT NOT NULL, rate REAL NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_cinema_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_cinema_products_chain ON products(cinema_chain);
    CREATE INDEX IF NOT EXISTS idx_cinema_locations_product ON locations(product_id);
    CREATE INDEX IF NOT EXISTS idx_cinema_locations_city ON locations(city);
    CREATE INDEX IF NOT EXISTS idx_cinema_options_product ON price_options(product_id);
    CREATE INDEX IF NOT EXISTS idx_cinema_options_sku ON price_options(sku);
    CREATE INDEX IF NOT EXISTS idx_cinema_units_option ON price_units(price_option_id);
    CREATE INDEX IF NOT EXISTS idx_cinema_sources_option ON offer_rate_sources(price_option_id);
    CREATE INDEX IF NOT EXISTS idx_cinema_rate_card_section ON qube_rate_card(section,name);
    CREATE INDEX IF NOT EXISTS idx_cinema_issues_product ON data_quality_issues(product_id);
    CREATE INDEX IF NOT EXISTS idx_cinema_issues_code ON data_quality_issues(code);
  `);

  // Databases imported before PIN Code was read from the master predate the
  // column, and CREATE TABLE IF NOT EXISTS leaves them as they are.
  const columns = db.prepare('PRAGMA table_info(locations)').all();
  if (!columns.some((column) => column.name === 'pincode')) {
    db.exec('ALTER TABLE locations ADD COLUMN pincode INTEGER');
  }
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
    console.warn('Cinema catalog is in use; leaving SQLite in WAL mode for this local import.');
  }
  connection.close();
  handle = null;
}

module.exports = { db, DB_PATH, initializeSchema, finalize };
