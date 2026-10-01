const express = require('express');
const { db } = require('../db');

const router = express.Router();

const PROBLEM_FILTERS = {
  any: '',
  error: "AND qi.severity = 'error'",
  warning: "AND qi.severity = 'warning'",
  duplicate: "AND qi.code IN ('DUPLICATE_PRODUCT_SKU', 'DUPLICATE_PRICE_OPTION_SKU')",
  product_image: "AND qi.code IN ('MISSING_PRODUCT_IMAGE', 'PRODUCT_IMAGE_NOT_FOUND')",
  price_image: "AND qi.code IN ('MISSING_PRICE_OPTION_IMAGE', 'PRICE_OPTION_IMAGE_NOT_FOUND')",
  pricing: "AND qi.code IN ('INVALID_OFFER_RATE', 'INVALID_MINIMUM_BILLING', 'MISSING_BUYING_RATE', 'SELLING_BELOW_BUYING', 'DISCOUNT_ABOVE_OFFER')",
  margin: "AND qi.code = 'SELLING_BELOW_BUYING'",
  sku: "AND qi.code IN ('DUPLICATE_PRODUCT_SKU', 'DUPLICATE_PRICE_OPTION_SKU', 'INVALID_PRICE_OPTION_SKU')",
  media: "AND qi.code = 'MEDIA_TYPE_TYPO'"
};

/**
 * @swagger
 * /api/transit/stats:
 *   get:
 *     summary: Transit catalog totals
 *     description: >
 *       **Why we use this:** whoever maintains the transit master needs a quick read of its size
 *       and shape right after an import, without opening the database.
 *
 *
 *       **Who uses it & why:** the catalog admin portal, and the data-ops person who just ran an
 *       import, to confirm it landed correctly.
 *
 *
 *       **How it helps:** one call returns row counts and the media-type breakdown instead of
 *       several manual queries.
 *
 *
 *       **Main purpose:** at-a-glance totals for the transit master.
 *     tags: [Transit catalog]
 *     responses:
 *       200:
 *         description: Row counts and a per-media-type breakdown.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 products: { type: integer }
 *                 price_options: { type: integer }
 *                 price_units: { type: integer }
 *                 media_types: { type: integer }
 *                 issues: { type: integer }
 *                 affected_products: { type: integer }
 *                 media:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       count: { type: integer }
 *                 imported_at: { type: string, nullable: true }
 */
