const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { db, DB_PATH, initializeSchema } = require('../src/db');

let workbook;

const SHEET_COLUMNS = {
  Product: 13,
  'Price Option': 18,
  'Price Unit': 11,
  Attribute: 8,
  'Attribute Value': 8,
  Option: 8,
  'Option Value': 10
};

const workbookPath = path.resolve(
  process.argv[2] || path.join(__dirname, '../src/assets/Masters/Transit/transitmaster.xlsx')
);
const imageDirectory = path.join(path.dirname(workbookPath), 'product-images');

function rows(sheetName) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Missing sheet: ${sheetName}`);
  const output = [];
  for (let sourceRow = 5; sourceRow <= sheet.actualRowCount; sourceRow += 1) {
    const excelRow = sheet.getRow(sourceRow);
    const row = [];
    for (let column = 1; column <= SHEET_COLUMNS[sheetName]; column += 1) {
      row.push(cellValue(excelRow.getCell(column).value));
    }
    if (row.some((value) => value !== null && value !== '')) output.push({ row, sourceRow });
  }
  return output;
}

function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
  if (Object.hasOwn(value, 'result')) return value.result;
  if (Object.hasOwn(value, 'text')) return value.text;
  return String(value);
}

function text(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim();
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function key(...parts) {
  return parts.map((part) => text(part) || '').join('\u001f');
}

function resolveUnique(map, lookupKey) {
  const matches = map.get(lookupKey) || [];
  return matches.length === 1 ? matches[0] : null;
}

async function main() {
  if (!require('fs').existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath}`);
  }

  workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  initializeSchema();

  const counts = {};
  const orphanCounts = {
  price_options: 0,
  price_units: 0,
  attributes: 0,
  attribute_values: 0,
  pricing_options: 0,
  pricing_option_values: 0
  };

  const importWorkbook = db.transaction(() => {
  db.exec(`
    DELETE FROM data_quality_issues;
    DELETE FROM pricing_option_values;
    DELETE FROM pricing_options;
    DELETE FROM attribute_values;
    DELETE FROM attributes;
    DELETE FROM price_units;
    DELETE FROM price_options;
    DELETE FROM products;
    DELETE FROM import_metadata;
  `);

  const productExact = new Map();
  const productBySku = new Map();
  const insertProduct = db.prepare(`
    INSERT INTO products (
      source_row, delete_flag, name, sku, short_description, meta_title,
      meta_description, meta_keywords, image, sort_order, status, media_type,
      tier, size_dimension
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  counts.products = 0;
  for (const { row: r, sourceRow } of rows('Product')) {
    if (!text(r[1]) || !text(r[2])) continue;
    const result = insertProduct.run(
      sourceRow, text(r[0]), text(r[1]), text(r[2]), text(r[3]), text(r[4]),
      text(r[5]), text(r[6]), text(r[7]), number(r[8]), number(r[9]) ?? 1,
      text(r[10]), text(r[11]), text(r[12])
    );
    const id = Number(result.lastInsertRowid);
    productExact.set(key(r[2], r[1]), id);
    const skuKey = key(r[2]);
    productBySku.set(skuKey, (productBySku.get(skuKey) || []).concat(id));
    counts.products += 1;
  }

  const priceOptionExact = new Map();
  const priceOptionBySku = new Map();
  const insertPriceOption = db.prepare(`
    INSERT INTO price_options (
      product_id, source_row, product_name, product_sku, name, sku,
      pricing_template_name, minimum_billing, offer_rate, specific_buying_rate,
      discounted_rate, pricing_unit, gst, on_request, description_html,
      media_gallery, image, sort_order, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  counts.price_options = 0;
  for (const { row: r, sourceRow } of rows('Price Option')) {
    if (!text(r[1]) || !text(r[2]) || !text(r[3]) || !text(r[4])) continue;
    const productId = productExact.get(key(r[2], r[1])) || resolveUnique(productBySku, key(r[2]));
    if (!productId) orphanCounts.price_options += 1;
    const result = insertPriceOption.run(
      productId, sourceRow, text(r[1]), text(r[2]), text(r[3]), text(r[4]),
      text(r[5]), number(r[6]), number(r[7]), number(r[8]), number(r[9]),
      text(r[10]), number(r[11]), text(r[12]), text(r[13]), text(r[14]),
      text(r[15]), number(r[16]), number(r[17]) ?? 1
    );
    const id = Number(result.lastInsertRowid);
    priceOptionExact.set(key(r[2], r[1], r[4], r[3]), id);
    const skuKey = key(r[2], r[4]);
    priceOptionBySku.set(skuKey, (priceOptionBySku.get(skuKey) || []).concat(id));
    counts.price_options += 1;
  }

  function findPriceOption(r) {
    return priceOptionExact.get(key(r[2], r[1], r[4], r[3])) ||
      resolveUnique(priceOptionBySku, key(r[2], r[4]));
  }

  const insertUnit = db.prepare(`
    INSERT INTO price_units (price_option_id, source_row, unit_name, code, step, minimum, maximum, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  counts.price_units = 0;
  for (const { row: r, sourceRow } of rows('Price Unit')) {
    if (!text(r[5])) continue;
    const priceOptionId = findPriceOption(r);
    if (!priceOptionId) orphanCounts.price_units += 1;
    insertUnit.run(priceOptionId, sourceRow, text(r[5]), text(r[6]), number(r[7]), number(r[8]), number(r[9]), number(r[10]));
    counts.price_units += 1;
  }

  const attributeExact = new Map();
  const insertAttribute = db.prepare(`
    INSERT INTO attributes (price_option_id, source_row, name, type, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  counts.attributes = 0;
  for (const { row: r, sourceRow } of rows('Attribute')) {
    if (!text(r[5])) continue;
    const priceOptionId = findPriceOption(r);
    if (!priceOptionId) orphanCounts.attributes += 1;
    const result = insertAttribute.run(priceOptionId, sourceRow, text(r[5]), text(r[6]), number(r[7]));
    if (priceOptionId) attributeExact.set(key(priceOptionId, r[5]), Number(result.lastInsertRowid));
    counts.attributes += 1;
  }

  const insertAttributeValue = db.prepare(`
    INSERT INTO attribute_values (attribute_id, price_option_id, source_row, attribute_name, value, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  counts.attribute_values = 0;
  for (const { row: r, sourceRow } of rows('Attribute Value')) {
    if (!text(r[5]) || !text(r[6])) continue;
    const priceOptionId = findPriceOption(r);
    const attributeId = priceOptionId ? attributeExact.get(key(priceOptionId, r[5])) : null;
    if (!priceOptionId || !attributeId) orphanCounts.attribute_values += 1;
    insertAttributeValue.run(attributeId, priceOptionId, sourceRow, text(r[5]), text(r[6]), number(r[7]));
    counts.attribute_values += 1;
  }

  const pricingOptionExact = new Map();
  const insertPricingOption = db.prepare(`
    INSERT INTO pricing_options (price_option_id, source_row, name, type, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  counts.pricing_options = 0;
  for (const { row: r, sourceRow } of rows('Option')) {
    if (!text(r[5])) continue;
    const priceOptionId = findPriceOption(r);
    if (!priceOptionId) orphanCounts.pricing_options += 1;
    const result = insertPricingOption.run(priceOptionId, sourceRow, text(r[5]), text(r[6]), number(r[7]));
    if (priceOptionId) pricingOptionExact.set(key(priceOptionId, r[5]), Number(result.lastInsertRowid));
    counts.pricing_options += 1;
  }

  const insertPricingOptionValue = db.prepare(`
    INSERT INTO pricing_option_values (
      pricing_option_id, price_option_id, source_row, option_name, value,
      modify_type, modify_price, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  counts.pricing_option_values = 0;
  for (const { row: r, sourceRow } of rows('Option Value')) {
    if (!text(r[5]) || !text(r[6])) continue;
    const priceOptionId = findPriceOption(r);
    const pricingOptionId = priceOptionId ? pricingOptionExact.get(key(priceOptionId, r[5])) : null;
    if (!priceOptionId || !pricingOptionId) orphanCounts.pricing_option_values += 1;
    insertPricingOptionValue.run(
      pricingOptionId, priceOptionId, sourceRow, text(r[5]), text(r[6]),
      text(r[7]), number(r[8]), number(r[9])
    );
    counts.pricing_option_values += 1;
  }

  const metadata = db.prepare('INSERT INTO import_metadata (key, value) VALUES (?, ?)');
  metadata.run('source_file', workbookPath);
  metadata.run('imported_at', new Date().toISOString());
  metadata.run('counts', JSON.stringify(counts));
  metadata.run('orphan_counts', JSON.stringify(orphanCounts));

  createQualityIssues();
  const issueCounts = db.prepare(`
    SELECT severity, COUNT(*) AS count FROM data_quality_issues GROUP BY severity
  `).all();
  metadata.run('issue_counts', JSON.stringify(issueCounts));
  });

  importWorkbook();

  console.log(`Imported transit master into ${DB_PATH}`);
  console.table(counts);
  console.log('Unresolved relationships:', orphanCounts);
  console.table(db.prepare(`
    SELECT severity, COUNT(*) AS issues, COUNT(DISTINCT product_id) AS affected_products
    FROM data_quality_issues GROUP BY severity
  `).all());
}

function createQualityIssues() {
  const insert = db.prepare(`
    INSERT INTO data_quality_issues (
      entity_type, product_id, price_option_id, source_sheet, source_row,
      severity, code, field, current_value, suggested_value, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const add = (record, issue) => insert.run(
    issue.entityType,
    record.product_id ?? record.id ?? null,
    issue.priceOptionId ?? null,
    issue.sheet,
    record.source_row,
    issue.severity,
    issue.code,
    issue.field,
    issue.currentValue === null || issue.currentValue === undefined ? null : String(issue.currentValue),
    issue.suggestedValue ?? null,
    issue.message
  );

  const duplicateProductSkus = new Set(db.prepare(`
    SELECT sku FROM products GROUP BY sku HAVING COUNT(*) > 1
  `).all().map((row) => row.sku));
  const products = db.prepare('SELECT * FROM products').all();
  for (const product of products) {
    if (duplicateProductSkus.has(product.sku)) add(product, {
      entityType: 'product', sheet: 'Product', severity: 'error', code: 'DUPLICATE_PRODUCT_SKU',
      field: 'Sku', currentValue: product.sku, suggestedValue: `${product.sku}_UNIQUE`,
      message: 'Product SKU is used by more than one product; assign a unique SKU.'
    });
    if (!product.image) add(product, {
      entityType: 'product', sheet: 'Product', severity: 'error', code: 'MISSING_PRODUCT_IMAGE',
      field: 'Image', currentValue: null, suggestedValue: '<existing image filename>',
      message: 'Required product image filename is blank.'
    });
    else if (!fs.existsSync(path.join(imageDirectory, product.image))) add(product, {
      entityType: 'product', sheet: 'Product', severity: 'error', code: 'PRODUCT_IMAGE_NOT_FOUND',
      field: 'Image', currentValue: product.image, suggestedValue: '<upload file or correct filename>',
      message: 'Product image filename does not exist in the product-images folder.'
    });
    if (product.media_type === 'Passanger Train') add(product, {
      entityType: 'product', sheet: 'Product', severity: 'warning', code: 'MEDIA_TYPE_TYPO',
      field: 'Media Type', currentValue: product.media_type, suggestedValue: 'Passenger Train',
      message: 'Media type appears to contain a spelling error.'
    });
  }

  const duplicatePriceSkus = new Set(db.prepare(`
    SELECT sku FROM price_options GROUP BY sku HAVING COUNT(*) > 1
  `).all().map((row) => row.sku));
  const priceOptions = db.prepare('SELECT * FROM price_options').all();
  for (const option of priceOptions) {
    const record = { ...option, product_id: option.product_id };
    const common = { entityType: 'price_option', sheet: 'Price Option', priceOptionId: option.id };
    if (duplicatePriceSkus.has(option.sku)) add(record, {
      ...common, severity: 'error', code: 'DUPLICATE_PRICE_OPTION_SKU', field: 'Price Option Sku',
      currentValue: option.sku, suggestedValue: `${option.sku}_UNIQUE`,
      message: 'Price-option SKU is used by more than one row; assign a unique SKU.'
    });
    if (!/^[A-Za-z0-9]+$/.test(option.sku)) add(record, {
      ...common, severity: 'error', code: 'INVALID_PRICE_OPTION_SKU', field: 'Price Option Sku',
      currentValue: option.sku, suggestedValue: option.sku.replace(/[^A-Za-z0-9]/g, ''),
      message: 'Price-option SKU contains characters forbidden by the workbook instructions.'
    });
    if (!option.image) add(record, {
      ...common, severity: 'error', code: 'MISSING_PRICE_OPTION_IMAGE', field: 'Image',
      currentValue: null, suggestedValue: '<existing image filename>',
      message: 'Required price-option image filename is blank.'
    });
    else if (!fs.existsSync(path.join(imageDirectory, option.image))) add(record, {
      ...common, severity: 'error', code: 'PRICE_OPTION_IMAGE_NOT_FOUND', field: 'Image',
      currentValue: option.image, suggestedValue: '<upload file or correct filename>',
      message: 'Price-option image filename does not exist in the product-images folder.'
    });
    if (option.offer_rate === null || option.offer_rate <= 0) add(record, {
      ...common, severity: 'error', code: 'INVALID_OFFER_RATE', field: 'Offer Rate',
      currentValue: option.offer_rate, suggestedValue: '<positive offer rate>',
      message: 'Offer rate is missing or not greater than zero.'
    });
    if (option.minimum_billing === null || option.minimum_billing <= 0) add(record, {
      ...common, severity: 'error', code: 'INVALID_MINIMUM_BILLING', field: 'Minimum Billing',
      currentValue: option.minimum_billing, suggestedValue: '<positive minimum billing>',
      message: 'Minimum billing is missing or not greater than zero.'
    });
    if (option.specific_buying_rate !== null) {
      const lowRates = [];
      if (option.offer_rate !== null && option.offer_rate < option.specific_buying_rate) lowRates.push('offer rate');
      if (option.discounted_rate !== null && option.discounted_rate < option.specific_buying_rate) lowRates.push('discounted rate');
      if (lowRates.length) add(record, {
        ...common, severity: 'error', code: 'SELLING_BELOW_BUYING', field: 'Selling / Buying Rate',
        currentValue: `Offer: ${option.offer_rate ?? 'blank'}; Discounted: ${option.discounted_rate ?? 'blank'}; Buying: ${option.specific_buying_rate}`,
        suggestedValue: `Set every client rate to at least ${option.specific_buying_rate}, plus the required margin`,
        message: `${lowRates.join(' and ')} ${lowRates.length === 1 ? 'is' : 'are'} below the buying cost, so this plan can produce a loss.`
      });
    }
    if (option.discounted_rate !== null && option.offer_rate !== null && option.discounted_rate > option.offer_rate) add(record, {
      ...common, severity: 'warning', code: 'DISCOUNT_ABOVE_OFFER', field: 'Discounted Rate',
      currentValue: `Offer: ${option.offer_rate}; Discounted: ${option.discounted_rate}`,
      suggestedValue: `Discounted rate <= ${option.offer_rate}`,
      message: 'Discounted rate is greater than the offer rate; verify the intended client price.'
    });
    if (option.specific_buying_rate === null) add(record, {
      ...common, severity: 'warning', code: 'MISSING_BUYING_RATE', field: 'Specific Buying Rate',
      currentValue: null, suggestedValue: '<buying rate or confirmed N/A>',
      message: 'Specific buying rate is blank; confirm whether that is intentional.'
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
