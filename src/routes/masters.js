const express = require('express');
const { db } = require('../other-masters-db');

const router = express.Router();
const ENABLED_CATALOGS = ['cinema', 'magazine', 'radio', 'transit'];
const FACETS = {
  cinema: ['Cinema Chain', 'Tier Preference', 'Audience Class'],
  magazine: ['Category', 'Frequency', 'Language (Multiple)', 'Country', 'Edition'],
  radio: ['Tier', 'Station', 'Language (Multiple)', 'Audience'],
  transit: ['Media Type', 'Tier (Multiple)']
};

function catalog(req, res, next) {
  if (!ENABLED_CATALOGS.includes(req.params.slug)) return res.status(404).json({ error: 'Master not found' });
  const item = db.prepare('SELECT * FROM catalogs WHERE slug=?').get(req.params.slug);
  if (!item) return res.status(404).json({ error: 'Master not found' });
  req.catalog = item;
  next();
}
function clean(value, length = 140) { return typeof value === 'string' ? value.trim().slice(0, length) : ''; }
function csvCell(value) {
  if (value == null) return '';
  let string = String(value);
  if (/^[=+\-@]/.test(string)) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

/**
 * @swagger
 * /api/masters:
 *   get:
 *     summary: List available masters
 *     description: >
 *       The cinema, magazine, radio and transit masters, with totals and a link to each portal.
 *
 *
 *       **Why we use this:** there's no single place to see every master at a glance, including
 *       magazine, which has no dedicated router of its own.
 *
 *
 *       **Who uses it & why:** the masters admin portal's landing page, for whoever needs to jump
 *       into a specific master's catalog.
 *
 *
 *       **How it helps:** one call lists every master with its totals and a link into its portal.
 *
 *
 *       **Main purpose:** landing/index of all available masters.
 *     tags: [Masters catalog]
 *     responses:
 *       200:
 *         description: The master list.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 catalogs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       slug: { type: string, enum: [cinema, magazine, radio, transit] }
 *                       label: { type: string }
 *                       workbook: { type: string }
 *                       imported_at: { type: string, nullable: true }
 *                       products: { type: integer }
 *                       price_options: { type: integer }
 *                       issues: { type: integer }
 *                       affected_products: { type: integer }
 *                       href: { type: string }
 *                       sheet_counts: { type: object }
 */
router.get('/', (_req, res) => {
  const catalogs = db.prepare(`SELECT c.slug,c.label,c.workbook,c.imported_at,c.sheet_counts_json,
    COUNT(DISTINCT p.id) products,
    (SELECT COUNT(*) FROM related_rows r WHERE r.catalog_slug=c.slug AND r.sheet='Price Option') price_options,
    (SELECT COUNT(*) FROM data_quality_issues i WHERE i.catalog_slug=c.slug) issues,
    (SELECT COUNT(DISTINCT i.product_id) FROM data_quality_issues i WHERE i.catalog_slug=c.slug) affected_products
    FROM catalogs c LEFT JOIN products p ON p.catalog_slug=c.slug
    WHERE c.slug IN ('cinema','magazine','radio','transit')
    GROUP BY c.slug ORDER BY c.label`).all()
    .map((item) => ({ ...item, href: `/${item.slug === 'digital_pr' ? 'digital-pr' : item.slug}/`,
      sheet_counts: JSON.parse(item.sheet_counts_json) }));
  res.json({ catalogs });
});

/**
 * @swagger
 * /api/masters/{slug}/stats:
 *   get:
 *     summary: Master totals
 *     description: >
 *       **Why we use this:** whoever maintains a given master needs a quick read of its size and
 *       shape right after an import, without opening the database — this is the generic version
 *       of /api/transit/stats etc. that also covers magazine.
 *
 *
 *       **Who uses it & why:** the masters admin portal, and the data-ops person who just ran an
 *       import, to confirm it landed correctly.
 *
 *
 *       **How it helps:** one call returns row counts for this master instead of several manual queries.
 *
 *
 *       **Main purpose:** at-a-glance totals for one master by slug.
 *     tags: [Masters catalog]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, enum: [cinema, magazine, radio, transit] } }
 *     responses:
 *       200:
 *         description: Row counts for this master.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 products: { type: integer }
 *                 price_options: { type: integer }
 *                 price_units: { type: integer }
 *                 variants: { type: integer }
 *                 locations: { type: integer }
 *                 issues: { type: integer }
 *                 affected_products: { type: integer }
 *                 errors: { type: integer }
 *                 imported_at: { type: string, nullable: true }
 *                 sheet_counts: { type: object }
 *       404:
 *         description: Master not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:slug/stats', catalog, (req, res) => {
  const slug = req.catalog.slug;
  const stats = db.prepare(`SELECT
    (SELECT COUNT(*) FROM products WHERE catalog_slug=@slug) products,
    (SELECT COUNT(*) FROM related_rows WHERE catalog_slug=@slug AND sheet='Price Option') price_options,
    (SELECT COUNT(*) FROM related_rows WHERE catalog_slug=@slug AND sheet='Price Unit') price_units,
    (SELECT COUNT(*) FROM related_rows WHERE catalog_slug=@slug AND sheet='Variant') variants,
    (SELECT COUNT(*) FROM related_rows WHERE catalog_slug=@slug AND sheet='Location') locations,
    (SELECT COUNT(*) FROM data_quality_issues WHERE catalog_slug=@slug) issues,
    (SELECT COUNT(DISTINCT product_id) FROM data_quality_issues WHERE catalog_slug=@slug) affected_products,
    (SELECT COUNT(*) FROM data_quality_issues WHERE catalog_slug=@slug AND severity='error') errors`).get({ slug });
  res.json({ ...stats, imported_at: req.catalog.imported_at, sheet_counts: JSON.parse(req.catalog.sheet_counts_json) });
});

/**
 * @swagger
 * /api/masters/{slug}/filters:
 *   get:
 *     summary: Master filter values
 *     description: >
 *       Facet values drawn from each product's field data, plus the distinct cities seen in its Location rows.
 *
 *
 *       **Why we use this:** a filter dropdown needs real, current values instead of a hardcoded
 *       list that drifts from what's actually imported, generic across every master's own fields.
 *
 *
 *       **Who uses it & why:** the masters admin portal's filter controls on the products browse page.
 *
 *
 *       **How it helps:** keeps filter options in sync with whatever the latest import contains,
 *       regardless of which master it is.
 *
 *
 *       **Main purpose:** supply the distinct facet and city values for one master's browse filters.
 *     tags: [Masters catalog]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, enum: [cinema, magazine, radio, transit] } }
 *     responses:
 *       200:
 *         description: Available facets and cities.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 facets: { type: object, additionalProperties: { type: array, items: { type: string } } }
 *                 cities: { type: array, items: { type: string } }
 *       404:
 *         description: Master not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:slug/filters', catalog, (req, res) => {
  const fields = FACETS[req.catalog.slug] || [];
  const rows = db.prepare('SELECT fields_json FROM products WHERE catalog_slug=?').all(req.catalog.slug);
  const facets = Object.fromEntries(fields.map((field) => [field, new Set()]));
  for (const row of rows) {
    const data = JSON.parse(row.fields_json);
    for (const field of fields) {
      if (!data[field]) continue;
      for (const value of String(data[field]).split(';').map((part) => part.trim()).filter(Boolean)) facets[field].add(value);
    }
  }
  const locations = db.prepare(`SELECT fields_json FROM related_rows
    WHERE catalog_slug=? AND sheet='Location'`).all(req.catalog.slug);
  const cities = [...new Set(locations.map((row) => JSON.parse(row.fields_json).City).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  res.json({ facets: Object.fromEntries(fields.map((field) => [field,
    [...facets[field]].sort((a, b) => a.localeCompare(b))])), cities });
});

/**
 * @swagger
 * /api/masters/{slug}/problems/summary:
 *   get:
 *     summary: Master data quality issue summary
 *     description: >
 *       **Why we use this:** an import can carry bad rows (duplicate SKUs, missing images,
 *       pricing below cost); someone needs to see the scale of the problem before fixing it,
 *       for any master by slug.
 *
 *
 *       **Who uses it & why:** the data-ops team auditing a master right after an import.
 *
 *
 *       **How it helps:** groups issues by code and severity so the worst problems surface first.
 *
 *
 *       **Main purpose:** summarize data quality issues found in one master.
 *     tags: [Masters catalog]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, enum: [cinema, magazine, radio, transit] } }
 *     responses:
 *       200:
 *         description: Issue totals grouped by code and severity.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 issues: { type: integer }
 *                 affected_products: { type: integer }
 *                 errors: { type: integer }
 *                 warnings: { type: integer }
 *                 by_code:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       code: { type: string }
 *                       severity: { type: string, enum: [error, warning] }
 *                       count: { type: integer }
 *                       affected_products: { type: integer }
 *       404:
 *         description: Master not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:slug/problems/summary', catalog, (req, res) => {
  const totals = db.prepare(`SELECT COUNT(*) issues,COUNT(DISTINCT product_id) affected_products,
    SUM(severity='error') errors,SUM(severity='warning') warnings
    FROM data_quality_issues WHERE catalog_slug=?`).get(req.catalog.slug);
  const byCode = db.prepare(`SELECT code,severity,COUNT(*) count,COUNT(DISTINCT product_id) affected_products
    FROM data_quality_issues WHERE catalog_slug=? GROUP BY code,severity ORDER BY count DESC,code`).all(req.catalog.slug);
  res.json({ ...totals, by_code: byCode });
});

function sendProblemCsv(res, slug = null) {
  const columns = ['master','issue_id','severity','problem_code','source_sheet','source_row','product_name','product_sku',
    'product_description','product_image','price_option_name','price_option_sku','offer_rate','buying_rate',
    'discounted_rate','minimum_billing','pricing_unit','field','current_value','suggested_value','message',
    'product_fields_json','related_fields_json'];
  const records = db.prepare(`SELECT i.catalog_slug master,i.id issue_id,i.severity,i.code problem_code,i.sheet source_sheet,
    i.source_row,p.name product_name,p.sku product_sku,p.description product_description,p.image product_image,
    COALESCE(o.name,r.name) price_option_name,COALESCE(o.option_sku,r.option_sku) price_option_sku,
    COALESCE(o.price,r.price) offer_rate,COALESCE(o.buying_rate,r.buying_rate) buying_rate,
    COALESCE(o.discounted_rate,r.discounted_rate) discounted_rate,
    COALESCE(o.minimum_billing,r.minimum_billing) minimum_billing,
    COALESCE(o.pricing_unit,r.pricing_unit) pricing_unit,i.field,i.current_value,i.suggested_value,i.message,
    p.fields_json product_fields_json,r.fields_json related_fields_json
    FROM data_quality_issues i LEFT JOIN products p ON p.id=i.product_id
    LEFT JOIN related_rows r ON r.id=i.related_row_id
    LEFT JOIN related_rows o ON o.id=CASE WHEN r.sheet='Price Option' THEN r.id ELSE r.option_id END
    WHERE ((@slug IS NULL AND i.catalog_slug IN ('cinema','magazine','radio','transit')) OR i.catalog_slug=@slug)
    ORDER BY CASE i.severity WHEN 'error' THEN 0 ELSE 1 END,i.catalog_slug,i.sheet,i.source_row,i.id`).all({ slug });
  const csv = [columns, ...records.map((row) => columns.map((key) => row[key]))]
    .map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${slug || 'all'}-master-problems.csv"`);
  res.send(`\uFEFF${csv}`);
}
/**
 * @swagger
 * /api/masters/problems.csv:
 *   get:
 *     summary: Download data quality issues for every master as CSV
 *     description: >
 *       **Why we use this:** sometimes a clean-up pass spans every master, not just one, and
 *       fixing issues happens in a spreadsheet, not in this API.
 *
 *
 *       **Who uses it & why:** the data-ops team doing a full audit pass across all masters at once.
 *
 *
 *       **How it helps:** one CSV carries every issue from every master, ready for batch correction.
 *
 *
 *       **Main purpose:** export every data quality issue, across all masters, for offline fixing.
 *     tags: [Masters catalog]
 *     responses:
 *       200:
 *         description: UTF-8 CSV with a BOM, one row per issue across all masters.
 *         content:
 *           text/csv:
 *             schema: { type: string }
 */
router.get('/problems.csv', (_req, res) => sendProblemCsv(res));

/**
 * @swagger
 * /api/masters/{slug}/problems.csv:
 *   get:
 *     summary: Download data quality issues for one master as CSV
 *     description: >
 *       **Why we use this:** fixing issues usually happens in a spreadsheet, not in this API,
 *       scoped to a single master.
 *
 *
 *       **Who uses it & why:** the data-ops team, to pull one master's issues into Excel for
 *       batch correction or to hand to whoever owns the source workbook.
 *
 *
 *       **How it helps:** one CSV carries every issue for that master with its source row context.
 *
 *
 *       **Main purpose:** export one master's data quality issues for offline fixing.
 *     tags: [Masters catalog]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, enum: [cinema, magazine, radio, transit] } }
 *     responses:
 *       200:
 *         description: UTF-8 CSV with a BOM, one row per issue.
 *         content:
 *           text/csv:
 *             schema: { type: string }
 *       404:
 *         description: Master not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:slug/problems.csv', catalog, (req, res) => sendProblemCsv(res, req.catalog.slug));

/**
 * @swagger
 * /api/masters/{slug}/annex:
 *   get:
 *     summary: Master annex rows
 *     description: >
 *       Rows with no parent product — rate cards, offer rate sources and pending fixes sheets.
 *
 *
 *       **Why we use this:** some imported rows (Qube rate cards, offer rate sources, pending
 *       fixes) don't belong to any single product, but still need to be reviewed.
 *
 *
 *       **Who uses it & why:** the data-ops team reviewing what the import left outside the main
 *       product list.
 *
 *
 *       **How it helps:** surfaces these otherwise-invisible rows in one call instead of leaving
 *       them undiscoverable.
 *
 *
 *       **Main purpose:** list a master's rows that have no parent product.
 *     tags: [Masters catalog]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, enum: [cinema, magazine, radio, transit] } }
 *     responses:
 *       200:
 *         description: Up to 2500 annex rows.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sheet: { type: string, enum: ['Qube Rate Card', 'Offer Rate Source', 'Pending Fixes'] }
 *                       source_row: { type: integer }
 *                       name: { type: string, nullable: true }
 *                       fields: { type: object }
 *       404:
 *         description: Master not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:slug/annex', catalog, (req, res) => {
  const rows = db.prepare(`SELECT sheet,source_row,name,fields_json FROM related_rows
    WHERE catalog_slug=? AND product_id IS NULL AND sheet IN ('Qube Rate Card','Offer Rate Source','Pending Fixes')
    ORDER BY sheet,source_row LIMIT 2500`).all(req.catalog.slug);
  res.json({ data: rows.map((row) => ({ sheet: row.sheet, source_row: row.source_row,
    name: row.name, fields: JSON.parse(row.fields_json) })) });
});

/**
 * @swagger
 * /api/masters/{slug}/products:
 *   get:
 *     summary: Browse a master's products
 *     description: >
 *       **Why we use this:** someone needs to search and filter an imported catalog to check
 *       what's actually in it, for any master by slug, with that master's own facets.
 *
 *
 *       **Who uses it & why:** the masters admin portal, for data-ops verifying an import and desk
 *       staff checking what's currently sellable.
 *
 *
 *       **How it helps:** a paginated, filterable, sortable listing with pricing and issue counts
 *       per product, generic across masters.
 *
 *
 *       **Main purpose:** browse and search one master's product catalog.
 *     tags: [Masters catalog]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, enum: [cinema, magazine, radio, transit] } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches name, SKU or field data. }
 *       - { in: query, name: status, schema: { type: string, enum: [active, inactive] } }
 *       - { in: query, name: problem, schema: { type: string }, description: 'any, error, warning, margin, clean, or a specific issue code.' }
 *       - { in: query, name: facet, schema: { type: string }, description: 'Facet name from /api/masters/{slug}/filters. Also facet_1, facet_2, facet_3 for additional facets.' }
 *       - { in: query, name: facet_value, schema: { type: string }, description: 'Paired with facet. Also facet_value_1, facet_value_2, facet_value_3.' }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: sort, schema: { type: string, enum: [source, name, price_low, price_high, issues], default: source } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: page_size, schema: { type: integer, default: 60, maximum: 200 } }
 *     responses:
 *       200:
 *         description: Page of products.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       source_row: { type: integer }
 *                       sku: { type: string }
 *                       name: { type: string }
 *                       description: { type: string }
 *                       image_url: { type: string }
 *                       status: { type: integer }
 *                       fields: { type: object }
 *                       price_option_count: { type: integer }
 *                       min_price: { type: number, nullable: true }
 *                       max_price: { type: number, nullable: true }
 *                       issue_count: { type: integer }
 *                       error_count: { type: integer }
 *                       loss_price_count: { type: integer }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 *       404:
 *         description: Master not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:slug/products', catalog, (req, res) => {
  const params = { slug: req.catalog.slug };
  const conditions = ['p.catalog_slug=@slug'];
  const search = clean(req.query.search);
  if (search) { conditions.push('(p.name LIKE @search OR p.sku LIKE @search OR p.fields_json LIKE @search)'); params.search = `%${search}%`; }
  const status = clean(req.query.status);
  if (status === 'active' || status === 'inactive') { conditions.push('p.status=@status'); params.status = status === 'active' ? 1 : 0; }
  const problem = clean(req.query.problem);
  if (problem === 'clean') conditions.push('NOT EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id)');
  else if (problem === 'any' || problem === 'error' || problem === 'warning') {
    conditions.push(`EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id ${problem === 'any' ? '' : 'AND qi.severity=@severity'})`);
    if (problem !== 'any') params.severity = problem;
  } else if (problem === 'margin') conditions.push(`EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.code LIKE '%SELLING_BELOW_BUYING%')`);
  else if (problem && /^[A-Z_]+$/.test(problem)) {
    conditions.push('EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.code=@code)');
    params.code = problem;
  }
  for (const suffix of ['', '_1', '_2', '_3']) {
    const facet = clean(req.query[`facet${suffix}`]);
    const facetValue = clean(req.query[`facet_value${suffix}`]);
    if (!facet || !facetValue || !(FACETS[req.catalog.slug] || []).includes(facet)) continue;
    const pathKey = `facetPath${suffix.replace('_', '')}`;
    const valueKey = `facetValue${suffix.replace('_', '')}`;
    conditions.push(`INSTR(';' || LOWER(REPLACE(COALESCE(json_extract(p.fields_json,@${pathKey}),''),' ','')) || ';',
      ';' || LOWER(REPLACE(@${valueKey},' ','')) || ';') > 0`);
    params[pathKey] = `$.${JSON.stringify(facet)}`;
    params[valueKey] = facetValue;
  }
  const city = clean(req.query.city);
  if (city) {
    conditions.push(`EXISTS (SELECT 1 FROM related_rows loc WHERE loc.product_id=p.id
      AND loc.sheet='Location' AND json_extract(loc.fields_json,'$.City')=@city)`);
    params.city = city;
  }
  const where = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) count FROM products p WHERE ${where}`).get(params).count;
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(req.query.page_size, 10) || 60));
  const pages = Math.ceil(total / pageSize);
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), Math.max(1, pages));
  const order = {
    source: 'p.sort_order IS NULL,p.sort_order,p.id', name: 'p.name COLLATE NOCASE,p.id',
    price_low: 'min_price IS NULL,min_price,p.id', price_high: 'max_price IS NULL,max_price DESC,p.id',
    issues: 'error_count DESC,issue_count DESC,p.id'
  }[clean(req.query.sort)] || 'p.sort_order IS NULL,p.sort_order,p.id';
  const data = db.prepare(`SELECT p.id,p.source_row,p.sku,p.name,p.description,p.image_url,p.status,p.fields_json,
    (SELECT COUNT(*) FROM related_rows r WHERE r.product_id=p.id AND r.sheet='Price Option') price_option_count,
    (SELECT MIN(COALESCE(r.discounted_rate,r.price)) FROM related_rows r WHERE r.product_id=p.id AND r.sheet='Price Option') min_price,
    (SELECT MAX(COALESCE(r.discounted_rate,r.price)) FROM related_rows r WHERE r.product_id=p.id AND r.sheet='Price Option') max_price,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id) issue_count,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.severity='error') error_count,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.code LIKE '%SELLING_BELOW_BUYING%') loss_price_count
    FROM products p WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize })
    .map((item) => ({ ...item, fields: JSON.parse(item.fields_json), fields_json: undefined }));
  res.json({ data, pagination: { page, page_size: pageSize, total, pages } });
});

/**
 * @swagger
 * /api/masters/{slug}/products/{id}:
 *   get:
 *     summary: Get a master's product
 *     description: >
 *       Includes every related sheet row (Price Option, Location, etc.), grouped by sheet name, and data quality issues.
 *
 *
 *       **Why we use this:** diagnosing one product's issues, or quoting its exact rate card,
 *       needs more detail than the list view gives, for any master by slug.
 *
 *
 *       **Who uses it & why:** data-ops drilling into a flagged product, and desk staff checking
 *       exact pricing for one item.
 *
 *
 *       **How it helps:** returns every related sheet row, grouped by sheet, plus that product's
 *       issues, in one call.
 *
 *
 *       **Main purpose:** full detail for a single product in one master.
 *     tags: [Masters catalog]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, enum: [cinema, magazine, radio, transit] } }
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: The product.
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       404:
 *         description: Master or product not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:slug/products/:id', catalog, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Product not found' });
  const product = db.prepare('SELECT * FROM products WHERE id=? AND catalog_slug=?').get(id, req.catalog.slug);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  product.fields = JSON.parse(product.fields_json);
  delete product.fields_json;
  const rows = db.prepare('SELECT * FROM related_rows WHERE product_id=? ORDER BY source_row,id').all(id);
  product.rows = {};
  for (const row of rows) {
    row.fields = JSON.parse(row.fields_json);
    delete row.fields_json;
    (product.rows[row.sheet] ||= []).push(row);
  }
  product.issues = db.prepare(`SELECT * FROM data_quality_issues WHERE product_id=?
    ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END,sheet,source_row,id`).all(id);
  res.json(product);
});

module.exports = router;
