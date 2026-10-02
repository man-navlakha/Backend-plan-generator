const test = require('node:test');
const assert = require('node:assert/strict');

const { selectDeterministic } = require('../src/engine/select');

function station(id, city, listenership, rank, rate, state = 'Punjab') {
  return {
    id,
    name: `Station ${id}`,
    media_type: 'private_radio',
    city,
    state,
    attrs: {
      station: `Station ${id}`,
      listenership,
      rank
    },
    price_options: [{
      id: id * 10,
      name: 'RODP 10 sec',
      offer_rate: rate,
      discounted_rate: null,
      buying_rate: rate * 0.8,
      minimum_billing: null,
      pricing_unit: 'per second',
      gst: 18,
      attrs: {}
    }]
  };
}

test('radio planner scores stations and weights frequency by city priority', () => {
  const result = selectDeterministic({
    service: 'Radio',
    budget: 200000,
    campaign_objective: 'Brand awareness and Punjab city dominance',
    target_locations: ['Chandigarh', 'Ludhiana', 'Amritsar', 'Jalandhar'],
    duration_days: 30,
    creative_duration_seconds: 10
  }, {
    candidates: [
      station(1, 'Chandigarh', '255K', 1, 35),
      station(2, 'Ludhiana', '180K', 2, 22),
      station(3, 'Amritsar', '150K', 3, 18),
      station(4, 'Jalandhar', '120K', 4, 12),
      station(5, 'Jammu', '200K', 1, 10, 'Jammu & Kashmir')
    ]
  });

  assert.equal(result.strategy, 'deterministic_radio_planner');
  assert.match(result.reasoning[0], /listenership 40%, rank 30%, cost efficiency 20%, city priority 10%/);

  const byCity = new Map(result.selections.map((pick) => [
    pick.why.match(/Station \d+ ([^:]+):/)?.[1],
    pick
  ]));
  assert.equal(byCity.has('Jammu'), false);
  assert.ok(byCity.get('Chandigarh').planner_fields.spots_per_day > byCity.get('Jalandhar').planner_fields.spots_per_day);
  assert.equal(byCity.get('Chandigarh').planner_fields.spot_seconds, 10);
  assert.equal(byCity.get('Chandigarh').planner_fields.days, 30);
});
