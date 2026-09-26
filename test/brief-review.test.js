const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReview,
  extractBudgetRange,
  extractDurationWeeks,
  extractCreativeDurationSeconds,
  extractPreferredCatchments,
  extractRequestedPublications,
  hasExplicitBlankBudget,
  reviewClientBrief
} = require('../src/engine/brief-review');

test('normalizeReview keeps extracted facts and reports no missing required fields', () => {
  const result = normalizeReview({
    company: '  Awadh Foods Pvt. Ltd. ',
    budget: 1500000,
    budget_min: null,
    budget_max: null,
    campaign_objective: 'Brand awareness',
    target_audience: 'Working professionals',
    target_locations: ['Lucknow', 'Lucknow', ' Kanpur '],
    preferred_catchments: [],
    remarks_for_media: 'Premium routes only',
    duration_months: 2,
    duration_weeks: null,
    creative_duration_seconds: null,
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

test('normalizeReview keeps an absent budget absent, and asks only for the company', () => {
  const result = normalizeReview({
    company: null,
    budget: null,
    budget_min: null,
    budget_max: null,
    target_locations: [],
    preferred_catchments: [],
    duration_weeks: null,
    creative_duration_seconds: null,
    service_conflict: false,
    service_conflict_reason: null,
    warnings: ['Budget was not stated.']
  });

  // A brief with no budget is a request for an inventory sheet, not an
  // incomplete brief: only the company blocks the run.
  assert.deepEqual(result.missing_fields, ['company']);
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
                  budget_min: null,
                  budget_max: null,
                  campaign_objective: null,
                  target_audience: null,
                  target_locations: ['Mumbai'],
                  preferred_catchments: [],
                  remarks_for_media: null,
                  duration_months: null,
                  duration_weeks: null,
                  creative_duration_seconds: null,
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

test('normalizeReview uses the upper value of an explicit budget range', () => {
  const result = normalizeReview({
    company: 'Urban Aura',
    budget: 700000,
    budget_min: 500000,
    budget_max: 700000,
    target_locations: ['Ahmedabad'],
    service_conflict: false,
    service_conflict_reason: null,
    warnings: ['Budget is tentative; the upper end of the range is used as the ceiling.']
  });

  assert.equal(result.brief.budget, 700000);
  assert.equal(result.brief.budget_min, 500000);
  assert.equal(result.brief.budget_max, 700000);
  assert.deepEqual(result.missing_fields, []);
});

test('extractBudgetRange understands Indian lakh ranges without matching age ranges', () => {
  assert.deepEqual(extractBudgetRange('Tentative Budget: ₹5–7 Lakhs.'), {
    minimum: 500000,
    maximum: 700000
  });
  assert.equal(extractBudgetRange('Target audience: age 20–40 years.'), null);
});

test('reviewClientBrief applies the deterministic range when model output misses it', async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                company: 'Urban Aura',
                budget: null,
                budget_min: null,
                budget_max: null,
                campaign_objective: 'Brand awareness',
                target_audience: null,
                target_locations: ['Ahmedabad'],
                preferred_catchments: [],
                remarks_for_media: null,
                duration_months: null,
                duration_weeks: null,
                creative_duration_seconds: null,
                service_conflict: false,
                service_conflict_reason: null,
                warnings: ['Budget was ambiguous.']
              })
            }
          }]
        })
      }
    }
  };

  const result = await reviewClientBrief('Urban Aura. Tentative Budget: ₹5–7 Lakhs.', {
    client: fakeClient,
    model: 'test-model',
    service: 'Cinema'
  });

  assert.equal(result.brief.budget, 700000);
  assert.equal(result.brief.budget_min, 500000);
  assert.equal(result.brief.budget_max, 700000);
  assert.deepEqual(result.missing_fields, []);
});

