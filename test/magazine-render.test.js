const test = require('node:test');
const assert = require('node:assert/strict');

const { costLine } = require('../src/engine/cost');
const { selectDeterministic } = require('../src/engine/select');
const { buildPlanWorkbook } = require('../src/render');

function magazineLine(position) {
  return costLine(
    {
      id: 70468447,
      sku: 'MAGAZINE10053MAGAZINEADVERTISING',
      name: 'Magazine Advertising',
      offer_rate: 185000,
      minimum_billing: 10000,
      pricing_unit: 'per Insertion',
      gst: 18,
      attrs: { Position: position }
    },
    {
      qty: 1,
      months: 1,
      product: {
        id: 70069291,
        sku: 'MAGAZINE10053',
        name: 'Architect and Interiors India',
        attrs: {
          Country: 'India',
          Edition: null,
          Category: 'Interior Design and Architecture',
          Frequency: 'Monthly',
          Circulation: '74500',
          'Language (Multiple)': 'English'
        }
      }
    }
  );
}

test('Magazine catalog fields populate the client workbook with the correct GST label', async () => {
  const line = magazineLine('Back Cover Page');
  const workbook = await buildPlanWorkbook({
    mode: 'costed',
    title: 'Magazine Plan for Example Client',
    client_name: 'Example Client',
    budget: 250000,
    budget_includes_gst: true,
    legs: [{
      media: 'Magazine',
      scope: 'Architect and Interiors India - Magazine Advertising',
      duration_label: '1 Month',
      lines: [line],
      notes: []
    }],
    charges: [],
    reserves: [],
    flags: [],
    desk_actions: [],
    guidance: []
  });

  const sheet = workbook.getWorksheet('Magazine');
  assert.ok(sheet);
  assert.equal(sheet.getCell('B6').value, 'Publication');
  assert.equal(sheet.getCell('H6').value, 'GST @18%');
  assert.equal(sheet.getCell('B7').value, 'Architect and Interiors India');
  assert.equal(sheet.getCell('C7').value, 74500);
  assert.equal(sheet.getCell('D7').value, 'Monthly');
  assert.equal(sheet.getCell('E7').value, 'Full Page');
  assert.equal(sheet.getCell('F7').value, 'Back Cover');
  assert.equal(sheet.getCell('G7').value, 185000);
  assert.equal(sheet.getCell('H7').value, 33300);
  assert.equal(sheet.getCell('I7').value, 218300);
});

test('Magazine size-only selections use the approved Inside Page placement', async () => {
  const line = magazineLine('Quarter Page');
  const workbook = await buildPlanWorkbook({
    mode: 'inventory',
    title: 'Magazine inventory',
    client_name: 'Example Client',
    budget: 0,
    legs: [{ media: 'Magazine', scope: 'Magazine inventory', duration_label: '1 Month', lines: [line], notes: [] }],
    charges: [], reserves: [], flags: [], desk_actions: [], guidance: []
  });

  const sheet = workbook.getWorksheet('Magazine');
  assert.equal(sheet.getCell('E7').value, 'Quarter Page');
  assert.equal(sheet.getCell('F7').value, 'Inside Page');
});

test('A single-medium Magazine plan can use the full GST-inclusive budget', () => {
  const result = selectDeterministic(
    { service: 'Magazine', budget: 250000 },
    {
      candidates: [
        {
          id: 1,
          media_type: 'magazine',
          price_options: [{
            id: 11,
            name: 'Magazine Advertising',
            offer_rate: 185000,
            pricing_unit: 'per Insertion',
            gst: 18,
            units: [{ minimum: 1 }]
          }]
        },
        {
          id: 2,
          media_type: 'magazine',
          price_options: [{
            id: 22,
            name: 'Premium Magazine Advertising',
            offer_rate: 240000,
            pricing_unit: 'per Insertion',
            gst: 18,
            units: [{ minimum: 1 }]
          }]
        }
      ]
    }
  );

  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].product_id, 1);
  assert.equal(result.selections[0].qty, 1);
  assert.ok(185000 * 1.18 <= 250000);
});
