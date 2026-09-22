const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeReview, reviewClientBrief } = require('../src/engine/brief-review');

test('normalizeReview keeps extracted facts and reports no missing required fields', () => {
  const result = normalizeReview({
    company: '  Awadh Foods Pvt. Ltd. ',
    budget: 1500000,
    campaign_objective: 'Brand awareness',
    target_audience: 'Working professionals',
    target_locations: ['Lucknow', 'Lucknow', ' Kanpur '],
    remarks_for_media: 'Premium routes only',
    duration_months: 2,
    service_conflict: false,
    service_conflict_reason: null,
    warnings: []
  });

  assert.deepEqual(result.missing_fields, []);
  assert.equal(result.brief.company, 'Awadh Foods Pvt. Ltd.');
  assert.equal(result.brief.budget, 1500000);
  assert.deepEqual(result.brief.target_locations, ['Lucknow', 'Kanpur']);
  assert.equal(result.brief.duration_months, 2);
});

test('normalizeReview never turns absent company or budget into usable values', () => {
  const result = normalizeReview({
    company: null,
    budget: null,
    target_locations: [],
    service_conflict: false,
    service_conflict_reason: null,
    warnings: ['Budget was not stated.']
  });

  assert.deepEqual(result.missing_fields, ['company', 'budget']);
  assert.equal(result.brief.company, null);
  assert.equal(result.brief.budget, null);
});

test('reviewClientBrief requests strict structured output and normalizes it', async () => {
  let request;
  const fakeClient = {
    chat: {
      completions: {
        create: async (value) => {
          request = value;
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  company: 'Acme',
                  budget: 800000,
                  campaign_objective: null,
                  target_audience: null,
                  target_locations: ['Mumbai'],
                  remarks_for_media: null,
                  duration_months: null,
                  service_conflict: false,
                  service_conflict_reason: null,
                  warnings: []
                })
              }
            }],
            usage: { prompt_tokens: 20, completion_tokens: 10 }
          };
        }
      }
    }
  };

  const result = await reviewClientBrief('Acme, Mumbai, budget 8 lakh.', {
    client: fakeClient,
    model: 'test-model'
  });

  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.match(request.messages[1].content, /"requested_service":null/);
  assert.equal(result.model, 'test-model');
  assert.equal(result.brief.budget, 800000);
  assert.deepEqual(result.missing_fields, []);
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 10 });
});