test('Cinema weeks and preferred catchments retain their distinct meanings', async () => {
  assert.equal(extractDurationWeeks('Campaign Period: 4 Weeks.'), 4);
  assert.equal(extractCreativeDurationSeconds('Creative: 10 second A/V film.'), 10);
  assert.equal(extractCreativeDurationSeconds('Creative: 15-second A/V film.'), 15);
  assert.deepEqual(
    extractPreferredCatchments(
      'Target Geography: Ahmedabad. Preferred Catchments: Satellite, Vastrapur, Thaltej.'
    ),
    ['Satellite', 'Vastrapur', 'Thaltej']
  );

  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                company: 'Urban Aura',
                budget: 700000,
                budget_min: 500000,
                budget_max: 700000,
                campaign_objective: 'Brand awareness',
                target_audience: 'Age 20-40',
                target_locations: ['Ahmedabad', 'Satellite', 'Vastrapur', 'Thaltej'],
                preferred_catchments: ['Satellite', 'Vastrapur', 'Thaltej'],
                remarks_for_media: 'Premium multiplexes.',
                duration_months: 1,
                duration_weeks: null,
                creative_duration_seconds: null,
                service_conflict: false,
                service_conflict_reason: null,
                warnings: []
              })
            }
          }]
        })
      }
    }
  };

  const result = await reviewClientBrief(
    'Urban Aura. Budget ₹5–7 Lakhs. Target Geography: Ahmedabad. ' +
      'Preferred Catchments: Satellite, Vastrapur, Thaltej. Campaign Period: 4 Weeks.',
    { client: fakeClient, model: 'test-model', service: 'Cinema' }
  );

  assert.equal(result.brief.duration_weeks, 4);
  assert.equal(result.brief.duration_months, undefined);
  assert.deepEqual(result.brief.target_locations, ['Ahmedabad']);
  assert.deepEqual(result.brief.preferred_catchments, ['Satellite', 'Vastrapur', 'Thaltej']);
});

test('Magazine remarks become mandatory publication titles and clean a trailing possessive', () => {
  const brief = `
**Budget**

**\u2014**

**Sub-deal value**

**â‚¹7,50,000**

**Remarks for Magazine**

**Good Homes, forbes India, India Today Home's**`;

  assert.deepEqual(extractRequestedPublications(brief), [
    'Good Homes',
    'forbes India',
    'India Today Home'
  ]);
  assert.equal(hasExplicitBlankBudget(brief), true);
});

test('Magazine remarks parse an explanatory sentence followed by asterisk bullets', () => {
  assert.deepEqual(
    extractRequestedPublications(
      'Remarks for Magazine: Need proactive plan with minimum possible budget. ' +
        '* Forbes India * The Week * Happiest Health * Dr. Planet'
    ),
    ['Forbes India', 'The Week', 'Happiest Health', 'Dr. Planet']
  );
});

test('an explicitly blank Budget is not replaced by the CRM sub-deal value', async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                company: 'Wurfel Kuche',
                budget: 750000,
                budget_min: null,
                budget_max: null,
                campaign_objective: 'Branding',
                target_audience: 'Architectures',
                target_locations: ['Delhi'],
                preferred_catchments: [],
                remarks_for_media: "Good Homes, Forbes India, India Today Home's",
                requested_publications: [],
                duration_months: null,
                duration_weeks: null,
                creative_duration_seconds: null,
                service_conflict: false,
                service_conflict_reason: null,
                warnings: []
              })
            }
          }]
        })
      }
    }
  };
  const brief = [
    'Company: Wurfel Kuche',
    'Budget: \u2014',
    'Sub-deal value: â‚¹7,50,000',
    "Remarks for Magazine: Good Homes, Forbes India, India Today Home's"
  ].join('\n');
  const result = await reviewClientBrief(brief, {
    client: fakeClient,
    model: 'test-model',
    service: 'Magazine'
  });

  assert.equal(result.brief.budget, null);
  assert.deepEqual(result.brief.requested_publications, [
    'Good Homes',
    'Forbes India',
    'India Today Home'
  ]);
});
