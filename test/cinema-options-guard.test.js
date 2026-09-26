const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCompleteCinemaLeg } = require('../src/engine/build');

test('Cinema options builder ignores non-Cinema catalog products', () => {
  const result = buildCompleteCinemaLeg([
    {
      id: 'auto-1',
      media_type: 'auto',
      price_options: [{ id: 'auto-rate-1', name: 'Back Panel' }]
    }
  ], {});

  assert.equal(result, null);
});
