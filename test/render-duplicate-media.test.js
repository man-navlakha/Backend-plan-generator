const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlanWorkbook, mergeLegsForWorkbook } = require('../src/render');

function autoLine(name, total) {
  return {
    product_name: name,
    tier: 'Tier 1',
    city: 'Ahmedabad',
    state: 'Gujarat',
    qty: 10,
    months: 2,
    price_option: 'Back Panel',
    rate: 1000,
    addon_per_unit: 0,
    net: total / 1.18,
    gst: total - total / 1.18,
    total,
    impressions: null
  };
}

test('duplicate media legs render as one worksheet with every line retained', async () => {
  const legs = [
    { media: 'Auto', scope: 'West Ahmedabad', duration_label: '2 Months', lines: [autoLine('Auto A', 11800)], notes: [] },
    { media: 'AUTO', scope: 'East Ahmedabad', duration_label: '2 Months', lines: [autoLine('Auto B', 23600)], notes: ['Confirm route.'] }
  ];

  const merged = mergeLegsForWorkbook(legs);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lines.length, 2);

  const workbook = await buildPlanWorkbook({
    title: 'Transit Plan',
    client_name: 'FreshKart Foods Pvt. Ltd.',
    budget: 1000000,
    budget_includes_gst: true,
    legs,
    charges: [],
    reserves: [],
    flags: [],
    desk_actions: [],
    guidance: []
  });

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'Summary',
    'Auto',
    'T&C - Auto',
    'Notes (Internal)'
  ]);
  assert.equal(workbook.getWorksheet('Auto').getCell('A7').value, 1);
  assert.equal(workbook.getWorksheet('Auto').getCell('A8').value, 2);
  assert.equal(workbook.getWorksheet('Summary').getCell('B7').value, 'Auto');
});

test('a legacy non-Cinema client-options leg cannot create a second Auto worksheet', async () => {
  const auto = {
    media: 'Auto',
    scope: 'Ahmedabad',
    duration_label: '2 Months',
    lines: [autoLine('Auto A', 11800)],
    notes: []
  };
  const workbook = await buildPlanWorkbook({
    title: 'Transit Plan',
    client_name: 'FreshKart Foods Pvt. Ltd.',
    budget: 1000000,
    budget_includes_gst: true,
    mode: 'costed',
    legs: [auto],
    client_options_legs: [auto],
    charges: [],
    reserves: [],
    flags: [],
    desk_actions: [],
    guidance: []
  });

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'Summary',
    'Auto',
    'T&C - Auto',
    'Notes (Internal)'
  ]);
});
