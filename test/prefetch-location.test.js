const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchRequestedLocation,
  cinemaCityValues,
  dedupeCinemaProducts
} = require('../src/catalog/prefetch');

const available = [
  { city_key: 'noida', city: 'Noida', state_key: 'uttar pradesh', state: 'Uttar Pradesh' },
  { city_key: 'noida', city: 'Noida', state_key: 'delhi', state: 'Delhi' },
  { city_key: 'gurugram', city: 'Gurugram', state_key: 'haryana', state: 'Haryana' },
  { city_key: 'lucknow', city: 'Lucknow', state_key: 'uttar pradesh', state: 'Uttar Pradesh' }
];

test('matches a qualified city and state returned by brief review', () => {
  assert.deepEqual(
    matchRequestedLocation('Noida, Uttar Pradesh', available),
    {
      requested: 'Noida, Uttar Pradesh',
      city: 'Noida',
      state: 'Uttar Pradesh',
      match: 'city'
    }
  );

  assert.deepEqual(
    matchRequestedLocation('Gurugram, Haryana', available),
    {
      requested: 'Gurugram, Haryana',
      city: 'Gurugram',
      state: 'Haryana',
      match: 'city'
    }
  );
});

test('matches CRM location punctuation and an optional country suffix', () => {
  assert.deepEqual(
    matchRequestedLocation('Noida\u00b7 Uttar Pradesh, India', available),
    {
      requested: 'Noida\u00b7 Uttar Pradesh, India',
      city: 'Noida',
      state: 'Uttar Pradesh',
      match: 'city'
    }
  );
});

test('does not arbitrarily choose a state for an unqualified ambiguous city', () => {
  assert.deepEqual(
    matchRequestedLocation('Noida', available),
    { requested: 'Noida', city: 'Noida', state: null, match: 'city' }
  );
});

test('retains state-only matching and rejects an unknown location', () => {
  assert.deepEqual(
    matchRequestedLocation('Uttar Pradesh', available),
    { requested: 'Uttar Pradesh', city: null, state: 'Uttar Pradesh', match: 'state' }
  );
  assert.deepEqual(
    matchRequestedLocation('Unknown Place', available),
    { requested: 'Unknown Place', city: null, state: null, match: 'none' }
  );
});

test('Cinema search treats Gurugram and Gurgaon as one market', () => {
  assert.deepEqual(cinemaCityValues('Gurugram'), ['Gurugram', 'Gurgaon']);
  assert.deepEqual(cinemaCityValues('Gurgaon'), ['Gurgaon', 'Gurugram']);
});

test('Cinema deduplication keeps the complete per-audi row over its sparse alias', () => {
  const sparse = {
    id: 2,
    city: 'Gurugram',
    state: 'Haryana',
    locality: null,
    name: 'INOX World Mark, Sector 65 - Audi 1',
    attrs: {
      screen_code: 'HR5019_AUDI 1',
      audi_no: 1,
      multiplex_name: 'INOX World Mark, Sector 65',
      address: 'INOX World Mark, Sector 65, Gurugram, Haryana'
    }
  };
  const complete = {
    id: 1,
    city: 'Gurgaon',
    state: 'Haryana',
    locality: 'Sector 65',
    name: 'Pvr Inox Worldmark Mall - Audi 1',
    attrs: {
      screen_code: 'HR5187_AUDI 1',
      audi_no: 1,
      multiplex_name: 'Pvr Inox Worldmark Mall',
      address: 'Worldmark, Maidawas Road, Sector 65, Gurugram',
      pincode: 122101,
      theatre_type: 'Platinum',
      audi_type: 'Normal',
      cinema_chain: 'PVR-INOX',
      seating_capacity: 227
    }
  };

  assert.deepEqual(dedupeCinemaProducts([sparse, complete]), [complete]);
});
