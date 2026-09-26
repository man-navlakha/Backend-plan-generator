const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { costLine } = require('../src/engine/cost');
const {
  billingPeriods,
  billingQuantity,
  buildCharges,
  buildCompleteCinemaLeg,
  requestedCinemaCreative
} = require('../src/engine/build');
const { buildPlanWorkbook } = require('../src/render');
const { planMode } = require('../src/engine/mode');
const { selectBalancedCinema } = require('../src/engine/select');
const { loadRules } = require('../src/rules');
const { applyConstraints } = require('../src/rules/evaluate');

function cinemaLine() {
  return costLine(
    {
      id: 30002243,
      sku: 'CINEMA000239SCREEN-5ADFILM',
      name: 'SCREEN-5ADFILM',
      discounted_rate: 145,
      buying_rate: 130,
      minimum_billing: 10000,
      pricing_unit: 'per week per second',
      gst: 18,
      attrs: {}
    },
    {
      qty: 20,
      months: 4,
      product: {
        id: 30000239,
        sku: 'CINEMA000239',
        name: 'Pvr Ahmedabad-Acropolis, Ahmedabad, Gujarat',
        description: 'Located on Pvr Ahmedabad-Acropolis, Ahmedabad, Gujarat',
        city: 'Ahmedabad',
        state: 'Gujarat',
        locality: 'Thaltej',
        zone: 'West',
        attrs: {
          pincode: 380054,
          tier: 'Tier 1',
          seats: 1282,
          cinema_chain: 'Pvr-inox',
          total_screen: 6,
          audience_class: 'Platinum'
        }
      }
    }
  );
}

test('Cinema catalog attributes survive costing and populate the workbook', async () => {
  const line = cinemaLine();
  const plan = {
    title: 'Media Plan - Urban Aura, Ahmedabad',
    client_name: 'Urban Aura',
    budget: 700000,
    budget_includes_gst: true,
    legs: [{
      media: 'Cinema',
      scope: 'PVR Ahmedabad-Acropolis',
      duration_label: '4 Weeks',
      lines: [line],
      notes: []
    }],
    charges: [{
      id: 'cinema.making_conversion',
      media: 'Cinema',
      label: 'Making & Conversion Cost per Creative',
      quantity: 1,
      unit_rate: 5000,
      gst_rate: 18,
      net: 5000,
      gst: 900,
      total: 5900
    }],
    reserves: [],
    flags: [],
    desk_actions: [],
    guidance: []
  };

  const workbook = await buildPlanWorkbook(plan);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'Summary',
    'Plan',
    'T&C - Cinema',
    'Notes (Internal)'
  ]);

  const summary = workbook.getWorksheet('Summary');
  assert.equal(summary.getCell('B7').value, 'Cinema');
  assert.equal(summary.getCell('D7').value, 20);
  assert.equal(summary.getCell('E7').value, '4 Weeks');
  assert.equal(summary.getCell('F7').value, line.net);
  assert.equal(summary.getCell('H7').value, line.total);

  const cinema = workbook.getWorksheet('Plan');
  assert.equal(cinema.getCell('B13').value, 'PLAN FOR CINEMA BRANDING');
  assert.equal(cinema.getCell('B14').value, 'Sr. No.');
  assert.equal(cinema.getCell('R14').value, 'Rates for 20 Sec :A/V Slide  (1 Week)');
  assert.equal(cinema.getCell('B15').value, 1);
  assert.equal(cinema.getCell('C15').value, 'Gujarat');
  assert.equal(cinema.getCell('D15').value, 'Ahmedabad');
  assert.equal(cinema.getCell('E15').value, 'CINEMA000239SCREEN-5ADFILM');
  assert.equal(cinema.getCell('F15').value, 'Thaltej');
  assert.equal(cinema.getCell('G15').value, '380054');
  assert.equal(cinema.getCell('H15').value, 'Platinum');
  assert.equal(cinema.getCell('I15').value, 'Pvr Ahmedabad-Acropolis, Ahmedabad, Gujarat');
  assert.equal(cinema.getCell('K15').value, 'Tier 1');
  assert.equal(cinema.getCell('M15').value, 6);
  assert.equal(cinema.getCell('N15').value, 5);
  assert.equal(cinema.getCell('P15').value, 'Pvr-inox');
  assert.equal(cinema.getCell('Q15').value, 1282);
  assert.equal(cinema.getCell('R15').value, 2900);
  assert.equal(cinema.getCell('B16').value, 'Total Screens : 1');
  assert.equal(cinema.getCell('R16').value.result, 2900);
  assert.equal(cinema.getCell('R17').value.result, line.net);
  assert.equal(cinema.getCell('R18').value, 5000);
  assert.equal(cinema.getCell('R20').value.result, line.gst + 900);
  assert.equal(cinema.getCell('R21').value.result, line.total + 5900);
  assert.equal(cinema.getCell('B13').fill.fgColor.argb, 'FF510C2C');
  assert.equal(cinema.getCell('R17').fill.fgColor.argb, 'FFFFFF00');

  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer.byteLength > 10000);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer);
  const formulas = [];
  reopened.getWorksheet('Plan').eachRow((row) => row.eachCell((cell) => {
    if (cell.value && typeof cell.value === 'object' && cell.value.formula) {
      formulas.push(cell.value.formula);
    }
  }));
  assert.equal(formulas.some((formula) => formula.includes('#REF!')), false);
});

