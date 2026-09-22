/**
 * Runs the search and prefetch layer against real briefs and prints what the
 * model would be handed.
 *
 *   node --env-file=.env scripts/try-prefetch.js
 *   node --env-file=.env scripts/try-prefetch.js --json    full payload
 *
 * The point is the size and the gaps, not just the hits: if the shortlist for a
 * normal brief is 40k tokens, or if it silently returns nothing for a city the
 * client asked for, that has to be visible before a model is wired to it.
 */

const { searchProducts, listMediaTypes } = require('../src/catalog/search');
const { prefetchForBrief } = require('../src/catalog/prefetch');
const { close } = require('../src/pg');

const AS_JSON = process.argv.includes('--json');

const BRIEFS = [
  {
    label: 'Awadh Foods (the demo plan brief)',
    deal_id: 'DEMO-AWADH-001',
    company: 'Awadh Foods Pvt. Ltd.',
    service: 'Transit',
    budget: 1_500_000,
    target_locations: ['Lucknow']
  },
  {
    label: 'Single medium, two cities',
    service: 'Bus',
    budget: 800_000,
    target_locations: ['Mumbai', 'Pune']
  },
  {
    label: 'Radio, one city',
    service: 'Radio',
    budget: 500_000,
    target_locations: ['Ahmedabad']
  },
  {
    label: 'Cinema, city with deep inventory',
    service: 'Cinema',
    budget: 2_000_000,
    target_locations: ['Delhi']
  },
  {
    label: 'BTL media the format index never knew about',
    service: 'atm_branding',
    budget: 400_000,
    target_locations: ['Chennai']
  },
  {
    label: 'City that carries nothing for this medium',
    service: 'Bus',
    budget: 300_000,
    target_locations: ['Gangtok']
  },
  {
    // Newspaper is no longer imported -- its master has no rates. A brief can
    // still ask for it, so the answer has to be a clear "nothing here" rather
    // than an empty list that reads like a query failure.
    label: 'Newspaper - a medium the catalog does not carry',
    service: 'Newspaper',
    budget: 600_000,
    target_locations: ['Rajkot']
  }
];

function rupees(n) {
  return n === null || n === undefined ? '-' : Number(n).toLocaleString('en-IN');
}

async function main() {
  console.log('='.repeat(78));
  console.log('SEARCH');
  console.log('='.repeat(78));

  const searches = [
    { label: 'exact-ish phrase + city', args: { q: 'auto branding', city: 'Lucknow' } },
    { label: 'typo, no filters', args: { q: 'cinma screen mumbai', limit: 4 } },
    { label: 'media + budget ceiling', args: { mediaType: 'bus', maxRate: 5000, limit: 4 } },
    { label: 'plain city sweep', args: { city: 'Lucknow', limit: 5 } }
  ];

  for (const s of searches) {
    const found = await searchProducts(s.args);
    console.log(`\n- ${s.label}  ${JSON.stringify(s.args)}`);
    if (found.length === 0) {
      console.log('    (nothing)');
      continue;
    }
    console.table(
      found.slice(0, 5).map((p) => ({
        name: p.name.slice(0, 44),
        media: p.media_type,
        city: p.city || '-',
        score: Number(p.score).toFixed(2),
        options: p.price_options.length,
        cheapest: rupees(p.price_options[0]?.offer_rate)
      }))
    );
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('PREFETCH');
  console.log('='.repeat(78));

  for (const brief of BRIEFS) {
    const started = Date.now();
    const result = await prefetchForBrief(brief);
    const ms = Date.now() - started;

    console.log(`\n${'-'.repeat(78)}`);
    console.log(`${brief.label}`);
    console.log(
      `  service="${brief.service}"  budget=${rupees(brief.budget)}  ` +
        `locations=[${(brief.target_locations || []).join(', ')}]`
    );
    console.log(
      `  -> ${result.stats.products} products, ${result.stats.price_options} price options, ` +
        `${ms}ms${result.stats.truncated ? ' (truncated)' : ''}`
    );

    if (result.locations.length) {
      console.log(
        `  locations resolved: ` +
          result.locations
            .map((l) => `${l.requested || 'any'}=${l.match}${l.state ? ` (${l.state})` : ''}`)
            .join(', ')
      );
    }

    if (result.candidates.length) {
      console.table(
        result.candidates.slice(0, 6).map((p) => ({
          product: p.name.slice(0, 40),
          media: p.media_type,
          city: p.city || '-',
          opts: p.price_options.length,
          from: rupees(p.price_options[0]?.offer_rate),
          unit: p.price_options[0]?.pricing_unit || '-',
          min_bill: rupees(p.price_options[0]?.minimum_billing)
        }))
      );
      if (result.candidates.length > 6) {
        console.log(`  ... ${result.candidates.length - 6} more`);
      }
    }

    for (const note of result.notes) console.log(`  ! ${note}`);

    const payloadKb = Buffer.byteLength(JSON.stringify(result.candidates)) / 1024;
    console.log(`  shortlist size: ${payloadKb.toFixed(1)} KB  (~${Math.round((payloadKb * 1024) / 4)} tokens)`);

    if (AS_JSON) console.log(JSON.stringify(result, null, 2));
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('MEDIA TYPES WITH PRICED INVENTORY');
  console.log('='.repeat(78));
  const media = await listMediaTypes();
  console.table(
    media.slice(0, 12).map((m) => ({
      media_type: m.media_type,
      family: m.family,
      products: m.products,
      cities: m.cities,
      options: m.priced_options,
      from: rupees(m.from_rate),
      to: rupees(m.to_rate)
    }))
  );
  console.log(`(${media.length} media types in total)`);
}

main()
  .then(() => close())
  .catch(async (error) => {
    console.error('Failed:', error.message);
    console.error(error.stack);
    await close();
    process.exit(1);
  });
