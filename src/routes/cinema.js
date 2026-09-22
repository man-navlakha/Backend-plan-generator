const express = require('express');
const { db } = require('../cinema-db');

const router = express.Router();
const FILTERS = {
  any: '', error: "AND qi.severity='error'", warning: "AND qi.severity='warning'",
  margin: "AND qi.code='SELLING_BELOW_BUYING'",
  image: "AND qi.code IN ('PRODUCT_IMAGE_NOT_FOUND','PRICE_IMAGE_NOT_FOUND')",
  location: "AND qi.code='MISSING_CITY'",
  pricing: "AND qi.code IN ('INVALID_OFFER_RATE','MISSING_BUYING_RATE','SELLING_BELOW_BUYING','DISCOUNT_ABOVE_OFFER','INVALID_MINIMUM_BILLING','MISSING_PRICE_UNITS','RATE_SOURCE_MISMATCH')",
  screens: "AND qi.code IN ('INVALID_SCREEN_COUNT','RECOMMENDED_SCREENS_EXCEED_TOTAL','INVALID_SEATS')",
  source: "AND qi.code IN ('RATE_SOURCE_MISMATCH','UNLINKED_RATE_SOURCE')"
};

router.get('/stats', (_req, res) => {
  const totals = db.prepare(`SELECT
    (SELECT COUNT(*) FROM products) products,
    (SELECT COUNT(*) FROM price_options) price_options,
    (SELECT COUNT(*) FROM price_units) price_units,
    (SELECT COUNT(DISTINCT cinema_chain) FROM products) chain_count,
    (SELECT COUNT(*) FROM data_quality_issues) issues,
    (SELECT COUNT(DISTINCT product_id) FROM data_quality_issues WHERE product_id IS NOT NULL) affected_products`).get();
  const chains = db.prepare(`SELECT cinema_chain name,COUNT(*) count FROM products
    WHERE cinema_chain IS NOT NULL GROUP BY cinema_chain ORDER BY count DESC,name`).all();
  const imported = db.prepare("SELECT value FROM import_metadata WHERE key='imported_at'").get();
  res.json({ ...totals, chains, imported_at: imported?.value || null });
});

router.get('/filters', (_req, res) => {
  const values = (field, table) => db.prepare(`SELECT DISTINCT ${field} value FROM ${table}
    WHERE ${field} IS NOT NULL AND ${field}<>'' ORDER BY ${field}`).all().map((row) => row.value);
  res.json({ chains: values('cinema_chain', 'products'), tiers: values('tier', 'products'),
    cities: values('city', 'locations'), zones: values('zone', 'locations') });
});

router.get('/problems/summary', (_req, res) => {
  const totals = db.prepare(`SELECT COUNT(*) issues,COUNT(DISTINCT product_id) affected_products,
    SUM(severity='error') errors,SUM(severity='warning') warnings FROM data_quality_issues`).get();
  const byCode = db.prepare(`SELECT code,severity,COUNT(*) count,COUNT(DISTINCT product_id) affected_products
    FROM data_quality_issues GROUP BY code,severity ORDER BY count DESC,code`).all();
  res.json({ ...totals, by_code: byCode });
});

router.get('/problems.csv', (_req, res) => {
  const columns = ['issue_id','severity','problem_code','entity_type','source_sheet','source_row',
    'product_name','product_sku','chain','city','price_option_name','price_option_sku',
    'field','current_value','suggested_value','message'];
  const issues = db.prepare(`SELECT qi.id issue_id,qi.severity,qi.code problem_code,qi.entity_type,
    qi.source_sheet,qi.source_row,p.name product_name,p.sku product_sku,p.cinema_chain chain,
    l.city,po.name price_option_name,po.sku price_option_sku,qi.field,qi.current_value,
    qi.suggested_value,qi.message FROM data_quality_issues qi
    LEFT JOIN products p ON p.id=qi.product_id
    LEFT JOIN locations l ON l.product_id=p.id
    LEFT JOIN price_options po ON po.id=qi.price_option_id
    ORDER BY CASE qi.severity WHEN 'error' THEN 0 ELSE 1 END,qi.source_sheet,qi.source_row`).all();
  const csv = [columns, ...issues.map((issue) => columns.map((name) => issue[name]))]
    .map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="cinema-master-problems.csv"');
  res.send(`\uFEFF${csv}`);
});

