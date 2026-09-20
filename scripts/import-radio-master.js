// This script builds the catalog, so it needs write access even on a host that
// otherwise defaults to read-only. Must be set before the db module is required.
process.env.DB_READONLY = '0';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { db, DB_PATH, initializeSchema, finalize } = require('../src/radio-db');

const workbookPath = path.resolve(process.argv[2] || path.join(__dirname, '../src/assets/Masters/Radio/radiomaster.xlsx'));
const imageRoot = path.join(path.dirname(workbookPath), 'product-images');
const SHEET_COLUMNS = {
  Product: 19, 'Price Option': 18, 'Price Unit': 11, Attribute: 8,
  'Attribute Value': 8, Variant: 15, Location: 8, 'Pending Fixes': 6
};
let workbook;

function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
  if (Object.hasOwn(value, 'result')) return value.result;
  if (Object.hasOwn(value, 'text')) return value.text;
  return String(value);
}

function rows(sheetName, firstDataRow = 5) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Missing sheet: ${sheetName}`);
  const output = [];
  for (let sourceRow = firstDataRow; sourceRow <= sheet.actualRowCount; sourceRow += 1) {
    const row = [];
    for (let column = 1; column <= SHEET_COLUMNS[sheetName]; column += 1) {
      row.push(cellValue(sheet.getRow(sourceRow).getCell(column).value));
    }
    if (row.some((value) => value !== null && value !== '')) output.push({ row, sourceRow });
  }
  return output;
}

const text = (value) => value === null || value === undefined || value === '' ? null : String(value).trim();
function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
const key = (...parts) => parts.map((part) => (text(part) || '').toLowerCase()).join('\u001f');
const unique = (map, lookup) => (map.get(lookup) || []).length === 1 ? map.get(lookup)[0] : null;

function imageNames(directory, output = new Set()) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) imageNames(target, output);
    else output.add(entry.name.toLowerCase());
  }
  return output;
}

async function main() {
  if (!fs.existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath}`);
  workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  initializeSchema();
  const counts = {};
  const availableImages = imageNames(imageRoot);

  db.transaction(() => {
    db.exec(`
      DELETE FROM data_quality_issues; DELETE FROM variants; DELETE FROM attribute_values;
      DELETE FROM attributes; DELETE FROM price_units; DELETE FROM price_options;
      DELETE FROM locations; DELETE FROM products; DELETE FROM import_metadata;
    `);

    const productExact = new Map();
    const productBySku = new Map();
    const productByStation = new Map();
    const insertProduct = db.prepare(`
      INSERT INTO products (source_row,name,sku,short_description,meta_title,meta_description,
        meta_keywords,image,sort_order,status,tier,station,language,audience,frequency,rank,
        listenership,show_timing,coverage_area)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    counts.products = 0;
    for (const { row: r, sourceRow } of rows('Product')) {
      if (!text(r[1]) || !text(r[2])) continue;
      const result = insertProduct.run(sourceRow, text(r[1]), text(r[2]), text(r[3]), text(r[4]),
        text(r[5]), text(r[6]), text(r[7]), number(r[8]), number(r[9]) ?? 1, text(r[10]),
        text(r[11]), text(r[12]), text(r[13]), number(r[14]), number(r[15]), text(r[16]),
        text(r[17]), text(r[18]));
      const id = Number(result.lastInsertRowid);
      productExact.set(key(r[2], r[1]), id);
      productBySku.set(key(r[2]), (productBySku.get(key(r[2])) || []).concat(id));
      if (text(r[11])) productByStation.set(key(r[11]), (productByStation.get(key(r[11])) || []).concat(id));
      counts.products += 1;
    }
    const findProduct = (sku, name) => productExact.get(key(sku, name)) || unique(productBySku, key(sku));

    const insertLocation = db.prepare(`INSERT INTO locations
      (product_id,source_row,type,country,state,city,locality) VALUES (?,?,?,?,?,?,?)`);
    counts.locations = 0;
    for (const { row: r, sourceRow } of rows('Location')) {
      if (!text(r[1]) && !text(r[2])) continue;
      insertLocation.run(findProduct(r[2], r[1]), sourceRow, text(r[3]), text(r[4]), text(r[5]), text(r[6]), text(r[7]));
      counts.locations += 1;
    }

    const priceExact = new Map();
    const priceBySku = new Map();
    const insertPrice = db.prepare(`
      INSERT INTO price_options (product_id,source_row,product_name,product_sku,name,sku,
        pricing_template_name,minimum_billing,specific_buying_rate,offer_rate,discounted_rate,
        pricing_unit,gst,on_request,description_html,media_gallery,image,sort_order,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    counts.price_options = 0;
    for (const { row: r, sourceRow } of rows('Price Option')) {
      if (!text(r[1]) || !text(r[2]) || !text(r[3]) || !text(r[4])) continue;
      const productId = findProduct(r[2], r[1]);
      const result = insertPrice.run(productId, sourceRow, text(r[1]), text(r[2]), text(r[3]), text(r[4]),
        text(r[5]), number(r[6]), number(r[7]), number(r[8]), number(r[9]), text(r[10]),
        number(r[11]), text(r[12]), text(r[13]), text(r[14]), text(r[15]), number(r[16]), number(r[17]) ?? 1);
      const id = Number(result.lastInsertRowid);
      priceExact.set(key(r[2], r[1], r[4], r[3]), id);
      priceBySku.set(key(r[2], r[4]), (priceBySku.get(key(r[2], r[4])) || []).concat(id));
      counts.price_options += 1;
    }
    const findPrice = (r) => priceExact.get(key(r[2], r[1], r[4], r[3])) || unique(priceBySku, key(r[2], r[4]));

    const insertUnit = db.prepare(`INSERT INTO price_units
      (price_option_id,source_row,unit_name,code,step,minimum,maximum,sort_order) VALUES (?,?,?,?,?,?,?,?)`);
    counts.price_units = 0;
    for (const { row: r, sourceRow } of rows('Price Unit')) {
      if (!text(r[5])) continue;
      insertUnit.run(findPrice(r), sourceRow, text(r[5]), text(r[6]), number(r[7]), number(r[8]), number(r[9]), number(r[10]));
      counts.price_units += 1;
    }

    const attributeMap = new Map();
    const insertAttribute = db.prepare(`INSERT INTO attributes
      (price_option_id,source_row,name,type,sort_order) VALUES (?,?,?,?,?)`);
    counts.attributes = 0;
    for (const { row: r, sourceRow } of rows('Attribute')) {
      if (!text(r[5])) continue;
      const priceId = findPrice(r);
      const result = insertAttribute.run(priceId, sourceRow, text(r[5]), text(r[6]), number(r[7]));
      if (priceId) attributeMap.set(key(priceId, r[5]), Number(result.lastInsertRowid));
      counts.attributes += 1;
    }

    const insertValue = db.prepare(`INSERT INTO attribute_values
      (attribute_id,price_option_id,source_row,attribute_name,value,sort_order) VALUES (?,?,?,?,?,?)`);
    counts.attribute_values = 0;
    for (const { row: r, sourceRow } of rows('Attribute Value')) {
      if (!text(r[5]) || !text(r[6])) continue;
      const priceId = findPrice(r);
      insertValue.run(priceId ? attributeMap.get(key(priceId, r[5])) : null, priceId, sourceRow,
        text(r[5]), text(r[6]), number(r[7]));
      counts.attribute_values += 1;
    }

    const insertVariant = db.prepare(`INSERT INTO variants
      (price_option_id,product_id,source_row,name,enabled,specific_buying_rate,price,discounted_price,attributes_json)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    counts.variants = 0;
    for (const { row: r, sourceRow } of rows('Variant')) {
      if (!text(r[4])) continue;
      const priceId = priceExact.get(key(r[1], r[0], r[3], r[2])) || unique(priceBySku, key(r[1], r[3]));
      const price = priceId ? db.prepare('SELECT product_id FROM price_options WHERE id = ?').get(priceId) : null;
      const attributes = r.slice(9, 15).map(text).filter(Boolean);
      insertVariant.run(priceId, price?.product_id || null, sourceRow, text(r[4]), number(r[5]) ?? 1,
        number(r[6]), number(r[7]), number(r[8]), JSON.stringify(attributes));
      counts.variants += 1;
    }

    createQualityIssues(availableImages, productByStation);
    const metadata = db.prepare('INSERT INTO import_metadata (key,value) VALUES (?,?)');
    metadata.run('source_file', workbookPath);
    metadata.run('imported_at', new Date().toISOString());
    metadata.run('counts', JSON.stringify(counts));
  })();

  console.log(`Imported radio master into ${DB_PATH}`);
  console.table(counts);
  console.table(db.prepare(`SELECT severity,COUNT(*) issues,COUNT(DISTINCT product_id) affected_products
    FROM data_quality_issues GROUP BY severity`).all());
}

function createQualityIssues(availableImages, productByStation) {
  const insert = db.prepare(`INSERT INTO data_quality_issues
    (entity_type,product_id,price_option_id,variant_id,source_sheet,source_row,severity,
      code,field,current_value,suggested_value,message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const add = (entity, issue) => insert.run(issue.entityType, entity.product_id ?? entity.id ?? null,
    issue.priceOptionId ?? null, issue.variantId ?? null, issue.sheet, entity.source_row,
    issue.severity, issue.code, issue.field, issue.currentValue === null || issue.currentValue === undefined ? null : String(issue.currentValue),
    issue.suggestedValue ?? null, issue.message);

  const duplicateSkus = new Set(db.prepare('SELECT sku FROM products GROUP BY sku HAVING COUNT(*)>1').all().map((row) => row.sku));
  for (const product of db.prepare('SELECT * FROM products').all()) {
    const common = { entityType: 'product', sheet: 'Product' };
    if (duplicateSkus.has(product.sku)) add(product, { ...common, severity: 'error', code: 'DUPLICATE_PRODUCT_SKU', field: 'Sku', currentValue: product.sku, suggestedValue: `${product.sku}_UNIQUE`, message: 'Product SKU is duplicated.' });
    if (!product.image) add(product, { ...common, severity: 'error', code: 'MISSING_PRODUCT_IMAGE', field: 'Image', currentValue: null, suggestedValue: '<existing image filename>', message: 'Required product image is blank.' });
    else if (!availableImages.has(product.image.toLowerCase())) add(product, { ...common, severity: 'error', code: 'PRODUCT_IMAGE_NOT_FOUND', field: 'Image', currentValue: product.image, suggestedValue: '<upload file or correct filename>', message: 'Product image file was not found.' });
    for (const [field, value, code, label] of [
      ['Short Description', product.short_description, 'MISSING_DESCRIPTION', 'product description'],
      ['Station', product.station, 'MISSING_STATION', 'station'], ['Language', product.language, 'MISSING_LANGUAGE', 'language'],
      ['Frequency', product.frequency, 'MISSING_FREQUENCY', 'FM frequency']
    ]) if (value === null) add(product, { ...common, severity: 'warning', code, field, currentValue: null, suggestedValue: `<${label}>`, message: `Missing ${label} can weaken plan recommendations.` });
    const location = db.prepare('SELECT * FROM locations WHERE product_id=? ORDER BY id LIMIT 1').get(product.id);
    if (!location?.city) add(product, { ...common, severity: 'error', code: 'MISSING_CITY', field: 'Location.City', currentValue: null, suggestedValue: '<city>', message: 'City is required to match this station to a campaign location.' });
  }

  for (const option of db.prepare('SELECT * FROM price_options').all()) {
    const entity = { ...option, product_id: option.product_id };
    const common = { entityType: 'price_option', sheet: 'Price Option', priceOptionId: option.id };
    if (option.offer_rate === null || option.offer_rate <= 0) add(entity, { ...common, severity: 'error', code: 'INVALID_OFFER_RATE', field: 'Offer Rate', currentValue: option.offer_rate, suggestedValue: '<positive offer rate>', message: 'Offer rate is missing or non-positive.' });
    if (option.specific_buying_rate === null) add(entity, { ...common, severity: 'warning', code: 'MISSING_BUYING_RATE', field: 'Specific Buying rate', currentValue: null, suggestedValue: '<buying cost>', message: 'Buying cost is missing, so plan margin cannot be verified.' });
    if (option.specific_buying_rate !== null && ((option.offer_rate !== null && option.offer_rate < option.specific_buying_rate) || (option.discounted_rate !== null && option.discounted_rate < option.specific_buying_rate))) add(entity, {
      ...common, severity: 'error', code: 'SELLING_BELOW_BUYING', field: 'Selling / Buying Rate',
      currentValue: `Offer: ${option.offer_rate ?? 'blank'}; Discounted: ${option.discounted_rate ?? 'blank'}; Buying: ${option.specific_buying_rate}`,
      suggestedValue: `Client rate >= ${option.specific_buying_rate}, plus margin`, message: 'A client-facing price is below buying cost and can create a loss.'
    });
  }

  for (const variant of db.prepare('SELECT * FROM variants').all()) {
    if (variant.specific_buying_rate !== null && ((variant.price !== null && variant.price < variant.specific_buying_rate) || (variant.discounted_price !== null && variant.discounted_price < variant.specific_buying_rate))) add(variant, {
      entityType: 'variant', sheet: 'Variant', priceOptionId: variant.price_option_id, variantId: variant.id,
      severity: 'error', code: 'VARIANT_SELLING_BELOW_BUYING', field: 'Variant Price / Buying Rate',
      currentValue: `Price: ${variant.price ?? 'blank'}; Discounted: ${variant.discounted_price ?? 'blank'}; Buying: ${variant.specific_buying_rate}`,
      suggestedValue: `Variant client price >= ${variant.specific_buying_rate}, plus margin`, message: 'Variant selling price is below its buying cost.'
    });
  }

  for (const { row: r, sourceRow } of rows('Pending Fixes', 2)) {
    const category = text(r[0]);
    if (!category) continue;
    const matches = productByStation.get(key(r[1])) || [];
    let productId = matches.length === 1 ? matches[0] : null;
    if (matches.length > 1 && text(r[2])) {
      productId = matches.find((id) => db.prepare('SELECT 1 FROM locations WHERE product_id=? AND city=? COLLATE NOCASE').get(id, text(r[2]))) || null;
    }
    insert.run('pending_fix', productId, null, null, 'Pending Fixes', sourceRow, 'warning',
      `PENDING_${category.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, category, text(r[4]), text(r[5]) || '<fill missing value>',
      `${text(r[1]) || 'Station'}${text(r[2]) ? `, ${text(r[2])}` : ''}${text(r[3]) ? ` — ${text(r[3])}` : ''}: ${text(r[4]) || category}`);
  }
}

main()
  .then(finalize)
  .catch((error) => { console.error(error); process.exitCode = 1; });
