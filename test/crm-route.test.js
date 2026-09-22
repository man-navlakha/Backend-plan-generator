const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

async function withServer(run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeIdleConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test('CRM generation endpoint is unavailable until CRM_API_KEY is configured', async () => {
  const previous = process.env.CRM_API_KEY;
  delete process.env.CRM_API_KEY;
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/plans/generate`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'crm_not_configured');
    });
  } finally {
    if (previous === undefined) delete process.env.CRM_API_KEY;
    else process.env.CRM_API_KEY = previous;
  }
});

test('CRM generation endpoint rejects an invalid API key before processing the brief', async () => {
  const previous = process.env.CRM_API_KEY;
  process.env.CRM_API_KEY = 'correct-key';
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/plans/generate`, {
        headers: { authorization: 'Bearer wrong-key' }
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'unauthorized');
    });
  } finally {
    if (previous === undefined) delete process.env.CRM_API_KEY;
    else process.env.CRM_API_KEY = previous;
  }
});

test('CRM generation endpoint validates all three query parameters before using OpenAI', async () => {
  const previous = process.env.CRM_API_KEY;
  process.env.CRM_API_KEY = 'correct-key';
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/plans/generate`, {
        headers: { 'x-api-key': 'correct-key' }
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.code, 'invalid_request');
      assert.deepEqual(body.errors.map((error) => error.field), [
        'deal_id',
        'service',
        'client_brief'
      ]);
    });
  } finally {
    if (previous === undefined) delete process.env.CRM_API_KEY;
    else process.env.CRM_API_KEY = previous;
  }
});