test('Cinema duration uses requested weeks and correct GST does not raise a warning', () => {
  assert.equal(
    billingPeriods(
      { pricing_unit: 'per week per second' },
      { months: 1 },
      { duration_months: 1, duration_weeks: 4 }
    ),
    4
  );

  assert.equal(billingQuantity({ media_type: 'cinema' }, { qty: 40 }, {}), 10);
  assert.equal(
    billingQuantity(
      { media_type: 'cinema' },
      { qty: 40 },
      { creative_duration_seconds: 15 }
    ),
    15
  );

  assert.deepEqual(buildCharges([{ media: 'Cinema', lines: [cinemaLine()] }]), [{
    id: 'cinema.making_conversion',
    media: 'Cinema',
    label: 'Making & Conversion Cost per Creative',
    quantity: 1,
    unit_rate: 5000,
    gst_rate: 18,
    net: 5000,
    gst: 900,
    total: 5900,
    source: 'Cinema PAN India 07-04-2025 old.xlsx'
  }]);

  const verdict = applyConstraints([cinemaLine()], loadRules('Cinema'));
  assert.equal(verdict.violations.some((violation) => violation.id === 'global.gst_rate'), false);
});

test('Cinema client options include every screen in the requested creative format', () => {
  const product = {
    id: 77,
    media_type: 'cinema',
    sku: 'CINEMA77',
    name: 'Example Multiplex, Noida',
    city: 'Noida',
    state: 'Uttar Pradesh',
    attrs: { cinema_chain: 'PVR-INOX', total_screen: 2 },
    price_options: [
      { id: 1, sku: 'CINEMA77SCREEN-1SLIDE', name: 'SCREEN-1SLIDE', template: 'Slide', offer_rate: 100, minimum_billing: 10000, pricing_unit: 'per week per second', gst: 18, attrs: {} },
      { id: 2, sku: 'CINEMA77SCREEN-1ADFILM', name: 'SCREEN-1ADFILM', template: 'Ad Film', offer_rate: 150, minimum_billing: 10000, pricing_unit: 'per week per second', gst: 18, attrs: {} },
      { id: 3, sku: 'CINEMA77SCREEN-2SLIDE', name: 'SCREEN-2SLIDE', template: 'Slide', offer_rate: 110, minimum_billing: 10000, pricing_unit: 'per week per second', gst: 18, attrs: {} },
      { id: 4, sku: 'CINEMA77SCREEN-2ADFILM', name: 'SCREEN-2ADFILM', template: 'Ad Film', offer_rate: 160, minimum_billing: 10000, pricing_unit: 'per week per second', gst: 18, attrs: {} }
    ]
  };
  const brief = {
    remarks_for_media: 'Creative Type - Slide Show or Feature Video: Video',
    creative_duration_seconds: 10,
    duration_weeks: 1
  };

  assert.equal(requestedCinemaCreative(brief), 'video');
  const leg = buildCompleteCinemaLeg([product], brief);
  assert.equal(leg.lines.length, 2);
  assert.deepEqual(leg.lines.map((line) => line.sku), [
    'CINEMA77SCREEN-1ADFILM',
    'CINEMA77SCREEN-2ADFILM'
  ]);
  assert.deepEqual(leg.lines.map((line) => line.net), [1500, 1600]);
  assert.equal(leg.lines.some((line) => line.min_billing_applied), false);
});

test('Cinema workbook shows all options and a separate recommended plan', async () => {
  const recommended = cinemaLine();
  const option = { ...recommended, net: 5800, gst: 1044, total: 6844 };
  const plan = {
    title: 'Media Plan - Urban Aura, Ahmedabad',
    client_name: 'Urban Aura',
    budget: 700000,
    budget_includes_gst: true,
    legs: [{ media: 'Cinema', scope: 'Recommended screen', duration_label: '4 Weeks', lines: [recommended], notes: [] }],
    client_options_legs: [{ media: 'Cinema', scope: 'All screens', duration_label: '4 Weeks', lines: [option], notes: [] }],
    charges: [],
    reserves: [],
    flags: [],
    desk_actions: [],
    guidance: []
  };

  const workbook = await buildPlanWorkbook(plan);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'Summary',
    'Plan',
    'Recommended Plan',
    'T&C - Cinema',
    'Notes (Internal)'
  ]);
  assert.equal(workbook.getWorksheet('Plan').getCell('B13').value, 'ALL MATCHING CINEMA OPTIONS');
  assert.equal(workbook.getWorksheet('Plan').lastRow.number, 15);
  assert.equal(workbook.getWorksheet('Recommended Plan').getCell('B13').value, 'RECOMMENDED CINEMA PLAN');
  assert.equal(workbook.getWorksheet('Recommended Plan').getCell('B16').value, 'Total Screens : 1');
});

