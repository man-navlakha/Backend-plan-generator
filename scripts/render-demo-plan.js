/**
 * Renders the Awadh Foods brief as a real multi-media workbook.
 *
 * Numbers here are the ones the catalog produced for that brief — this is a
 * fixture for the renderer, not the allocation engine. Once the engine lands it
 * will produce this `plan` object and the renderer will be unchanged.
 *
 *   node scripts/render-demo-plan.js [outPath]
 */

const path = require('path');
const { writePlanWorkbook, planWorkbookBuffer } = require('../src/render');
const { uploadPlan, isConfigured, missingConfig } = require('../src/storage/appwrite');

const GST = 0.18;

function costLine(line) {
  const units = line.qty * (line.months || 1);
  const net = line.rate * units;
  return { ...line, net, gst: net * GST, total: net * (1 + GST) };
}

const busLine = costLine({
  product_name: 'Marco Polo - City - Lucknow',
  sku: 'TRANSITBUS10090',
  state: 'Uttar Pradesh',
  market: 'Lucknow',
  price_option: 'Bus Branding — All 3 Sides (Side + Back), 100 sqft',
  qty: 25,
  months: 2,
  rate: 15000,
  addon_total: null, // printing is not in the master for this option
  minimum_billing: 150000,
  buying_rate: null
});

const autoLine = costLine({
  product_name: 'Auto Branding - Lucknow',
  sku: 'TRANSITAUTO10409',
  state: 'Uttar Pradesh',
  market: 'Lucknow',
  price_option: 'Auto Hood Branding — 20 sqft',
  qty: 250,
  months: 2,
  rate: 700,
  addon_total: null,
  minimum_billing: 10000,
  buying_rate: 650
});

const plan = {
  deal_id: 'DEMO-AWADH-001',
  title: 'Media Plan — Awadh Foods Pvt. Ltd., Lucknow',
  client_name: 'Awadh Foods Pvt. Ltd.',
  client_based_at: 'Lucknow',
  budget: 1500000,
  budget_includes_gst: true,
  gst_rate: 18,
  objective: 'Branding and awareness',
  target_location: 'Lucknow',

  legs: [
    {
      media: 'Bus',
      scope: 'Marco Polo City Bus, Lucknow — All 3 Sides (Side + Back)',
      duration_label: '2 Months',
      lines: [busLine],
      notes: [
        'Panel specification is All 3 Sides (Side + Back). Full body / full wrap is not offered in Lucknow.',
        'Printing & Installation is not held in the master for this option and is quoted separately.',
        'Lucknow carries three city bus options at 15,000 / 4,200 / 1,800 for the same 100 sqft spec. Rate confirmed with the desk before issue.'
      ]
    },
    {
      media: 'Auto',
      scope: 'Auto Hood Branding, Lucknow — 20 sqft',
      duration_label: '2 Months',
      lines: [autoLine],
      notes: [
        'Auto is quoted at the offer rate of 700. The discounted rate of 630 sits below the buying rate of 650 and is not used.',
        'The auto master carries no month unit. The rate is treated as per auto per month; confirm before issue.',
        'Quantity floor for auto hood branding is 200 units.'
      ]
    }
  ],

  reserves: [
    { label: 'Printing & mounting — approx 7,500 sqft, to be quoted by the desk', amount: 202000 }
  ],

  flags: [
    { severity: 'block', id: 'bus.full_wrap_availability',
      message: 'Brief asked for full body. Lucknow offers no full wrap option; All 3 Sides (Side + Back) is the closest available and needs client approval.',
      source: 'Media Type attribute across Lucknow bus products' },
    { severity: 'block', id: 'global.printing_not_in_master',
      message: 'Printing and mounting is not priced. Approx 7,500 sqft across 25 buses and 250 autos. Reserve of 202,000 covers it only at 27/sqft or below.',
      source: 'pricing_option_values empty on all four Lucknow options' },
    { severity: 'block', id: 'auto.no_month_unit',
      message: 'Auto has no month unit in the master. A 2-month auto campaign cannot be priced without a stated convention.',
      source: '0 of 1453 auto price options carry a Month unit' },
    { severity: 'warn', id: 'bus.rate_spread',
      message: 'Lucknow bus rates differ 8.3x for identical spec: 15,000 / 4,200 / 1,800, all 100 sqft All 3 Sides.',
      source: 'price_options for Lucknow bus products' },
    { severity: 'warn', id: 'global.margin_unknown',
      message: 'Bus buying rate is NULL. Margin cannot be verified on the largest line in the plan.',
      source: 'data_quality_issues.MISSING_BUYING_RATE' }
  ],

  desk_actions: [
    'Confirm which of the three Lucknow city bus rates is correct.',
    'Price printing and mounting for approx 7,500 sqft.',
    'Confirm the auto rate is per auto per month.',
    'Obtain the bus buying rate so margin can be checked.',
    'Get client approval for All 3 Sides in place of full body.'
  ],

  guidance: [
    'Outdoor works on repeat exposure. Two months is a sound minimum.',
    'Bus gives scale on main corridors; auto gives depth into residential and market areas.',
    'Bus and auto need separate artwork — 100 sqft across three panels vs 20 sqft on a hood. One design will not scale to both.',
    'Printing and mounting is a separate cost, roughly 15 percent of this budget.',
    'Deliverable proof is execution photographs, not impression or footfall figures.'
  ]
};

const args = process.argv.slice(2);
const upload = args.includes('--upload');
const out = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'output', 'awadh-foods-plan.xlsx');

(async () => {
  const file = await writePlanWorkbook(plan, out);
  const net = plan.legs.flatMap((l) => l.lines).reduce((a, l) => a + l.net, 0);
  console.log(`wrote ${file}`);
  console.log(`  legs      ${plan.legs.length} (${plan.legs.map((l) => l.media).join(' + ')})`);
  console.log(`  net       ${net.toLocaleString('en-IN')}`);
  console.log(`  gst       ${(net * GST).toLocaleString('en-IN')}`);
  console.log(`  total     ${(net * 1.18).toLocaleString('en-IN')}`);
  console.log(`  reserve   ${plan.reserves[0].amount.toLocaleString('en-IN')}`);
  console.log(`  budget    ${plan.budget.toLocaleString('en-IN')} (incl GST)`);

  if (!upload) return;

  if (!isConfigured()) {
    throw new Error(`--upload needs Appwrite credentials. Missing: ${missingConfig().join(', ')}`);
  }
  const stored = await uploadPlan(await planWorkbookBuffer(plan), { plan });
  console.log(`\nuploaded to Appwrite bucket ${stored.bucketId}`);
  console.log(`  file      ${stored.name} (${stored.fileId})`);
  console.log(`  size      ${(stored.size / 1024).toFixed(1)} KB`);
  console.log(`  download  ${stored.downloadUrl}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
