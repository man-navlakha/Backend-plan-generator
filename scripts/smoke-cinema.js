/**
 * Proves the combined PAN-India Cinema catalog is loaded, priced
 * right, and has not quietly lost or duplicated inventory.
 *
 *   node --env-file=.env scripts/smoke-cinema.js
 *
 * The catalog is built from two workbooks that overlap, disagree on rates, and each
 * have gaps the other fills. Each of the following is a way that could be wrong
 * without looking wrong:
 *
 *   1. Identity. Every Cinema brief and catalog row uses the single `cinema` name.
 *   2. The rate basis. offer_rate is per second per week; both workbooks print a per
 *      ten seconds per week figure. Drop the division and every plan overcharges 10x.
 *   3. No screen is quotable twice. Where a screen is in both workbooks the older row
 *      must be retained but non-quotable, or a plan can bill one audi at two prices.
 *   4. Nothing was dropped. Every row of both workbooks is present, including the
 *      incomplete ones -- that is the point of the findings register.
 *   5. The client sheet. All 17 columns must resolve from the catalog.
 */

const assert = require('node:assert/strict');
const { rows, one, close } = require('../src/pg');
const { catalogSlugsFor } = require('../src/catalog/media-map');
const { searchProducts } = require('../src/catalog/search');
const { costLine } = require('../src/engine/cost');
const { resolveField } = require('../src/render/resolvers');
const { loadSpec } = require('../src/render');
const { loadRules } = require('../src/rules');

const CATALOG = 'cinema';
const MEDIA = 'cinema';
const SOURCES = ['pan_india_2025', 'from_csvs_2026'];

/** The 17 columns the Cinema client template prints, in sheet order. */
const SHEET_FIELDS = [
  'sr', 'state', 'city', 'screen_code', 'locality', 'pincode', 'theatre_type',
  'multiplex_name', 'address', 'tier', 'capacity_preference', 'total_screen',
  'audi_no', 'audi_type', 'cinema_chain', 'seating_capacity', 'cinema_weekly_rate'
];