test('Cinema recommendation is budget-safe and covers every requested city', () => {
  const product = (id, city, state) => ({
    id,
    media_type: 'cinema',
    name: `PVR ${city}`,
    city,
    state,
    attrs: { cinema_chain: 'PVR-INOX', audience_class: 'Gold' },
    price_options: Array.from({ length: 4 }, (_, index) => ({
      id: id * 10 + index,
      sku: `CINEMA${id}SCREEN-${index + 1}ADFILM`,
      name: `SCREEN-${index + 1}ADFILM`,
      template: 'Ad Film',
      offer_rate: 100,
      minimum_billing: 10000,
      pricing_unit: 'per week per second',
      gst: 18,
      attrs: {}
    }))
  });
  const noida = product(1, 'Noida', 'Uttar Pradesh');
  const gurugram = product(2, 'Gurugram', 'Haryana');
  const prefetch = {
    candidates: [noida, gurugram],
    locations: [
      { requested: 'Noida, Uttar Pradesh', city: 'Noida', state: 'Uttar Pradesh', match: 'city' },
      { requested: 'Gurugram, Haryana', city: 'Gurugram', state: 'Haryana', match: 'city' }
    ]
  };
  const modelSelections = noida.price_options.map((option) => ({
    product_id: noida.id,
    price_option_id: option.id,
    qty: 10,
    months: 1
  }));

  const result = selectBalancedCinema({
    budget: 100000,
    creative_duration_seconds: 10,
    duration_weeks: 1,
    preferred_catchments: [],
    remarks_for_media: 'Creative: Video. Preferred chain: PVR and INOX.'
  }, prefetch, modelSelections);

  assert.equal(result.selections.length, 7);
  assert.ok(result.selections.some((pick) => pick.product_id === noida.id));
  assert.ok(result.selections.some((pick) => pick.product_id === gurugram.id));
});

test('A brief with no budget renders the inventory sheet, not a costed plan', async () => {
  const line = costLine(
    {
      id: 30002243,
      sku: 'CINEMA004283SCREEN-1ADFILM',
      name: 'SCREEN-1ADFILM',
      offer_rate: 216,
      minimum_billing: 10000,
      pricing_unit: 'per week per second',
      gst: 18,
      attrs: {}
    },
    {
      qty: 15,
      months: 2,
      applyMinimumBilling: false,
      product: {
        id: 4283,
        sku: 'CINEMA004283',
        name: 'Pvr Inox Umrao Mall, Nishatganj, Lucknow',
        city: 'Lucknow',
        state: 'Uttar Pradesh',
        locality: 'Mahanagar',
        attrs: { pincode: 226006, audience_class: 'Gold', cinema_chain: 'PVR-INOX', seats: 213 }
      }
    }
  );

  // 216 x 15s x 2wk = 6,480, which is under the 10,000 floor. Nothing was
  // bought, so the floor must not lift it.
  assert.equal(line.net, 6480);
  assert.equal(line.min_billing_applied, false);

  assert.equal(planMode({ budget: null }), 'inventory');
  assert.equal(planMode({ budget: 500000 }), 'costed');

  const workbook = await buildPlanWorkbook({
    mode: 'inventory',
    title: 'Cinema Plan for APIS Honey',
    client_name: 'APIS Honey',
    budget: 0,
    target_location: 'Lucknow',
    legs: [{ media: 'Cinema', scope: 'INOX', duration_label: '2 Weeks', lines: [line], notes: [] }],
    charges: [],
    reserves: [],
    flags: [],
    desk_actions: [],
    guidance: []
  });

  // No Summary: there is no budget to reconcile and nothing bought to total.
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'Plan',
    'T&C - Cinema',
    'Notes (Internal)'
  ]);

  const sheet = workbook.getWorksheet('Plan');

  // TIER, Capacity Preference and Total Screen drop out, leaving 14 columns
  // ending at O -- the shape the desk builds by hand.
  assert.equal(sheet.getCell('K14').value, 'Audi No');
  assert.equal(sheet.getCell('O14').value, 'Rates for 15 Sec :A/V Slide  (2 Weeks)');

  assert.equal(sheet.getCell('G15').value, '226006');
  assert.equal(sheet.getCell('F15').value, 'Mahanagar');
  // The rate quoted is the whole flight, not one week of it.
  assert.equal(sheet.getCell('O15').value, 6480);

  // The sheet ends on its last row of stock: no Total Screens, no GST, no total.
  assert.equal(sheet.lastRow.number, 15);
  assert.equal(sheet.actualColumnCount, 14);
});
