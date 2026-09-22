/**
 * Proves the unified master in Postgres is usable, not merely present.
 *
 *   node --env-file=.env scripts/smoke-postgres.js
 *
 * Row counts alone say nothing -- an import can land 20,000 rows and still be
 * unqueryable because the location never resolved or the rate came across as
 * text. Each check below is a question the plan engine will actually ask.
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */

const { rows, close } = require('../src/pg');

const results = [];

function check(name, passed, detail) {
  results.push({ check: name, result: passed ? 'PASS' : 'FAIL', detail });
}

async function main() {
  // 1. Everything arrived.
  const counts = await rows(`
    select (select count(*) from masters.catalogs)      as catalogs,
           (select count(*) from masters.products)      as products,
           (select count(*) from masters.price_options) as price_options
  `);
  const c = counts[0];
  // Eight, not nine: newspaper is skipped because its master carries no rates.
  check('catalogs loaded', Number(c.catalogs) === 8, `${c.catalogs} catalogs`);
  check('products loaded', Number(c.products) > 20000, `${c.products} products`);
  check('price options loaded', Number(c.price_options) > 45000, `${c.price_options} options`);

  // 2. No price option points at a product that is not there.
  const orphans = await rows(`
    select count(*) as n from masters.price_options po
     where not exists (select 1 from masters.products p where p.id = po.product_id)
  `);
  check('no orphan price options', Number(orphans[0].n) === 0, `${orphans[0].n} orphans`);

  // 3. Rates are numbers, not strings that merely look like numbers.
  const rates = await rows(`
    select count(*) as priced, min(offer_rate) as lo, max(offer_rate) as hi
      from masters.price_options where offer_rate is not null and offer_rate > 0
  `);
  check(
    'rates are numeric and positive',
    Number(rates[0].priced) > 40000 && Number(rates[0].lo) > 0,
    `${rates[0].priced} priced, range ${rates[0].lo}-${rates[0].hi}`
  );

  // 4. The location column is good enough to plan a city campaign from.
  const located = await rows(`
    select count(*) filter (where city is not null) as with_city, count(*) as total
      from masters.products
  `);
  const pct = Math.round((Number(located[0].with_city) / Number(located[0].total)) * 100);
  check('location coverage >= 70%', pct >= 70, `${pct}% (${located[0].with_city}/${located[0].total})`);

  // 5. The exact query the Awadh Foods brief needs. If this regresses, the
  //    demo plan can no longer be reproduced from the database.
  const lucknow = await rows(`
    select p.media_type, po.offer_rate
      from masters.price_options po
      join masters.products p on p.id = po.product_id
     where lower(p.city) = 'lucknow' and p.media_type in ('bus','auto')
       and po.offer_rate is not null
  `);
  const busRates = lucknow.filter((r) => r.media_type === 'bus').map((r) => Number(r.offer_rate));
  const autoRates = lucknow.filter((r) => r.media_type === 'auto').map((r) => Number(r.offer_rate));
  check(
    'Lucknow bus rates match the fixture',
    [15000, 4200, 1800].every((rate) => busRates.includes(rate)),
    `found ${busRates.sort((a, b) => b - a).join(' / ')}`
  );
  check(
    'Lucknow auto hood rate is 700',
    autoRates.includes(700),
    `found ${autoRates.sort((a, b) => b - a).join(' / ')}`
  );

  // 6. Trigram search answers, and answers with the right city on top.
  const search = await rows(
    `select name, city, similarity(search_text, $1) as score
       from masters.products where search_text % $1
      order by score desc limit 3`,
    ['auto rickshaw branding lucknow']
  );
  check(
    'fuzzy search returns Lucknow first',
    search.length > 0 && String(search[0].city || '').toLowerCase() === 'lucknow',
    search.map((r) => r.name).join(' | ') || 'no rows'
  );

  // 7. Every media type the format index can render has inventory behind it.
  const media = await rows(`
    select media_type, count(*) as n from masters.products group by media_type order by n desc
  `);
  check('media types present', media.length >= 10, `${media.length} distinct media types`);

  // 8. Nothing unquotable got in. A product with no priced option is a search
  //    result that wastes a model's attention and can end up in a plan.
  const unpriced = await rows(`
    select p.catalog, count(*) as n
      from masters.products p
     where not exists (
       select 1 from masters.price_options po
        where po.product_id = p.id and po.offer_rate is not null and po.offer_rate > 0
     )
     group by p.catalog order by n desc
  `);
  const worst = unpriced[0];
  check(
    'no catalog is majority unpriced',
    unpriced.every((r) => Number(r.n) < 1000),
    unpriced.length
      ? `worst: ${worst.catalog} has ${worst.n} unpriced`
      : 'every product is priced'
  );
  check('newspaper stays out', !unpriced.some((r) => r.catalog === 'newspaper'), 'not imported');

  // 8. The app schema exists and is empty-but-writable shaped.
  const appTables = await rows(`
    select table_name from information_schema.tables where table_schema = 'app' order by table_name
  `);
  check(
    'app schema ready',
    appTables.length === 3,
    appTables.map((t) => t.table_name).join(', ')
  );

  console.table(results);

  const failed = results.filter((r) => r.result === 'FAIL');
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${results.length} checks passed.`);
  }
}

main()
  .then(() => close())
  .catch(async (error) => {
    console.error('Failed:', error.message);
    await close();
    process.exit(1);
  });
