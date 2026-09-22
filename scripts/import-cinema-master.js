process.env.DB_READONLY = '0';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { db, DB_PATH, initializeSchema, finalize } = require('../src/cinema-db');

const workbookPath = path.resolve(process.argv[2] || path.join(__dirname, '../src/assets/Masters/Cinema/New Cinema Master Final.xlsx'));
const imageDirectory = path.join(path.dirname(workbookPath), 'Images');
const COLUMNS = { Product: 19, Location: 8, 'Price Option': 18, 'Price Unit': 11,
  'Offer Rate Source': 8, 'Qube Rate Card': 2 };

function value(cell) {
  const input = cell.value;
  if (input == null) return null;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input.richText)) return input.richText.map((part) => part.text).join('');
  if (Object.hasOwn(input, 'result')) return input.result;
  if (Object.hasOwn(input, 'text')) return input.text;
  if (input instanceof Date) return input.toISOString();
  return null;
}
const text = (input) => input == null || input === '' ? null : String(input).trim();
function number(input) {
  if (input == null || input === '') return null;
  const parsed = Number(String(input).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function forRows(sheet, start, callback) {
  if (!sheet) throw new Error('Workbook is missing a required sheet');
  const lastRow = sheet.actualRowCount;
  for (let sourceRow = start; sourceRow <= lastRow; sourceRow += 1) {
    const row = sheet.getRow(sourceRow);
    const cells = Array.from({ length: COLUMNS[sheet.name] }, (_, index) => value(row.getCell(index + 1)));
    if (cells.some((cell) => cell != null && cell !== '')) callback(cells, sourceRow);
  }
}

async function main() {
  if (!fs.existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  initializeSchema();
  const images = new Set(fs.readdirSync(imageDirectory).map((name) => name.toLowerCase()));
  const counts = {};

  db.transaction(() => {
    db.exec(`DELETE FROM data_quality_issues; DELETE FROM offer_rate_sources;
      DELETE FROM qube_rate_card;
      DELETE FROM price_units; DELETE FROM price_options; DELETE FROM locations;
      DELETE FROM products; DELETE FROM import_metadata;`);

    const productBySku = new Map();
    const optionBySku = new Map();
    const addProduct = db.prepare(`INSERT INTO products (source_row,name,sku,description,meta_title,
      meta_description,meta_keywords,image,sort_order,status,cinema_chain,screen_recommend,
      audience_class,tier,seats,screen,rank,total_screen,google_map_location)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    counts.products = 0;
    forRows(workbook.getWorksheet('Product'), 5, (r, sourceRow) => {
      if (!text(r[1]) || !text(r[2])) return;
      const result = addProduct.run(sourceRow, text(r[1]), text(r[2]), text(r[3]), text(r[4]),
        text(r[5]), text(r[6]), text(r[7]), number(r[8]), number(r[9]) ?? 1,
        text(r[10]), number(r[11]), text(r[12]), text(r[13]), number(r[14]),
        text(r[15]), number(r[16]), number(r[17]), text(r[18]));
      const sku = text(r[2]);
      productBySku.set(sku, (productBySku.get(sku) || []).concat(Number(result.lastInsertRowid)));
      counts.products += 1;
    });
    const unique = (map, sku) => (map.get(sku) || []).length === 1 ? map.get(sku)[0] : null;

    const addLocation = db.prepare(`INSERT INTO locations
      (product_id,source_row,type,zone,state,city,locality) VALUES (?,?,?,?,?,?,?)`);
    counts.locations = 0;
    forRows(workbook.getWorksheet('Location'), 5, (r, sourceRow) => {
      if (!text(r[2])) return;
      addLocation.run(unique(productBySku, text(r[2])), sourceRow, text(r[3]), text(r[4]),
        text(r[5]), text(r[6]), text(r[7]));
      counts.locations += 1;
    });

    const addOption = db.prepare(`INSERT INTO price_options (product_id,source_row,product_name,
      product_sku,name,sku,template,minimum_billing,offer_rate,buying_rate,discounted_rate,
      pricing_unit,gst,on_request,description_html,media_gallery,image,sort_order,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    counts.price_options = 0;
    forRows(workbook.getWorksheet('Price Option'), 5, (r, sourceRow) => {
      if (!text(r[2]) || !text(r[3]) || !text(r[4])) return;
      const result = addOption.run(unique(productBySku, text(r[2])), sourceRow, text(r[1]),
        text(r[2]), text(r[3]), text(r[4]), text(r[5]), number(r[6]), number(r[7]),
        number(r[8]), number(r[9]), text(r[10]), number(r[11]), text(r[12]),
        text(r[13]), text(r[14]), text(r[15]), number(r[16]), number(r[17]) ?? 1);
      const sku = text(r[4]);
      optionBySku.set(sku, (optionBySku.get(sku) || []).concat(Number(result.lastInsertRowid)));
      counts.price_options += 1;
    });

    const addUnit = db.prepare(`INSERT INTO price_units (price_option_id,source_row,name,code,
      step,minimum,maximum,sort_order) VALUES (?,?,?,?,?,?,?,?)`);
    counts.price_units = 0;
    forRows(workbook.getWorksheet('Price Unit'), 5, (r, sourceRow) => {
      if (!text(r[4]) || !text(r[5])) return;
      addUnit.run(unique(optionBySku, text(r[4])), sourceRow, text(r[5]), text(r[6]),
        number(r[7]), number(r[8]), number(r[9]), number(r[10]));
      counts.price_units += 1;
    });

    const addSource = db.prepare(`INSERT INTO offer_rate_sources (price_option_id,source_row,
      price_option_sku,product_name,screen,rate_source,basis,source_rate,divide_by,offer_rate)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    counts.rate_sources = 0;
    forRows(workbook.getWorksheet('Offer Rate Source'), 2, (r, sourceRow) => {
      if (!text(r[0])) return;
      addSource.run(unique(optionBySku, text(r[0])), sourceRow, text(r[0]), text(r[1]),
        text(r[2]), text(r[3]), text(r[4]), number(r[5]), number(r[6]), number(r[7]));
      counts.rate_sources += 1;
    });

    const addRateCard = db.prepare(`INSERT INTO qube_rate_card
      (source_row,section,name,rate) VALUES (?,?,?,?)`);
    counts.qube_rate_card = 0;
    forRows(workbook.getWorksheet('Qube Rate Card'), 1, (r, sourceRow) => {
      const rate = number(r[1]);
      const name = text(r[0]);
      if (!name || rate == null) return;
      const section = sourceRow < 37 ? 'state_default' : 'theatre_exception';
      addRateCard.run(sourceRow, section, name, rate);
      counts.qube_rate_card += 1;
    });

    audit(images);
    const metadata = db.prepare('INSERT INTO import_metadata (key,value) VALUES (?,?)');
    metadata.run('source_file', workbookPath);
    metadata.run('imported_at', new Date().toISOString());
    metadata.run('counts', JSON.stringify(counts));
  })();

  console.log(`Imported cinema master into ${DB_PATH}`);
  console.table(counts);
  console.table(db.prepare(`SELECT severity,COUNT(*) issues,COUNT(DISTINCT product_id) affected_products
    FROM data_quality_issues GROUP BY severity`).all());
  finalize();
}

function audit(images) {
  const insert = db.prepare(`INSERT INTO data_quality_issues
    (entity_type,product_id,price_option_id,source_sheet,source_row,severity,code,field,
      current_value,suggested_value,message) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const add = (type, productId, optionId, sheet, row, severity, code, field, current, suggestion, message) =>
    insert.run(type, productId, optionId, sheet, row, severity, code, field,
      current == null ? null : String(current), suggestion, message);
  const duplicateProducts = new Set(db.prepare('SELECT sku FROM products GROUP BY sku HAVING COUNT(*)>1').all().map((r) => r.sku));
  const duplicateOptions = new Set(db.prepare('SELECT sku FROM price_options GROUP BY sku HAVING COUNT(*)>1').all().map((r) => r.sku));
  const locations = db.prepare('SELECT * FROM locations WHERE product_id=?');
  for (const p of db.prepare('SELECT * FROM products').all()) {
    const loc = locations.get(p.id);
    const issue = (severity, code, field, current, suggestion, message) =>
      add('product', p.id, null, 'Product', p.source_row, severity, code, field, current, suggestion, message);
    if (duplicateProducts.has(p.sku)) issue('error', 'DUPLICATE_PRODUCT_SKU', 'Sku', p.sku, '<unique SKU>', 'Product SKU is used by multiple cinema venues.');
    if (!p.image || !images.has(p.image.toLowerCase())) issue('error', 'PRODUCT_IMAGE_NOT_FOUND', 'Image', p.image, '<existing image filename>', 'Product image is blank or does not exist in Cinema/Images.');
    if (!loc?.city) issue('error', 'MISSING_CITY', 'Location.City', loc?.city, '<city>', 'City is needed to match this cinema to a campaign location.');
    if (!p.cinema_chain) issue('warning', 'MISSING_CHAIN', 'Cinema Chain', null, '<chain>', 'Cinema chain is missing.');
    if (p.seats == null || p.seats <= 0) issue('warning', 'INVALID_SEATS', 'Seats', p.seats, '<positive seat count>', 'Seat count is missing or non-positive, reducing audience estimates.');
    if (p.total_screen == null || p.total_screen <= 0) issue('warning', 'INVALID_SCREEN_COUNT', 'Total Screen', p.total_screen, '<positive screen count>', 'Total screen count is missing or non-positive.');
    if (p.screen_recommend != null && p.total_screen != null && p.screen_recommend > p.total_screen)
      issue('warning', 'RECOMMENDED_SCREENS_EXCEED_TOTAL', 'Screen Recomend', p.screen_recommend, `<= ${p.total_screen}`, 'Recommended screens exceed the venue total.');
  }

  const unitCount = db.prepare('SELECT COUNT(*) count FROM price_units WHERE price_option_id=?');
  const sourceFor = db.prepare('SELECT * FROM offer_rate_sources WHERE price_option_id=?');
  for (const o of db.prepare('SELECT * FROM price_options').all()) {
    const issue = (severity, code, field, current, suggestion, message) =>
      add('price_option', o.product_id, o.id, 'Price Option', o.source_row, severity, code, field, current, suggestion, message);
    if (!o.product_id) issue('error', 'UNLINKED_PRICE_OPTION', 'Product Sku', o.product_sku, '<valid product SKU>', 'Price format could not be linked to a cinema product.');
    if (duplicateOptions.has(o.sku)) issue('error', 'DUPLICATE_PRICE_OPTION_SKU', 'Price Option Sku', o.sku, '<unique SKU>', 'Price format SKU is used more than once.');
    if (o.offer_rate == null || o.offer_rate <= 0) issue('error', 'INVALID_OFFER_RATE', 'Offer Rate', o.offer_rate, '<positive client rate>', 'Client offer rate is missing or non-positive.');
    if (o.buying_rate == null) issue('warning', 'MISSING_BUYING_RATE', 'Specific Buying Rate', null, '<buying cost>', 'Buying cost is missing, so plan margin cannot be verified.');
    if (o.buying_rate != null && ((o.offer_rate != null && o.offer_rate < o.buying_rate) ||
      (o.discounted_rate != null && o.discounted_rate < o.buying_rate)))
      issue('error', 'SELLING_BELOW_BUYING', 'Selling / Buying Rate',
        `Offer: ${o.offer_rate ?? 'blank'}; Discounted: ${o.discounted_rate ?? 'blank'}; Buying: ${o.buying_rate}`,
        `Client rate >= ${o.buying_rate}, plus margin`, 'At least one client-facing rate is below buying cost.');
    if (o.discounted_rate != null && o.offer_rate != null && o.discounted_rate > o.offer_rate)
      issue('warning', 'DISCOUNT_ABOVE_OFFER', 'Discounted Rate', o.discounted_rate, `<= ${o.offer_rate}`, 'Discounted rate exceeds the offer rate.');
    if (o.minimum_billing == null || o.minimum_billing <= 0) issue('warning', 'INVALID_MINIMUM_BILLING', 'Minimum Billing', o.minimum_billing, '<positive amount>', 'Minimum billing is missing or non-positive.');
    if (unitCount.get(o.id).count === 0) issue('error', 'MISSING_PRICE_UNITS', 'Price Unit', null, '<campaign quantity rules>', 'No quantity rules exist for this ad format.');
    if (o.image && !images.has(o.image.toLowerCase())) issue('warning', 'PRICE_IMAGE_NOT_FOUND', 'Image', o.image, '<existing image filename>', 'Price format image file is missing.');
    const source = sourceFor.get(o.id);
    if (source && source.offer_rate != null && o.offer_rate != null && Math.abs(source.offer_rate - o.offer_rate) > 0.01)
      issue('warning', 'RATE_SOURCE_MISMATCH', 'Offer Rate', o.offer_rate, `Rate source: ${source.offer_rate}`, 'Price Option offer rate differs from the Offer Rate Source sheet.');
  }
  for (const u of db.prepare('SELECT price_units.*,price_options.product_id FROM price_units LEFT JOIN price_options ON price_options.id=price_units.price_option_id').all()) {
    if (!u.price_option_id) add('price_unit', null, null, 'Price Unit', u.source_row, 'error', 'UNLINKED_PRICE_UNIT', 'Price Option Sku', null, '<valid price-option SKU>', 'Quantity unit could not be linked to a price format.');
    if (u.maximum != null && u.maximum < u.minimum) add('price_unit', u.product_id, u.price_option_id, 'Price Unit', u.source_row, 'error', 'INVALID_UNIT_RANGE', 'Maximum', u.maximum, `>= ${u.minimum}`, 'Maximum quantity is below minimum.');
  }
  for (const s of db.prepare('SELECT * FROM offer_rate_sources WHERE price_option_id IS NULL').all())
    add('rate_source', null, null, 'Offer Rate Source', s.source_row, 'warning', 'UNLINKED_RATE_SOURCE', 'Price Option Sku', s.price_option_sku, '<valid price-option SKU>', 'Rate source could not be linked to a price format.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
