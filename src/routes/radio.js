const express = require('express');
const { db } = require('../radio-db');

const router = express.Router();
const PROBLEM_FILTERS = {
  any: '', error: "AND qi.severity='error'", warning: "AND qi.severity='warning'",
  margin: "AND qi.code IN ('SELLING_BELOW_BUYING','VARIANT_SELLING_BELOW_BUYING')",
  image: "AND qi.code IN ('MISSING_PRODUCT_IMAGE','PRODUCT_IMAGE_NOT_FOUND')",
  location: "AND (qi.code='MISSING_CITY' OR qi.code LIKE 'PENDING_MISSING_CITY%')",
  pricing: "AND (qi.code IN ('INVALID_OFFER_RATE','MISSING_BUYING_RATE','SELLING_BELOW_BUYING','VARIANT_SELLING_BELOW_BUYING') OR qi.code LIKE 'PENDING_MISSING_PRICING%')",
  pending: "AND qi.code LIKE 'PENDING_%'"
};

/**
 * @swagger
 * /api/radio/stats:
 *   get:
 *     summary: Radio catalog totals
 *     description: >
 *       **Why we use this:** whoever maintains the radio master needs a quick read of its size and
 *       shape right after an import, without opening the database.
 *
 *
 *       **Who uses it & why:** the catalog admin portal, and the data-ops person who just ran an
 *       import, to confirm it landed correctly.
 *
 *
 *       **How it helps:** one call returns row counts and the tier breakdown instead of several
 *       manual queries.
 *
 *
 *       **Main purpose:** at-a-glance totals for the radio master.
 *     tags: [Radio catalog]
 *     responses:
 *       200:
 *         description: Row counts and a per-tier breakdown.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 products: { type: integer }
 *                 price_options: { type: integer }
 *                 variants: { type: integer }
 *                 issues: { type: integer }
 *                 affected_products: { type: integer }
 *                 tiers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       count: { type: integer }
 *                 imported_at: { type: string, nullable: true }
 */
router.get('/stats', (req, res) => {
  const totals = db.prepare(`SELECT
    (SELECT COUNT(*) FROM products) products, (SELECT COUNT(*) FROM price_options) price_options,
    (SELECT COUNT(*) FROM variants) variants, (SELECT COUNT(*) FROM data_quality_issues) issues,
    (SELECT COUNT(DISTINCT product_id) FROM data_quality_issues WHERE product_id IS NOT NULL) affected_products
  `).get();
  const tiers = db.prepare('SELECT tier name,COUNT(*) count FROM products WHERE tier IS NOT NULL GROUP BY tier ORDER BY count DESC').all();
  const imported = db.prepare("SELECT value FROM import_metadata WHERE key='imported_at'").get();
  res.json({ ...totals, tiers, imported_at: imported?.value || null });
});

/**
 * @swagger
 * /api/radio/filters:
 *   get:
 *     summary: Radio filter values
 *     description: >
 *       **Why we use this:** a filter dropdown needs real, current values instead of a hardcoded
 *       list that drifts from what's actually imported.
 *
 *
 *       **Who uses it & why:** the catalog admin portal's filter controls on the products browse page.
 *
 *
 *       **How it helps:** keeps filter options in sync with whatever the latest import contains.
 *
 *
 *       **Main purpose:** supply the distinct values used to populate browse filters.
 *     tags: [Radio catalog]
 *     responses:
 *       200:
 *         description: Available filter values.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tiers: { type: array, items: { type: string } }
 *                 languages: { type: array, items: { type: string } }
 *                 cities: { type: array, items: { type: string } }
 */
router.get('/filters', (req, res) => {
  const values = (column, table = 'products') => db.prepare(`SELECT DISTINCT ${column} value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${column}`).all().map((row) => row.value);
  res.json({ tiers: values('tier'), languages: values('language'), cities: values('city', 'locations') });
});

/**
 * @swagger
 * /api/radio/problems/summary:
 *   get:
 *     summary: Radio data quality issue summary
 *     description: >
 *       **Why we use this:** an import can carry bad rows (duplicate SKUs, missing images, pricing
 *       below cost); someone needs to see the scale of the problem before fixing it.
 *
 *
 *       **Who uses it & why:** the data-ops team auditing the radio master right after an import.
 *
 *
 *       **How it helps:** groups issues by code and severity so the worst problems surface first.
 *
 *
 *       **Main purpose:** summarize data quality issues found in the radio master.
 *     tags: [Radio catalog]
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
 */
router.get('/problems/summary', (req, res) => {
  const totals = db.prepare(`SELECT COUNT(*) issues,COUNT(DISTINCT product_id) affected_products,
    SUM(severity='error') errors,SUM(severity='warning') warnings FROM data_quality_issues`).get();
  const byCode = db.prepare(`SELECT code,severity,COUNT(*) count,COUNT(DISTINCT product_id) affected_products
    FROM data_quality_issues GROUP BY code,severity ORDER BY severity,count DESC`).all();
  res.json({ ...totals, by_code: byCode });
});