async function main() {
  // ── the catalog is there, and matches what the import recorded ────────
  const catalog = await one('select * from masters.catalogs where slug=$1', [CATALOG]);
  assert.ok(catalog, `catalog ${CATALOG} is not loaded — run npm run db:import:cinema`);
  assert.equal(catalog.family, 'cinema');
  const recorded = catalog.row_counts;

  const counts = await one(`
    select count(*)::int products,
           count(*) filter (where status = 1)::int quotable,
           count(*) filter (where status = 0)::int superseded,
           count(*) filter (where city is null)::int no_city,
           count(*) filter (where zone is null)::int no_zone,
           count(distinct state)::int states,
           count(distinct attrs->>'venue_key')::int venues
      from masters.products where catalog=$1
  `, [CATALOG]);

  assert.equal(counts.products, Number(recorded.products), 'row count differs from the import');
  assert.equal(counts.quotable, Number(recorded.quotable));
  assert.equal(counts.superseded, Number(recorded.superseded));
  assert.equal(counts.no_city, 0, 'every screen should carry a city');
  assert.equal(counts.no_zone, 0, 'every screen should resolve to a zone');

  // Nothing dropped: both workbooks are present in full.
  const bySource = await rows(`
    select attrs->>'source_file' source, count(*)::int rows
      from masters.products where catalog=$1 group by 1 order by 1
  `, [CATALOG]);
  const sourceRows = Object.fromEntries(bySource.map((r) => [r.source, r.rows]));
  for (const key of SOURCES) {
    assert.equal(sourceRows[key], Number(recorded.sources[key]),
      `${key}: rows in the database differ from rows read out of its workbook`);
  }
  assert.equal(
    Object.values(sourceRows).reduce((a, b) => a + b, 0), counts.products,
    'every row must be attributed to one of the two workbooks'
  );

  const optionCounts = await one(`
    select count(*)::int options,
           count(*) filter (where status = 1 and (offer_rate is null or offer_rate <= 0))::int unpriced_quotable,
           count(distinct pricing_unit)::int units,
           count(*) filter (where product_id not in
             (select id from masters.products where catalog=$1))::int orphans
      from masters.price_options where catalog=$1
  `, [CATALOG]);
  assert.equal(optionCounts.options, counts.products, 'one option per screen row');
  assert.equal(optionCounts.orphans, 0, 'no option may point at a missing product');
  assert.equal(optionCounts.units, 1, 'both cards use a single rate basis');

  // ── isolation: a Cinema brief must not reach this catalog ─────────────
  assert.deepEqual(catalogSlugsFor('Cinema'), ['cinema'],
    'a Cinema brief must resolve to the Cinema catalog');
  assert.deepEqual(catalogSlugsFor('cinema'), ['cinema']);
  const wrongMediaType = await one(
    "select count(*)::int n from masters.products where media_type<>'cinema' and catalog=$1",
    [CATALOG]
  );
  assert.equal(wrongMediaType.n, 0, 'every row of this catalog must use media_type cinema');

  // ── no screen is quotable twice ───────────────────────────────────────
  const doubled = await one(`
    select count(*)::int n from (
      select attrs->>'screen_code' code
        from masters.products
       where catalog=$1 and status=1 and attrs->>'linked_screen_code' is not null
       group by 1 having count(*) > 1
    ) x
  `, [CATALOG]);
  assert.equal(doubled.n, 0, 'a linked screen must be quotable from one workbook only');

  const supersededStillLinked = await one(`
    select count(*)::int n from masters.products
     where catalog=$1 and status=0 and attrs->>'superseded' is null
  `, [CATALOG]);
  assert.equal(supersededStillLinked.n, 0,
    'every non-quotable row should say why it is non-quotable');

  // A superseded row must never come back from a search.
  const supersededSample = await rows(`
    select p.city, attrs->>'screen_code' code from masters.products p
     where catalog=$1 and status=0 and city is not null limit 1
  `, [CATALOG]);
  if (supersededSample.length) {
    const hits = await searchProducts({
      mediaType: MEDIA, q: supersededSample[0].code, limit: 50, pricedOnly: false
    });
    assert.ok(
      !hits.some((h) => h.attrs?.superseded),
      'a superseded screen came back from searchProducts'
    );
  }

  // ── the format and rules a plan off this catalog would use ────────────
  const spec = loadSpec(MEDIA);
  assert.equal(spec.spec.layout, 'cinema_pan_india_2025');
  const rules = loadRules(MEDIA);
  assert.equal(rules.key, 'cinema');
  assert.equal(rules.billing.default_activity_seconds, 10);
  assert.equal(rules.billing.gst_rate, 18);

  // ── the rate basis, on both workbooks ─────────────────────────────────
  for (const source of SOURCES) {
    const basis = await rows(`
      select p.sku, (p.attrs->>'rate_10s_week')::numeric printed, po.offer_rate per_second
        from masters.products p
        join masters.price_options po on po.product_id = p.id
       where p.catalog=$1 and p.attrs->>'source_file'=$2 and po.offer_rate > 0
       order by p.id limit 400
    `, [CATALOG, source]);
    assert.ok(basis.length > 0, `${source}: no priced rows to check`);
    for (const row of basis) {
      const expected = Math.round((Number(row.printed) / 10) * 100) / 100;
      assert.equal(Number(row.per_second), expected,
        `${source} ${row.sku}: offer_rate must be the printed 10-second rate / 10`);
    }
  }

  // ── a costed line reproduces its source row exactly ───────────────────
  const found = await searchProducts({ mediaType: MEDIA, city: 'Lucknow', limit: 1 });
  assert.equal(found.length, 1, 'expected Lucknow inventory in this catalog');
  const product = found[0];
  const option = product.price_options[0];
  assert.ok(option, 'the product came back without its price option');

  const line = costLine(option, { qty: 10, months: 4, product });
  assert.ok(!line.error, `costing failed: ${line.message}`);

  const printed = Number(product.attrs.rate_10s_week);
  assert.equal(line.net, printed * 4,
    'a four-week buy must cost four times the printed weekly rate');

  const rendered = {};
  for (const field of SHEET_FIELDS) {
    rendered[field] = resolveField(field, { ...line }, { index: 0, leg: {} });
  }
  assert.equal(Number(rendered.cinema_weekly_rate), printed,
    'the sheet must print the rate the workbook printed');
  for (const field of SHEET_FIELDS) {
    assert.ok(rendered[field] !== null && rendered[field] !== undefined,
      `client sheet column "${field}" resolved to nothing`);
  }

  // ── the repair register ───────────────────────────────────────────────
  const findings = await rows(`
    select severity, code, count(*)::int n
      from masters.data_quality_issues where catalog=$1
     group by 1,2 order by n desc
  `, [CATALOG]);
  assert.equal(
    findings.reduce((n, f) => n + f.n, 0), Number(recorded.issues),
    'findings in the database differ from the import'
  );

  const gaps = await rows(`
    select field, count(*)::int screens
      from masters.data_quality_issues
     where catalog=$1 and code like 'MISSING_%'
     group by 1 order by 2 desc
  `, [CATALOG]);

  console.log(`Cinema catalog OK: ${catalog.label}`);
  console.log(`  workbooks  ${catalog.workbook}`);
  console.log(`  imported   ${catalog.imported_at.toISOString()}`);
  console.table([{
    screens: counts.products,
    quotable: counts.quotable,
    superseded: counts.superseded,
    venues: counts.venues,
    states: counts.states,
    unpriced_quotable: optionCounts.unpriced_quotable
  }]);
  console.log('  rows per workbook:');
  console.table(bySource);
  console.log(`  rate basis verified on both workbooks `
    + `(printed 10-second weekly rate / 10 = offer_rate per second per week)`);
  console.log(`  ${SHEET_FIELDS.length}/17 client-sheet columns resolved from the catalog`);
  console.log(`  linked screens: ${recorded.linked}; blank fields filled across the link: `
    + `${recorded.filled_fields}`);
  console.log('  missing fields still to fix:');
  console.table(gaps);
  console.log('  findings:');
  console.table(findings);
}

main()
  .then(() => close())
  .catch(async (error) => {
    console.error('\nFailed:', error.message);
    await close();
    process.exit(1);
  });