router.get('/products', (req, res) => {
  const params = {};
  const conditions = [];
  const filters = [
    ['chain','p.cinema_chain = @chain'],['city','l.city = @city'],
    ['zone','l.zone = @zone'],['tier','p.tier = @tier']
  ];
  for (const [key, condition] of filters) {
    const input = clean(req.query[key]);
    if (input) { conditions.push(condition); params[key] = input; }
  }
  const search = clean(req.query.search);
  if (search) {
    conditions.push('(p.name LIKE @search OR p.sku LIKE @search OR p.cinema_chain LIKE @search OR l.city LIKE @search OR l.locality LIKE @search)');
    params.search = `%${search}%`;
  }
  const problem = clean(req.query.problem);
  if (problem === 'clean') conditions.push('NOT EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id)');
  else if (Object.hasOwn(FILTERS, problem)) conditions.push(`EXISTS (SELECT 1 FROM data_quality_issues qi WHERE qi.product_id=p.id ${FILTERS[problem]})`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orders = {
    source: 'p.sort_order IS NULL,p.sort_order,p.id', name: 'p.name COLLATE NOCASE,p.id',
    price_low: 'min_rate IS NULL,min_rate,p.id', price_high: 'max_rate IS NULL,max_rate DESC,p.id',
    seats: 'p.seats IS NULL,p.seats DESC,p.id', screens: 'p.total_screen IS NULL,p.total_screen DESC,p.id'
  };
  const order = orders[req.query.sort] || orders.source;
  const data = db.prepare(`SELECT p.id,p.name,p.sku,p.description,p.image,p.cinema_chain,p.tier,
    p.audience_class,p.seats,p.screen_recommend,p.total_screen,p.rank,l.city,l.state,l.zone,l.locality,
    COUNT(po.id) price_option_count,MIN(COALESCE(po.discounted_rate,po.offer_rate)) min_rate,
    MAX(COALESCE(po.discounted_rate,po.offer_rate)) max_rate,MIN(po.buying_rate) min_buying_rate,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id) issue_count,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.severity='error') error_count,
    (SELECT COUNT(*) FROM data_quality_issues qi WHERE qi.product_id=p.id AND qi.code='SELLING_BELOW_BUYING') loss_price_count
    FROM products p LEFT JOIN locations l ON l.product_id=p.id
    LEFT JOIN price_options po ON po.product_id=p.id
    ${where} GROUP BY p.id ORDER BY ${order} LIMIT 10000`).all(params);
  res.json({ data, pagination: { page: 1, page_size: data.length, total: data.length,
    pages: data.length ? 1 : 0, show_all: true } });
});

router.get('/products/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Cinema product not found' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!product) return res.status(404).json({ error: 'Cinema product not found' });
  product.locations = db.prepare('SELECT * FROM locations WHERE product_id=? ORDER BY id').all(id);
  product.issues = db.prepare(`SELECT * FROM data_quality_issues WHERE product_id=?
    ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END,source_sheet,source_row,id`).all(id);
  product.price_options = db.prepare(`SELECT *,COALESCE(discounted_rate,offer_rate) effective_client_rate,
    CASE WHEN buying_rate IS NULL THEN NULL ELSE COALESCE(discounted_rate,offer_rate)-buying_rate END effective_margin,
    CASE WHEN buying_rate IS NOT NULL AND ((offer_rate IS NOT NULL AND offer_rate<buying_rate)
      OR (discounted_rate IS NOT NULL AND discounted_rate<buying_rate)) THEN 1 ELSE 0 END has_loss
    FROM price_options WHERE product_id=? ORDER BY sort_order IS NULL,sort_order,id`).all(id);
  const units = db.prepare('SELECT * FROM price_units WHERE price_option_id=? ORDER BY sort_order,id');
  const source = db.prepare('SELECT * FROM offer_rate_sources WHERE price_option_id=? ORDER BY id');
  for (const option of product.price_options) {
    option.units = units.all(option.id);
    option.rate_sources = source.all(option.id);
  }
  res.json(product);
});

function clean(value) { return typeof value === 'string' ? value.trim().slice(0, 120) : ''; }
function csvCell(value) {
  if (value == null) return '';
  let string = String(value);
  if (/^[=+\-@]/.test(string)) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}
module.exports = router;
