const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { db, DB_PATH, finalize } = require('../src/other-masters-db');

const ROOT = path.join(__dirname, '../src/assets/Masters');
const CATALOGS = [
  ['btl', 'BTL & Non-Traditional', 'btl/NonTraditional Master-01-09-2026.xlsx'],
  ['cinema', 'Cinema', 'Cinema/New Cinema Master Final.xlsx'],
  ['digital', 'Digital', 'digital/digital-master-10-04-2026.xlsx'],
  ['digital_pr', 'Digital PR', 'digital_pr/digitalpr-master-15-02-2026.xlsx'],
  ['magazine', 'Magazine', 'print/Magazine/magazine-master-01-06-2026.xlsx'],
  ['newspaper', 'Newspaper', 'print/newspaper/newspaper-master-13-02-2026.xlsx'],
  ['radio', 'Radio', 'Radio/radiomaster.xlsx'],
  ['transit', 'Transit', 'Transit/transitmaster.xlsx'],
  ['tv', 'Television', 'tv/television-master-14-02-2026 (2).xlsx']
];
const IMAGE_DIRS = {
  btl: ['btl/product', 'btl/pricing-images'],
  cinema: ['Cinema/Images', 'Cinema/pricing-images'],
  digital: ['digital/digital-product-06-01-2025', 'digital/digital-pricing-06-01-2025'],
  digital_pr: ['digital_pr/product', 'digital_pr/pricing'],
  magazine: ['print/Magazine/product', 'print/Magazine/pricing'],
  newspaper: ['print/newspaper/product'],
  radio: ['Radio/product-images', 'Radio/pricing-images'],
  transit: ['Transit/product-images', 'Transit/price-option-images'],
  tv: ['tv/product', 'tv/pricing']
};
const LEGACY_DB_PATHS = {
  cinema: require('../src/cinema-db').DB_PATH,
  radio: require('../src/radio-db').DB_PATH,
  transit: require('../src/db').DB_PATH
};

function value(cell) {
  const raw = cell.value;
  if (raw == null) return null;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'object') {
    if (raw.result != null) return String(raw.result).trim() || null;
    if (raw.richText) return raw.richText.map((part) => part.text).join('').trim() || null;
    if (raw.text != null) return String(raw.text).trim() || null;
    if (raw.hyperlink) return String(raw.hyperlink).trim() || null;
  }
  return String(raw).trim() || null;
}

function number(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).replace(/,/g, '').trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function rows(sheet) {
  if (!sheet) return [];
  const headers = sheet.getRow(2).values.slice(1).map((item) => String(item || '').trim());
  const results = [];
  const end = sheet.rowCount;
  for (let rowNumber = 5; rowNumber <= end; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const fields = {};
    let populated = false;
    for (let column = 1; column <= headers.length; column++) {
      if (!headers[column - 1]) continue;
      const item = value(row.getCell(column));
      if (item !== null) populated = true;
      fields[headers[column - 1]] = item;
    }
    if (!populated) continue;
    // BTL has some legacy 16-column price rows under the newer 18-column heading.
    // In those rows, buying and discounted rates are absent, not the text in column 9.
    if (sheet.name === 'Price Option' && headers.length === 18
      && fields['Specific Buying Rate'] && !number(fields['Specific Buying Rate'])) {
      for (let column = headers.length; column >= 11; column--) {
        fields[headers[column - 1]] = fields[headers[column - 3]];
      }
      fields['Specific Buying Rate'] = null;
      fields['Discounted Rate'] = null;
    }
    results.push({ source_row: rowNumber, fields });
  }
  return results;
}

function imageIndex(slug) {
  const index = new Map();
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(png|jpe?g|webp|avif|gif|svg)$/i.test(entry.name)) {
        const relative = path.relative(ROOT, file).split(path.sep).map(encodeURIComponent).join('/');
        const key = entry.name.toLowerCase();
        if (!index.has(key)) index.set(key, `/master-images/${relative}`);
      }
    }
  }
  for (const dir of IMAGE_DIRS[slug]) visit(path.join(ROOT, dir));
  return index;
}

const insertCatalog = db.prepare(`INSERT INTO catalogs(slug,label,workbook,imported_at,sheet_counts_json)
  VALUES(?,?,?,?,?)`);