/**
 * @swagger
 * /api/radio/problems.csv:
 *   get:
 *     summary: Download radio data quality issues as CSV
 *     description: >
 *       **Why we use this:** fixing issues usually happens in a spreadsheet, not in this API.
 *
 *
 *       **Who uses it & why:** the data-ops team, to pull every issue into Excel for batch
 *       correction or to hand to whoever owns the source workbook.
 *
 *
 *       **How it helps:** one CSV carries every issue with its product, station, city and source
 *       row, instead of paging through the browse UI.
 *
 *
 *       **Main purpose:** export every data quality issue for offline fixing.
 *     tags: [Radio catalog]
 *     responses:
 *       200:
 *         description: UTF-8 CSV with a BOM, one row per issue.
 *         content:
 *           text/csv:
 *             schema: { type: string }
 */
router.get('/problems.csv', (req, res) => {
  const issues = db.prepare(`SELECT qi.id issue_id,qi.severity,qi.code problem_code,qi.entity_type,
    qi.source_sheet,qi.source_row,p.name product_name,p.sku product_sku,l.city,po.name price_option_name,
    po.sku price_option_sku,v.name variant_name,qi.field,qi.current_value,qi.suggested_value,qi.message
    FROM data_quality_issues qi LEFT JOIN products p ON p.id=qi.product_id
    LEFT JOIN locations l ON l.product_id=p.id LEFT JOIN price_options po ON po.id=qi.price_option_id
    LEFT JOIN variants v ON v.id=qi.variant_id
    ORDER BY CASE qi.severity WHEN 'error' THEN 0 ELSE 1 END,qi.source_sheet,qi.source_row`).all();
  const headers = ['issue_id','severity','problem_code','entity_type','source_sheet','source_row','product_name','product_sku','city','price_option_name','price_option_sku','variant_name','field','current_value','suggested_value','message'];
  const csv = [headers, ...issues.map((issue) => headers.map((header) => issue[header]))]
    .map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="radio-master-problems.csv"');
  res.send(`\uFEFF${csv}`);
});

/**
 * @swagger
 * /api/radio/products:
 *   get:
 *     summary: Browse radio products
 *     description: >
 *       **Why we use this:** someone needs to search and filter the imported catalog to check
 *       what's actually in it, beyond raw totals.
 *
 *
 *       **Who uses it & why:** the catalog admin portal, for data-ops verifying an import and desk
 *       staff checking what's currently sellable.
 *
 *
 *       **How it helps:** a filterable, sortable listing with pricing and issue counts per station,
 *       in one call.
 *
 *
 *       **Main purpose:** browse and search the radio product catalog.
 *     tags: [Radio catalog]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Matches name, SKU, station or city. }
 *       - { in: query, name: tier, schema: { type: string } }
 *       - { in: query, name: language, schema: { type: string } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: problem, schema: { type: string, enum: [any, error, warning, margin, image, location, pricing, pending, clean] } }
 *       - { in: query, name: sort, schema: { type: string, enum: [name, price_low, price_high, rank, source], default: source } }
 *     responses:
 *       200:
 *         description: All matching products (this catalog is not paginated server-side).
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
 *                       name: { type: string }
 *                       sku: { type: string }
 *                       short_description: { type: string }
 *                       image: { type: string }
 *                       tier: { type: string }
 *                       station: { type: string }
 *                       language: { type: string }
 *                       audience: { type: string }
 *                       frequency: { type: string }
 *                       rank: { type: number, nullable: true }
 *                       listenership: { type: string }
 *                       show_timing: { type: string }
 *                       coverage_area: { type: string }
 *                       city: { type: string }
 *                       state: { type: string }
 *                       country: { type: string }
 *                       price_option_count: { type: integer }
 *                       min_rate: { type: number, nullable: true }
 *                       max_rate: { type: number, nullable: true }
 *                       min_buying_rate: { type: number, nullable: true }
 *                       variant_count: { type: integer }
 *                       issue_count: { type: integer }
 *                       error_count: { type: integer }
 *                       loss_price_count: { type: integer }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 */