router.get('/stats', (req, res) => {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM price_options) AS price_options,
      (SELECT COUNT(*) FROM price_units) AS price_units,
      (SELECT COUNT(DISTINCT media_type) FROM products WHERE media_type IS NOT NULL) AS media_types,
      (SELECT COUNT(*) FROM data_quality_issues) AS issues,
      (SELECT COUNT(DISTINCT product_id) FROM data_quality_issues WHERE product_id IS NOT NULL) AS affected_products
  `).get();
  const media = db.prepare(`
    SELECT media_type AS name, COUNT(*) AS count
    FROM products
    WHERE media_type IS NOT NULL
    GROUP BY media_type
    ORDER BY count DESC, name
  `).all();
  const importedAt = db.prepare("SELECT value FROM import_metadata WHERE key = 'imported_at'").get();
  res.json({ ...totals, media, imported_at: importedAt?.value || null });
});

/**
 * @swagger
 * /api/transit/filters:
 *   get:
 *     summary: Transit filter values
 *     description: >
 *       Distinct media types and tiers available, for populating browse filters.
 *
 *
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
 *     tags: [Transit catalog]
 *     responses:
 *       200:
 *         description: Available filter values.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 media_types: { type: array, items: { type: string } }
 *                 tiers: { type: array, items: { type: string } }
 */
router.get('/filters', (req, res) => {
  const mediaTypes = db.prepare(`SELECT DISTINCT media_type AS value FROM products WHERE media_type IS NOT NULL ORDER BY media_type`).all();
  const tiers = db.prepare(`SELECT DISTINCT tier AS value FROM products WHERE tier IS NOT NULL ORDER BY tier`).all();
  res.json({ media_types: mediaTypes.map((item) => item.value), tiers: tiers.map((item) => item.value) });
});

/**
 * @swagger
 * /api/transit/problems/summary:
 *   get:
 *     summary: Transit data quality issue summary
 *     description: >
 *       **Why we use this:** an import can carry bad rows (duplicate SKUs, missing images, pricing
 *       below cost); someone needs to see the scale of the problem before fixing it.
 *
 *
 *       **Who uses it & why:** the data-ops team auditing the transit master right after an import.
 *
 *
 *       **How it helps:** groups issues by code and severity so the worst problems surface first.
 *
 *
 *       **Main purpose:** summarize data quality issues found in the transit master.
 *     tags: [Transit catalog]
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
  const byCode = db.prepare(`
    SELECT code, severity, COUNT(*) AS count, COUNT(DISTINCT product_id) AS affected_products
    FROM data_quality_issues
    GROUP BY code, severity
    ORDER BY severity, count DESC, code
  `).all();
  const totals = db.prepare(`
    SELECT COUNT(*) AS issues, COUNT(DISTINCT product_id) AS affected_products,
      SUM(severity = 'error') AS errors, SUM(severity = 'warning') AS warnings
    FROM data_quality_issues
  `).get();
  res.json({ ...totals, by_code: byCode });
});

/**
 * @swagger
 * /api/transit/problems.csv:
 *   get:
 *     summary: Download transit data quality issues as CSV
 *     description: >
 *       **Why we use this:** fixing issues usually happens in a spreadsheet, not in this API.
 *
 *
 *       **Who uses it & why:** the data-ops team, to pull every issue into Excel for batch
 *       correction or to hand to whoever owns the source workbook.
 *
 *
 *       **How it helps:** one CSV carries every issue with its product, price option and source
 *       row, instead of paging through the browse UI.
 *
 *
 *       **Main purpose:** export every data quality issue for offline fixing.
 *     tags: [Transit catalog]
 *     responses:
 *       200:
 *         description: UTF-8 CSV with a BOM, one row per issue.
 *         content:
 *           text/csv:
 *             schema: { type: string }
 */
router.get('/problems.csv', (req, res) => {
  const issues = db.prepare(`
    SELECT
      qi.id AS issue_id, qi.severity, qi.code AS problem_code,
      qi.entity_type, qi.source_sheet, qi.source_row,
      p.name AS product_name, p.sku AS product_sku,
      po.name AS price_option_name, po.sku AS price_option_sku,
      qi.field, qi.current_value, qi.suggested_value, qi.message
    FROM data_quality_issues qi
    LEFT JOIN products p ON p.id = qi.product_id
    LEFT JOIN price_options po ON po.id = qi.price_option_id
    ORDER BY CASE qi.severity WHEN 'error' THEN 0 ELSE 1 END,
      qi.source_sheet, qi.source_row, qi.id
  `).all();
  const headers = [
    'issue_id', 'severity', 'problem_code', 'entity_type', 'source_sheet',
    'source_row', 'product_name', 'product_sku', 'price_option_name',
    'price_option_sku', 'field', 'current_value', 'suggested_value', 'message'
  ];
  const csv = [headers, ...issues.map((issue) => headers.map((header) => issue[header]))]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="transit-master-problems.csv"');
  res.send(`\uFEFF${csv}`);
});

/**
 * @swagger
 * /api/transit/products:
 *   get:
 *     summary: Browse transit products
 *     description: >
 *       **Why we use this:** someone needs to search and filter the imported catalog to check
 *       what's actually in it, beyond raw totals.
 *
 *
 *       **Who uses it & why:** the catalog admin portal, for data-ops verifying an import and desk
 *       staff checking what's currently sellable.
 *
 *
 *       **How it helps:** a paginated, filterable, sortable listing with pricing and issue counts
 *       per product, in one call.
 *
 *
 *       **Main purpose:** browse and search the transit product catalog.
 *     tags: [Transit catalog]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: page_size, schema: { type: integer, default: 24, maximum: 100 } }
 *       - { in: query, name: show_all, schema: { type: boolean }, description: Returns every matching row, ignoring page_size. }
 *       - { in: query, name: search, schema: { type: string }, description: Matches name, SKU or short description. }
 *       - { in: query, name: media_type, schema: { type: string } }
 *       - { in: query, name: tier, schema: { type: string } }
 *       - { in: query, name: problem, schema: { type: string, enum: [any, error, warning, duplicate, product_image, price_image, pricing, margin, sku, media, clean] } }
 *       - { in: query, name: sort, schema: { type: string, enum: [name, newest, price_low, price_high, source], default: source } }
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
 *                       name: { type: string }
 *                       sku: { type: string }
 *                       short_description: { type: string }
 *                       image: { type: string }
 *                       media_type: { type: string }
 *                       tier: { type: string }
 *                       size_dimension: { type: string }
 *                       status: { type: integer }
 *                       price_option_count: { type: integer }
 *                       min_rate: { type: number, nullable: true }
 *                       max_rate: { type: number, nullable: true }
 *                       min_buying_rate: { type: number, nullable: true }
 *                       loss_price_count: { type: integer }
 *                       issue_count: { type: integer }
 *                       error_count: { type: integer }
 *                       problem_codes: { type: string, nullable: true }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 */
router.get('/products', (req, res) => {
  const page = positiveInteger(req.query.page, 1);
  const showAll = req.query.show_all === '1' || req.query.show_all === 'true';
  const pageSize = showAll ? 10000 : Math.min(positiveInteger(req.query.page_size, 24), 100);
  const search = clean(req.query.search);
  const mediaType = clean(req.query.media_type);
  const tier = clean(req.query.tier);
  const problem = clean(req.query.problem);

  const conditions = [];
  const params = {};
  if (search) {
    conditions.push('(p.name LIKE @search OR p.sku LIKE @search OR p.short_description LIKE @search)');
    params.search = `%${search}%`;
  }
  if (mediaType) {
    conditions.push('p.media_type = @mediaType');
    params.mediaType = mediaType;
  }
  if (tier) {
    conditions.push('p.tier LIKE @tier');
    params.tier = `%${tier}%`;
  }
  if (problem === 'clean') {
    conditions.push('NOT EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id = p.id)');
  } else if (Object.hasOwn(PROBLEM_FILTERS, problem)) {
    conditions.push(`EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id = p.id ${PROBLEM_FILTERS[problem]})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortMap = {
    name: 'p.name COLLATE NOCASE ASC',
    newest: 'p.id DESC',
    price_low: 'min_rate IS NULL, min_rate ASC',
    price_high: 'max_rate IS NULL, max_rate DESC',
    source: 'p.sort_order IS NULL, p.sort_order ASC, p.id ASC'
  };
  const orderBy = sortMap[req.query.sort] || sortMap.source;

  const total = db.prepare(`SELECT COUNT(*) AS count FROM products p ${where}`).get(params).count;
  const products = db.prepare(`
    SELECT
      p.id, p.name, p.sku, p.short_description, p.image, p.media_type,
      p.tier, p.size_dimension, p.status, p.sort_order,
      COUNT(po.id) AS price_option_count,
      MIN(COALESCE(po.discounted_rate, po.offer_rate)) AS min_rate,
      MAX(COALESCE(po.discounted_rate, po.offer_rate)) AS max_rate,
      MIN(po.specific_buying_rate) AS min_buying_rate,
      SUM(CASE WHEN po.specific_buying_rate IS NOT NULL AND (
        (po.offer_rate IS NOT NULL AND po.offer_rate < po.specific_buying_rate) OR
        (po.discounted_rate IS NOT NULL AND po.discounted_rate < po.specific_buying_rate)
      ) THEN 1 ELSE 0 END) AS loss_price_count,
      (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id = p.id) AS issue_count,
      (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id = p.id AND qi.severity = 'error') AS error_count,
      (SELECT GROUP_CONCAT(DISTINCT qi.code) FROM data_quality_issues qi WHERE qi.product_id = p.id) AS problem_codes
    FROM products p
    LEFT JOIN price_options po ON po.product_id = p.id AND po.status = 1
    ${where}
    GROUP BY p.id
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  res.json({
    data: products,
    pagination: { page, page_size: showAll ? total : pageSize, total, pages: showAll ? (total ? 1 : 0) : Math.ceil(total / pageSize), show_all: showAll }
  });
});

/**
 * @swagger
 * /api/transit/products/{id}:
 *   get:
 *     summary: Get a transit product
 *     description: >
 *       Includes price options with their units, attributes and pricing options, plus data quality issues.
 *
 *
 *       **Why we use this:** diagnosing one product's issues, or quoting its exact rate card, needs
 *       more detail than the list view gives.
 *
 *
 *       **Who uses it & why:** data-ops drilling into a flagged product, and desk staff checking
 *       exact pricing for one unit.
 *
 *
 *       **How it helps:** returns the full price-option tree and that product's issues in one call.
 *
 *
 *       **Main purpose:** full detail for a single transit product.
 *     tags: [Transit catalog]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: The product.
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       404:
 *         description: Transit product not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/products/:id', (req, res) => {
  const id = positiveInteger(req.params.id, 0);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).json({ error: 'Transit product not found' });

  const priceOptions = db.prepare(`
    SELECT *,
      COALESCE(discounted_rate, offer_rate) AS effective_client_rate,
      CASE WHEN specific_buying_rate IS NULL THEN NULL
        ELSE COALESCE(discounted_rate, offer_rate) - specific_buying_rate END AS effective_margin,
      CASE WHEN specific_buying_rate IS NOT NULL AND (
        (offer_rate IS NOT NULL AND offer_rate < specific_buying_rate) OR
        (discounted_rate IS NOT NULL AND discounted_rate < specific_buying_rate)
      ) THEN 1 ELSE 0 END AS has_loss
    FROM price_options WHERE product_id = ? ORDER BY sort_order IS NULL, sort_order, id
  `).all(id);
  const issues = db.prepare(`
    SELECT * FROM data_quality_issues WHERE product_id = ?
    ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END, source_sheet, source_row, id
  `).all(id);

  const unitStatement = db.prepare('SELECT * FROM price_units WHERE price_option_id = ? ORDER BY sort_order IS NULL, sort_order, id');
  const attributeStatement = db.prepare('SELECT * FROM attributes WHERE price_option_id = ? ORDER BY sort_order IS NULL, sort_order, id');
  const attributeValueStatement = db.prepare('SELECT * FROM attribute_values WHERE attribute_id = ? ORDER BY sort_order IS NULL, sort_order, id');
  const optionStatement = db.prepare('SELECT * FROM pricing_options WHERE price_option_id = ? ORDER BY sort_order IS NULL, sort_order, id');
  const optionValueStatement = db.prepare('SELECT * FROM pricing_option_values WHERE pricing_option_id = ? ORDER BY sort_order IS NULL, sort_order, id');

  for (const priceOption of priceOptions) {
    priceOption.units = unitStatement.all(priceOption.id);
    priceOption.attributes = attributeStatement.all(priceOption.id).map((attribute) => ({
      ...attribute,
      values: attributeValueStatement.all(attribute.id)
    }));
    priceOption.options = optionStatement.all(priceOption.id).map((option) => ({
      ...option,
      values: optionValueStatement.all(option.id)
    }));
  }

  return res.json({ ...product, price_options: priceOptions, issues });
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let string = String(value);
  // Prevent spreadsheet applications from interpreting imported text as a formula.
  if (/^[=+\-@]/.test(string)) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

module.exports = router;