const insertProduct = db.prepare(`INSERT INTO products(catalog_slug,source_row,sku,name,description,image,image_url,status,sort_order,fields_json)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);
const insertRow = db.prepare(`INSERT INTO related_rows(catalog_slug,product_id,option_id,sheet,source_row,product_sku,option_sku,name,
  price,buying_rate,discounted_rate,minimum_billing,pricing_unit,image_url,fields_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insertIssue = db.prepare(`INSERT INTO data_quality_issues(catalog_slug,product_id,related_row_id,sheet,source_row,severity,code,field,
  current_value,suggested_value,message) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);

function issue(slug, productId, rowId, sheet, sourceRow, severity, code, field, current, suggestion, message) {
  insertIssue.run(slug, productId, rowId, sheet, sourceRow, severity, code, field,
    current == null ? null : String(current), suggestion, message);
}

async function importCatalog([slug, label, workbookPath]) {
  const file = path.join(ROOT, workbookPath);
  if (!fs.existsSync(file)) throw new Error(`Missing workbook: ${file}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheetRows = Object.fromEntries(workbook.worksheets.map((sheet) => [sheet.name, rows(sheet)]));
  if (slug === 'cinema') {
    const sources = workbook.getWorksheet('Offer Rate Source');
    sheetRows['Offer Rate Source'] = [];
    for (let rowNumber = 2; rowNumber <= sources.rowCount; rowNumber++) {
      const row = sources.getRow(rowNumber);
      const optionSku = value(row.getCell(1));
      if (!optionSku) continue;
      sheetRows['Offer Rate Source'].push({ source_row: rowNumber, fields: {
        'Price Option Sku': optionSku, 'Product Name': value(row.getCell(2)),
        Screen: value(row.getCell(3)), 'Rate Source': value(row.getCell(4)),
        Basis: value(row.getCell(5)), 'Source Rate': value(row.getCell(6)),
        'Divide By': value(row.getCell(7)), 'Offer Rate': value(row.getCell(8))
      } });
    }
    const rateCard = workbook.getWorksheet('Qube Rate Card');
    sheetRows['Qube Rate Card'] = [];
    for (let rowNumber = 1; rowNumber <= rateCard.rowCount; rowNumber++) {
      const row = rateCard.getRow(rowNumber);
      const name = value(row.getCell(1));
      const rate = value(row.getCell(2));
      if (!name || number(rate) == null) continue;
      sheetRows['Qube Rate Card'].push({ source_row: rowNumber, fields: {
        Section: rowNumber < 37 ? 'State Default' : 'Theatre Exception', Name: name, Rate: rate
      } });
    }
  }
  if (slug === 'radio') {
    const pending = workbook.getWorksheet('Pending Fixes');
    sheetRows['Pending Fixes'] = [];
    for (let rowNumber = 2; rowNumber <= pending.rowCount; rowNumber++) {
      const row = pending.getRow(rowNumber);
      const category = value(row.getCell(1));
      if (!category) continue;
      sheetRows['Pending Fixes'].push({ source_row: rowNumber, fields: {
        Category: category, Station: value(row.getCell(2)), City: value(row.getCell(3)),
        Option: value(row.getCell(4)), Note: value(row.getCell(5)),
        'Suggested Value': value(row.getCell(6))
      } });
    }
  }
  const counts = Object.fromEntries(Object.entries(sheetRows).map(([name, data]) => [name, data.length]));
  const images = imageIndex(slug);
  console.log(`Importing ${label}: ${JSON.stringify(counts)}`);

  db.transaction(() => {
    db.prepare('DELETE FROM catalogs WHERE slug=?').run(slug);
    insertCatalog.run(slug, label, workbookPath.replaceAll('\\', '/'), new Date().toISOString(), JSON.stringify(counts));
    const products = new Map();
    const options = new Map();
    const optionBySku = new Map();
    const productRows = sheetRows.Product || [];
    for (const item of productRows) {
      const f = item.fields;
      const sku = f.Sku || null;
      const image = f.Image || null;
      const imageUrl = image ? images.get(path.basename(image).toLowerCase()) || null : null;
      const id = insertProduct.run(slug, item.source_row, sku, f['Product Name'], f['Short Description'],
        image, imageUrl, number(f.Status), number(f['Sort Order']), JSON.stringify(f)).lastInsertRowid;
      if (sku) {
        if (products.has(sku)) issue(slug, Number(id), null, 'Product', item.source_row, 'error',
          'DUPLICATE_SKU', 'Sku', sku, 'Use a unique product SKU', 'Duplicate SKU prevents reliable plan selection.');
        else products.set(sku, Number(id));
      } else issue(slug, Number(id), null, 'Product', item.source_row, 'error',
        'MISSING_SKU', 'Sku', null, 'Add a unique SKU', 'Product cannot be matched to its options.');
      if (!f['Product Name']) issue(slug, Number(id), null, 'Product', item.source_row, 'error',
        'MISSING_TITLE', 'Product Name', null, 'Add a client-facing title', 'Product has no title.');
      if (!f['Short Description']) issue(slug, Number(id), null, 'Product', item.source_row, 'warning',
        'MISSING_DESCRIPTION', 'Short Description', null, 'Add a concise sales description', 'Client-facing product description is missing.');
      if (!imageUrl) issue(slug, Number(id), null, 'Product', item.source_row, 'warning',
        image ? 'PRODUCT_IMAGE_NOT_FOUND' : 'MISSING_PRODUCT_IMAGE', 'Image', image,
        'Add an existing product image file', 'Product image is missing or does not match an image file.');
    }

    for (const [sheetName, items] of Object.entries(sheetRows)) {
      if (sheetName === 'Product') continue;
      for (const item of items) {
        const f = item.fields;
        const globalSheet = ['Qube Rate Card', 'Offer Rate Source', 'Pending Fixes'].includes(sheetName);
        const sku = f['Product Sku'] || null;
        let productId = sku ? products.get(sku) || null : null;
        const optionSku = f['Price Option Sku'] || null;
        const optionKey = sku && optionSku ? `${sku}\u0000${optionSku}` : null;
        const optionId = sheetName === 'Price Option' ? null
          : options.get(optionKey) || (sheetName === 'Offer Rate Source' ? optionBySku.get(optionSku)?.id : null) || null;
        if (sheetName === 'Offer Rate Source') productId = optionBySku.get(optionSku)?.productId || null;
        const image = f.Image || null;
        const imageUrl = image ? images.get(path.basename(image).toLowerCase()) || null : null;
        const name = f['Price Option Name'] || f['Unit Name'] || f['Attribute Name']
          || f['Attribute Value'] || f['Variant Name'] || f['Rate Source'] || f.Name
          || f.Category || f.City || f.Type || null;
        const id = Number(insertRow.run(slug, productId, optionId, sheetName, item.source_row, sku, optionSku,
          name, number(sheetName === 'Variant' ? f.Price : f['Offer Rate']), number(f['Specific Buying Rate']),
          number(f['Discounted Rate']), number(f['Minimum Billing']), f['Pricing Unit'] || null,
          imageUrl, JSON.stringify(f)).lastInsertRowid);
        if (sheetName === 'Price Option' && optionKey) {
          if (options.has(optionKey)) issue(slug, productId, id, sheetName, item.source_row, 'error',
            'DUPLICATE_OPTION_SKU', 'Price Option Sku', optionSku, 'Use a unique option SKU per product',
            'Duplicate price option SKU makes units and attributes ambiguous.');
          else options.set(optionKey, id);
          if (!optionBySku.has(optionSku)) optionBySku.set(optionSku, { id, productId });
        }
        if (!productId && !globalSheet) issue(slug, null, id, sheetName, item.source_row, 'error',
          'UNLINKED_PRODUCT', 'Product Sku', sku, 'Match an existing Product sheet SKU',
          'Related row cannot be attached to a product.');
        if (sheetName !== 'Price Option' && sheetName !== 'Location' && !globalSheet && !optionId) issue(slug, productId, id,
          sheetName, item.source_row, 'error', 'UNLINKED_OPTION', 'Price Option Sku', optionSku,
          'Match an existing Price Option sheet SKU', 'Related row cannot be attached to a price option.');
        if (sheetName === 'Price Option') {
          const offer = number(f['Offer Rate']);
          const buying = number(f['Specific Buying Rate']);
          const discounted = number(f['Discounted Rate']);
          const minBilling = number(f['Minimum Billing']);
          if (offer == null && String(f['On Request'] || '').toUpperCase() !== 'Y') issue(slug, productId, id,
            sheetName, item.source_row, 'error', 'MISSING_OFFER_RATE', 'Offer Rate', f['Offer Rate'],
            'Enter a numeric offer rate or mark On Request', 'No client price is available for plan calculations.');
          if (offer != null && offer < 0) issue(slug, productId, id, sheetName, item.source_row, 'error',
            'NEGATIVE_OFFER_RATE', 'Offer Rate', offer, 'Use a non-negative rate', 'Offer rate is negative.');
          if (buying != null && offer != null && offer < buying) issue(slug, productId, id, sheetName,
            item.source_row, 'error', 'SELLING_BELOW_BUYING', 'Offer Rate', offer,
            `Set offer rate to at least ${buying}`, 'Client offer is below buying cost.');
          if (buying != null && discounted != null && discounted < buying) issue(slug, productId, id,
            sheetName, item.source_row, 'error', 'SELLING_BELOW_BUYING', 'Discounted Rate', discounted,
            `Set discounted rate to at least ${buying}`, 'Discounted client price is below buying cost.');
          if (offer != null && discounted != null && discounted > offer) issue(slug, productId, id,
            sheetName, item.source_row, 'warning', 'DISCOUNT_ABOVE_OFFER', 'Discounted Rate', discounted,
            `Set at or below ${offer}`, 'Discounted rate exceeds the offer rate.');
          if (minBilling == null || minBilling <= 0) issue(slug, productId, id, sheetName, item.source_row,
            'warning', 'INVALID_MINIMUM_BILLING', 'Minimum Billing', f['Minimum Billing'],
            'Enter a positive minimum billing', 'Plan minimum spend is missing or invalid.');
          if (!f['Pricing Unit']) issue(slug, productId, id, sheetName, item.source_row, 'warning',
            'MISSING_PRICING_UNIT', 'Pricing Unit', null, 'Specify a per-unit basis',
            'A plan cannot explain how this price is charged.');
          if (image && !imageUrl) issue(slug, productId, id, sheetName, item.source_row, 'warning',
            'PRICE_IMAGE_NOT_FOUND', 'Image', image, 'Add the matching price image file',
            'Price option image does not match an available file.');
        }
        if (sheetName === 'Price Unit') {
          const step = number(f.Step);
          const min = number(f.Minimum);
          const max = number(f.Maximum);
          if (step == null || step <= 0 || min == null || min < 0 || (max != null && max !== 0 && max < min)) {
            issue(slug, productId, id, sheetName, item.source_row, 'error', 'INVALID_PRICE_UNIT',
              'Step / Minimum / Maximum', `${f.Step ?? ''} / ${f.Minimum ?? ''} / ${f.Maximum ?? ''}`,
              'Use positive step and valid bounds', 'Unit quantity cannot be safely calculated.');
          }
        }
        if (sheetName === 'Variant' && String(f['Is Enable']) === '1' && number(f.Price) == null) {
          issue(slug, productId, id, sheetName, item.source_row, 'error', 'VARIANT_PRICE_MISSING',
            'Price', f.Price, 'Enter a price or disable the variant', 'Enabled variant has no client price.');
        }
      }
    }

    const noOptions = db.prepare(`SELECT p.id,p.source_row FROM products p LEFT JOIN related_rows r
      ON r.product_id=p.id AND r.sheet='Price Option' WHERE p.catalog_slug=? GROUP BY p.id HAVING COUNT(r.id)=0`).all(slug);
    for (const p of noOptions) issue(slug, p.id, null, 'Product', p.source_row,
      slug === 'newspaper' ? 'error' : 'warning',
      'PRICE_OPTION_MISSING', 'Price Option', null, 'Add a price option or mark as quotation-only',
      'No price option is available for automated plan costing.');
    if (sheetRows.Location) {
      const noLocations = db.prepare(`SELECT p.id,p.source_row FROM products p LEFT JOIN related_rows r
        ON r.product_id=p.id AND r.sheet='Location' WHERE p.catalog_slug=? GROUP BY p.id HAVING COUNT(r.id)=0`).all(slug);
      for (const p of noLocations) issue(slug, p.id, null, 'Product', p.source_row, 'warning',
        'LOCATION_MISSING', 'Location', null, 'Add a location row',
        'Product cannot be matched confidently to a geographic plan.');
    }
    for (const product of db.prepare('SELECT id,source_row,fields_json FROM products WHERE catalog_slug=?').all(slug)) {
      const f = JSON.parse(product.fields_json);
      const warn = (code, field, suggestion, message) => issue(slug, product.id, null,
        'Product', product.source_row, 'warning', code, field, f[field], suggestion, message);
      if (slug === 'btl') {
        if (!f['Target Audience']) warn('MISSING_TARGET_AUDIENCE', 'Target Audience',
          'Describe the audience this placement reaches', 'Audience targeting is missing for plan selection.');
        if (!f.Class) warn('MISSING_AUDIENCE_CLASS', 'Class',
          'Add the audience class if known', 'Audience class is missing for comparison with other placements.');
      }
      if (slug === 'digital') {
        if (!f['Category (Multiple)']) warn('MISSING_CATEGORY', 'Category (Multiple)',
          'Add at least one category', 'Campaign category is missing.');
        if (!f['REACH/ IMPRESSIONS']) warn('MISSING_REACH', 'REACH/ IMPRESSIONS',
          'Add a source-backed reach or impression estimate', 'Audience estimate is missing for a digital plan.');
      }
      if (slug === 'digital_pr') {
        if (!f.DA) warn('MISSING_DOMAIN_AUTHORITY', 'DA',
          'Add a verified domain authority figure or range', 'Publisher authority is missing from the PR comparison.');
        if (!f.Language) warn('MISSING_LANGUAGE', 'Language',
          'Add the publishing language', 'Language targeting is missing.');
        if (!f.Genre) warn('MISSING_GENRE', 'Genre',
          'Add the publication genre', 'Genre targeting is missing.');
        if (f['Website URL']) {
          try {
            const url = new URL(f['Website URL']);
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error('Invalid URL');
          } catch {
            warn('INVALID_WEBSITE_URL', 'Website URL', 'Use a valid http(s) URL',
              'Publisher website link cannot be used for verification.');
          }
        }
      }
      if (slug === 'magazine') {
        if (number(f.Circulation) == null || number(f.Circulation) <= 0) warn('INVALID_CIRCULATION',
          'Circulation', 'Add a positive circulation figure', 'Audience scale cannot be estimated from circulation.');
      }
      if (slug === 'newspaper') {
        if (!f['Publication (Multiple)']) warn('MISSING_PUBLICATION', 'Publication (Multiple)',
          'Add the newspaper publication', 'Publication filter is missing.');
        if (!f['Language (Multiple)']) warn('MISSING_LANGUAGE', 'Language (Multiple)',
          'Add at least one language', 'Language targeting is missing.');
        if (number(f.Circulation) == null || number(f.Circulation) <= 0) warn('INVALID_CIRCULATION',
          'Circulation', 'Add a positive circulation figure', 'Audience scale cannot be estimated from circulation.');
      }
    }
    if (['tv', 'magazine', 'digital_pr'].includes(slug)) {
      const noUnits = db.prepare(`SELECT po.id,po.product_id,po.source_row FROM related_rows po
        LEFT JOIN related_rows u ON u.option_id=po.id AND u.sheet='Price Unit'
        WHERE po.catalog_slug=? AND po.sheet='Price Option'
        GROUP BY po.id HAVING COUNT(u.id)=0`).all(slug);
      for (const option of noUnits) issue(slug, option.product_id, option.id, 'Price Option',
        option.source_row, 'warning', 'PRICE_UNIT_ROW_MISSING', 'Price Unit', null,
        'Add a quantity rule for this option', 'Plan quantity and minimum booking cannot be validated.');
    }
    // The three original catalogs have more specialized checks (for example
    // Cinema rate-source validation and Radio variant margins). Keep those
    // findings visible in the unified repair workflow as well.
    if (LEGACY_DB_PATHS[slug] && fs.existsSync(LEGACY_DB_PATHS[slug])) {
      const legacy = new Database(LEGACY_DB_PATHS[slug], { readonly: true, fileMustExist: true });
      try {
        const existing = new Set(db.prepare(`SELECT sheet,source_row,code,field,product_id
          FROM data_quality_issues WHERE catalog_slug=?`).all(slug)
          .map((row) => `${row.sheet}|${row.source_row}|${row.code}|${row.field}|${row.product_id || ''}`));
        const findings = legacy.prepare(`SELECT qi.*,p.sku product_sku,po.sku option_sku,
          po.product_sku option_product_sku FROM data_quality_issues qi
          LEFT JOIN products p ON p.id=qi.product_id
          LEFT JOIN price_options po ON po.id=qi.price_option_id`).all();
        for (const finding of findings) {
          const productSku = finding.product_sku || finding.option_product_sku;
          const productId = products.get(productSku) || null;
          const optionId = options.get(`${productSku}\u0000${finding.option_sku}`) || null;
          const key = `${finding.source_sheet}|${finding.source_row}|${finding.code}|${finding.field}|${productId || ''}`;
          if (existing.has(key)) continue;
          existing.add(key);
          issue(slug, productId, optionId, finding.source_sheet, finding.source_row,
            finding.severity, finding.code, finding.field, finding.current_value,
            finding.suggested_value, finding.message);
        }
      } finally { legacy.close(); }
    }
  })();
  const totalIssues = db.prepare('SELECT COUNT(*) count FROM data_quality_issues WHERE catalog_slug=?').get(slug).count;
  console.log(`${label}: ${sheetRows.Product?.length || 0} products, ${totalIssues} issues`);
}

(async () => {
  const requested = process.argv[2];
  const selected = requested === 'remaining'
    ? CATALOGS.filter(([slug]) => !['transit', 'radio', 'cinema'].includes(slug))
    : requested ? CATALOGS.filter(([slug]) => slug === requested) : CATALOGS;
  if (!selected.length) throw new Error(`Unknown catalog: ${requested}`);
  for (const catalog of selected) await importCatalog(catalog);
  finalize();
  console.log(`Ready: ${DB_PATH}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
