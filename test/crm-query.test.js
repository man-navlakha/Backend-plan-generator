const test = require('node:test');
const assert = require('node:assert/strict');

const { clientBriefFromUrl } = require('../src/crm/query');

test('clientBriefFromUrl decodes a correctly encoded client brief', () => {
  const url =
    '/plans/generate?deal_id=D1&service=Cinema&client_brief=' +
    encodeURIComponent('Urban Aura, Industry: Fashion & Lifestyle. Budget: ₹5–7 Lakhs.');

  assert.equal(
    clientBriefFromUrl(url),
    'Urban Aura, Industry: Fashion & Lifestyle. Budget: ₹5–7 Lakhs.'
  );
});

test('clientBriefFromUrl recovers text after an unescaped ampersand', () => {
  const url =
    '/plans/generate?deal_id=D1&service=Cinema&client_brief=' +
    'Urban%20Aura,%20Industry:%20Fashion%20&%20Lifestyle.%20Budget:%20%E2%82%B95%E2%80%937%20Lakhs.';

  assert.equal(
    clientBriefFromUrl(url, 'Urban Aura, Industry: Fashion '),
    'Urban Aura, Industry: Fashion & Lifestyle. Budget: ₹5–7 Lakhs.'
  );
});

test('clientBriefFromUrl keeps force as an API option instead of brief text', () => {
  const url =
    '/plans/generate?deal_id=D1&service=Cinema&client_brief=Urban%20Aura%20%26%20Co&force=true';

  assert.equal(clientBriefFromUrl(url), 'Urban Aura & Co');
});
