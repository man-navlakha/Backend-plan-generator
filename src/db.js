const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.TRANSIT_DB_PATH || path.join(DATA_DIR, 'transit.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      source_row INTEGER NOT NULL,
      delete_flag TEXT,
      name TEXT NOT NULL,
      sku TEXT NOT NULL,
      short_description TEXT,
      meta_title TEXT,
      meta_description TEXT,
      meta_keywords TEXT,
      image TEXT,
      sort_order INTEGER,
      status INTEGER NOT NULL DEFAULT 1,
      media_type TEXT,
      tier TEXT,
      size_dimension TEXT
    );

    CREATE TABLE IF NOT EXISTS price_options (
      id INTEGER PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      product_sku TEXT NOT NULL,
      name TEXT NOT NULL,
      sku TEXT NOT NULL,
      pricing_template_name TEXT,
      minimum_billing REAL,
      offer_rate REAL,
      specific_buying_rate REAL,
      discounted_rate REAL,
      pricing_unit TEXT,
      gst REAL,
      on_request TEXT,
      description_html TEXT,
      media_gallery TEXT,
      image TEXT,
      sort_order INTEGER,
      status INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS price_units (
      id INTEGER PRIMARY KEY,
      price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL,
      unit_name TEXT NOT NULL,
      code TEXT,
      step REAL,
      minimum REAL,
      maximum REAL,
      sort_order INTEGER
    );

    CREATE TABLE IF NOT EXISTS attributes (
      id INTEGER PRIMARY KEY,
      price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      sort_order INTEGER
    );

    CREATE TABLE IF NOT EXISTS attribute_values (
      id INTEGER PRIMARY KEY,
      attribute_id INTEGER REFERENCES attributes(id) ON DELETE CASCADE,
      price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL,
      attribute_name TEXT NOT NULL,
      value TEXT NOT NULL,
      sort_order INTEGER
    );

    CREATE TABLE IF NOT EXISTS pricing_options (
      id INTEGER PRIMARY KEY,
      price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      sort_order INTEGER
    );

    CREATE TABLE IF NOT EXISTS pricing_option_values (
      id INTEGER PRIMARY KEY,
      pricing_option_id INTEGER REFERENCES pricing_options(id) ON DELETE CASCADE,
      price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_row INTEGER NOT NULL,
      option_name TEXT NOT NULL,
      value TEXT NOT NULL,
      modify_type TEXT,
      modify_price REAL,
      sort_order INTEGER
    );

    CREATE TABLE IF NOT EXISTS data_quality_issues (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      price_option_id INTEGER REFERENCES price_options(id) ON DELETE CASCADE,
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
      code TEXT NOT NULL,
      field TEXT NOT NULL,
      current_value TEXT,
      suggested_value TEXT,
      message TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_media_tier ON products(media_type, tier);
    CREATE INDEX IF NOT EXISTS idx_price_options_product ON price_options(product_id);
    CREATE INDEX IF NOT EXISTS idx_price_options_sku ON price_options(sku);
    CREATE INDEX IF NOT EXISTS idx_price_units_option ON price_units(price_option_id);
    CREATE INDEX IF NOT EXISTS idx_attributes_option ON attributes(price_option_id);
    CREATE INDEX IF NOT EXISTS idx_attribute_values_attribute ON attribute_values(attribute_id);
    CREATE INDEX IF NOT EXISTS idx_pricing_options_option ON pricing_options(price_option_id);
    CREATE INDEX IF NOT EXISTS idx_pricing_option_values_parent ON pricing_option_values(pricing_option_id);
    CREATE INDEX IF NOT EXISTS idx_quality_product ON data_quality_issues(product_id);
    CREATE INDEX IF NOT EXISTS idx_quality_code ON data_quality_issues(code);
  `);
}

initializeSchema();

module.exports = { db, DB_PATH, initializeSchema };
