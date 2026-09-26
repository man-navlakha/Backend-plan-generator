const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPlan,
  requestedMagazinePublications,
  ensureRequestedMagazineRows
} = require('../src/engine/build');

test('requested Magazine publications are normalized and deduplicated', () => {
  assert.deepEqual(
    requestedMagazinePublications({
      service: 'Magazine',
      requested_publications: ['Good Homes', "India Today Home's", 'good homes']
    }),
    ['Good Homes', 'India Today Home']
  );
});

test('requested titles omitted by selection are added and missing catalog titles remain visible', () => {
  const legs = [{
    media: 'Magazine',
    scope: 'Good Homes',
    duration_label: '1 Month',
    lines: [{ product_name: 'Good Homes', Position: 'Full Page', rate: 200000, net: 200000 }],
    notes: []
  }];
  const flags = [];
  const deskActions = [];
  const prefetch = {
    candidates: [{
      id: 22,
      name: 'Forbes India',
      sku: 'MAG-FORBES',
      media_type: 'magazine',
      attrs: { Circulation: 75000, Frequency: 'Fortnightly' },
      price_options: [{
        id: 33,
        name: 'Magazine Advertising - Full Page',
        sku: 'MAG-FORBES-FP',
        offer_rate: 350000,
        discounted_rate: 332500,
        buying_rate: 262500,
        pricing_unit: 'per Insertion',
        gst: 18,
        attrs: { Position: 'Full Page' },
        status: 1,
        units: []
      }]
    }]
  };

  const missing = ensureRequestedMagazineRows(
    legs,
    {
      service: 'Magazine',
      requested_publications: ['Good Homes', 'Forbes India', 'India Today Home']
    },
    prefetch,
    flags,
    deskActions,
    true
  );

  assert.deepEqual(missing, ['India Today Home']);
  assert.deepEqual(
    legs[0].lines.map((line) => line.publication || line.product_name),
    ['Good Homes', 'Forbes India', 'India Today Home']
  );
  assert.equal(legs[0].lines[1].page_position, 'Inside Page');
  assert.equal(legs[0].lines[1].Circulation, 75000);
  assert.equal(legs[0].lines[2].ad_size, 'Full Page');
  assert.equal(legs[0].lines[2].page_position, 'Inside Page');
  assert.equal(legs[0].lines[2].rate, null);
  assert.equal(flags[0].severity, 'warn');
  assert.match(flags[0].message, /India Today Home/);
  assert.match(deskActions[0], /India Today Home/);
});

test('a requested Magazine title still produces a visible row when prefetch has no exact inventory', async () => {
  const result = await buildPlan({
    deal_id: '18468',
    company: 'Wurfel Kuche',
    service: 'Magazine',
    budget: null,
    target_locations: ['Delhi'],
    requested_publications: ['India Today Home']
  }, {
    strategy: 'deterministic',
    prefetch: {
      candidates: [],
      notes: ['No exact title in current master.'],
      stats: { products: 0, price_options: 0, truncated: false }
    }
  });

  assert.ok(result.plan);
  assert.equal(result.plan.mode, 'inventory');
  assert.equal(result.plan.legs[0].lines[0].publication, 'India Today Home');
  assert.equal(result.plan.legs[0].lines[0].page_position, 'Inside Page');
  assert.equal(result.plan.legs[0].lines[0].rate, null);
  assert.equal(result.flags[0].id, 'magazine.requested_publication_missing_catalog');
});