router.get('/products', (req, res) => {
  const search = clean(req.query.search); const tier = clean(req.query.tier);
  const language = clean(req.query.language); const city = clean(req.query.city); const problem = clean(req.query.problem);
  const conditions = []; const params = {};
  if (search) { conditions.push('(p.name LIKE @search OR p.sku LIKE @search OR p.station LIKE @search OR l.city LIKE @search)'); params.search = `%${search}%`; }
  if (tier) { conditions.push('p.tier=@tier'); params.tier = tier; }
  if (language) { conditions.push('p.language LIKE @language'); params.language = `%${language}%`; }
  if (city) { conditions.push('l.city=@city'); params.city = city; }
  if (problem === 'clean') conditions.push('NOT EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id)');
  else if (Object.hasOwn(PROBLEM_FILTERS, problem)) conditions.push(`EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id ${PROBLEM_FILTERS[problem]})`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sorts = { name: 'p.name COLLATE NOCASE', price_low: 'min_rate IS NULL,min_rate', price_high: 'max_rate IS NULL,max_rate DESC', rank: 'p.rank IS NULL,p.rank', source: 'p.sort_order IS NULL,p.sort_order,p.id' };
  const order = sorts[req.query.sort] || sorts.source;
  const data = db.prepare(`SELECT p.id,p.name,p.sku,p.short_description,p.image,p.tier,p.station,p.language,
    p.audience,p.frequency,p.rank,p.listenership,p.show_timing,p.coverage_area,l.city,l.state,l.country,
    COUNT(DISTINCT po.id) price_option_count,MIN(COALESCE(po.discounted_rate,po.offer_rate)) min_rate,
    MAX(COALESCE(po.discounted_rate,po.offer_rate)) max_rate,MIN(po.specific_buying_rate) min_buying_rate,
    (SELECT COUNT(*) FROM variants v WHERE v.product_id=p.id) variant_count,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id) issue_count,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.severity='error') error_count,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.code IN ('SELLING_BELOW_BUYING','VARIANT_SELLING_BELOW_BUYING')) loss_price_count
    FROM products p LEFT JOIN locations l ON l.product_id=p.id LEFT JOIN price_options po ON po.product_id=p.id
    ${where} GROUP BY p.id ORDER BY ${order} LIMIT 10000`).all(params);
  res.json({ data, pagination: { page: 1, page_size: data.length, total: data.length, pages: data.length ? 1 : 0, show_all: true } });
});

/**
 * @swagger
 * /api/radio/products/{id}:
 *   get:
 *     summary: Get a radio product
 *     description: >
 *       Includes locations, price options (with units, attributes and variants), and data quality issues.
 *
 *
 *       **Why we use this:** diagnosing one station's issues, or quoting its exact rate card,
 *       needs more detail than the list view gives.
 *
 *
 *       **Who uses it & why:** data-ops drilling into a flagged product, and desk staff checking
 *       exact pricing for one variant.
 *
 *
 *       **How it helps:** returns locations, the full price-option/variant tree and that product's
 *       issues in one call.
 *
 *
 *       **Main purpose:** full detail for a single radio product.
 *     tags: [Radio catalog]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: The product.
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       404:
 *         description: Radio product not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/products/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!product) return res.status(404).json({ error: 'Radio product not found' });
  product.locations = db.prepare('SELECT * FROM locations WHERE product_id=? ORDER BY id').all(id);
  product.issues = db.prepare(`SELECT * FROM data_quality_issues WHERE product_id=?
    ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END,source_sheet,source_row,id`).all(id);
  product.price_options = db.prepare(`SELECT *,COALESCE(discounted_rate,offer_rate) effective_client_rate,
    CASE WHEN specific_buying_rate IS NULL THEN NULL ELSE COALESCE(discounted_rate,offer_rate)-specific_buying_rate END effective_margin,
    CASE WHEN specific_buying_rate IS NOT NULL AND ((offer_rate IS NOT NULL AND offer_rate<specific_buying_rate) OR (discounted_rate IS NOT NULL AND discounted_rate<specific_buying_rate)) THEN 1 ELSE 0 END has_loss
    FROM price_options WHERE product_id=? ORDER BY sort_order IS NULL,sort_order,id`).all(id);
  const units = db.prepare('SELECT * FROM price_units WHERE price_option_id=? ORDER BY sort_order,id');
  const attributes = db.prepare('SELECT * FROM attributes WHERE price_option_id=? ORDER BY sort_order,id');
  const values = db.prepare('SELECT * FROM attribute_values WHERE attribute_id=? ORDER BY sort_order,id');
  const variants = db.prepare('SELECT * FROM variants WHERE price_option_id=? ORDER BY id');
  for (const option of product.price_options) {
    option.units = units.all(option.id);
    option.attributes = attributes.all(option.id).map((attribute) => ({ ...attribute, values: values.all(attribute.id) }));
    option.variants = variants.all(option.id).map((variant) => ({ ...variant, attributes: JSON.parse(variant.attributes_json) }));
  }
  return res.json(product);
});

function clean(value) { return typeof value === 'string' ? value.trim().slice(0, 120) : ''; }
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let string = String(value); if (/^[=+\-@]/.test(string)) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}
module.exports = router;
