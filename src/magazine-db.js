const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.MAGAZINE_DB_PATH || path.join(__dirname, 'data/magazine.db');

// One database table for every worksheet in Magazine-Master-22-09-2026.xlsx.
// `header` is kept separately from the SQL column name so the importer can
// prove that every source cell was copied without changing the workbook.
const SHEETS = [
  {
    sheet: 'Product',
    table: 'products',
    columns: [
      ['delete_flag', 'Delete', 'TEXT'],
      ['product_name', 'Product Name', 'TEXT'],
      ['sku', 'Sku', 'TEXT'],
      ['short_description', 'Short Description', 'TEXT'],
      ['meta_title', 'Meta Title', 'TEXT'],
      ['meta_description', 'Meta Description', 'TEXT'],
      ['meta_keywords', 'Meta Keywords', 'TEXT'],
      ['image', 'Image', 'TEXT'],
      ['sort_order', 'Sort Order', 'NUMERIC'],
      ['status', 'Status', 'NUMERIC'],
      ['category', 'Category', 'TEXT'],
      ['frequency', 'Frequency', 'TEXT'],
      ['languages', 'Language (Multiple)', 'TEXT'],
      ['country', 'Country', 'TEXT'],
      ['edition', 'Edition', 'TEXT'],
      ['circulation', 'Circulation', 'NUMERIC']
    ],
    indexes: [['sku'], ['product_name'], ['category'], ['frequency'], ['languages']]
  },
  {
    sheet: 'Price Option',
    table: 'price_options',
    columns: [
      ['delete_flag', 'Delete', 'TEXT'],
      ['product_name', 'Product Name', 'TEXT'],
      ['product_sku', 'Product Sku', 'TEXT'],
      ['price_option_name', 'Price Option Name', 'TEXT'],
      ['price_option_sku', 'Price Option Sku', 'TEXT'],
      ['pricing_template_name', 'Pricing Template Name', 'TEXT'],
      ['minimum_billing', 'Minimum Billing', 'NUMERIC'],
      ['offer_rate', 'Offer Rate', 'NUMERIC'],
      ['discounted_rate', 'Discounted Rate', 'NUMERIC'],
      ['specific_buying_rate', 'Specific Buying Rate', 'NUMERIC'],
      ['pricing_unit', 'Pricing Unit', 'TEXT'],
      ['gst', 'GST', 'NUMERIC'],
      ['on_request', 'On Request', 'TEXT'],
      ['description', 'Description', 'TEXT'],
      ['media_gallery', 'Media Gallery', 'TEXT'],
      ['image', 'Image', 'TEXT'],
      ['sort_order', 'Sort Order', 'NUMERIC'],
      ['status', 'Status', 'NUMERIC']
    ],
    indexes: [['product_sku'], ['price_option_sku']]
  },
  {
    sheet: 'Price Unit',
    table: 'price_units',
    columns: [
      ['delete_flag', 'Delete', 'TEXT'],
      ['product_name', 'Product Name', 'TEXT'],
      ['product_sku', 'Product Sku', 'TEXT'],
      ['price_option_name', 'Price Option Name', 'TEXT'],
      ['price_option_sku', 'Price Option Sku', 'TEXT'],
      ['unit_name', 'Unit Name', 'TEXT'],
      ['code', 'Code', 'TEXT'],
      ['step', 'Step', 'NUMERIC'],
      ['minimum', 'Minimum', 'NUMERIC'],
      ['maximum', 'Maximum', 'NUMERIC'],
      ['sort_order', 'Sort Order', 'NUMERIC']
    ],
    indexes: [['product_sku'], ['price_option_sku'], ['code']]
  },
  {
    sheet: 'Attribute',
    table: 'attributes',
    columns: [
      ['delete_flag', 'Delete', 'TEXT'],
      ['product_name', 'Product Name', 'TEXT'],
      ['product_sku', 'Product Sku', 'TEXT'],
      ['price_option_name', 'Price Option Name', 'TEXT'],
      ['price_option_sku', 'Price Option Sku', 'TEXT'],
      ['attribute_name', 'Attribute Name', 'TEXT'],
      ['attribute_type', 'Attribute Type', 'TEXT'],
      ['sort_order', 'Sort Order', 'NUMERIC']
    ],
    indexes: [['product_sku'], ['price_option_sku'], ['attribute_name']]
  },
  {
    sheet: 'Attribute Value',
    table: 'attribute_values',
    columns: [
      ['delete_flag', 'Delete', 'TEXT'],
      ['product_name', 'Product Name', 'TEXT'],
      ['product_sku', 'Product Sku', 'TEXT'],
      ['price_option_name', 'Price Option Name', 'TEXT'],
      ['price_option_sku', 'Price Option Sku', 'TEXT'],
      ['attribute_name', 'Attribute Name', 'TEXT'],
      ['attribute_value', 'Attribute Value', 'TEXT'],
      ['sort_order', 'Sort Order', 'NUMERIC']
    ],
    indexes: [['product_sku'], ['price_option_sku'], ['attribute_name'], ['attribute_value']]
  },
  {
    sheet: 'Variant',
    table: 'variants',
    columns: [
      ['product_name', 'Product Name', 'TEXT'],
      ['product_sku', 'Product Sku', 'TEXT'],
      ['price_option_name', 'Price Option Name', 'TEXT'],
      ['price_option_sku', 'Price Option Sku', 'TEXT'],
      ['variant_name', 'Variant Name', 'TEXT'],
      ['is_enable', 'Is Enable', 'NUMERIC'],
      ['price', 'Price', 'NUMERIC'],
      ['attribute_1', 'Attribute 1', 'TEXT'],
      ['attribute_2', 'Attribute 2', 'TEXT'],
      ['attribute_3', 'Attribute 3', 'TEXT'],
      ['attribute_4', 'Attribute 4', 'TEXT'],
      ['attribute_5', 'Attribute 5', 'TEXT'],
      ['attribute_6', 'Attribute 6', 'TEXT']
    ],
    indexes: [['product_sku'], ['price_option_sku'], ['variant_name']]
  }
];

function quote(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE import_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE workbook_sheets (
      sheet_name TEXT PRIMARY KEY,
      table_name TEXT NOT NULL UNIQUE,
      header_row INTEGER NOT NULL,
      first_data_row INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      columns_json TEXT NOT NULL
    );
  `);

  for (const definition of SHEETS) {
    const columns = definition.columns
      .map(([name, _header, type]) => `${quote(name)} ${type}`)
      .join(',\n      ');
    db.exec(`
      CREATE TABLE ${quote(definition.table)} (
        id INTEGER PRIMARY KEY,
        source_row INTEGER NOT NULL UNIQUE,
        ${columns},
        raw_json TEXT NOT NULL
      );
    `);
    for (const names of definition.indexes) {
      const indexName = `idx_magazine_${definition.table}_${names.join('_')}`;
      db.exec(`CREATE INDEX ${quote(indexName)} ON ${quote(definition.table)}
        (${names.map(quote).join(', ')})`);
    }
  }
}

function openMagazineDb({ filename = DB_PATH, readonly = true } = {}) {
  return new Database(filename, { readonly, fileMustExist: readonly });
}

function ensureDatabaseDirectory(filename = DB_PATH) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

module.exports = { DB_PATH, SHEETS, quote, initializeSchema, openMagazineDb, ensureDatabaseDirectory };
