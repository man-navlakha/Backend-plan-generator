const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const log = require('../src/log');
const { queryMetadata } = require('../src/pg');

test('structured logger redacts secrets recursively', () => {
  const value = log.sanitize({
    request_id: 'request-1',
    authorization: 'Bearer secret',
    nested: {
      api_key: 'secret-key',
      password: 'secret-password',
      safe: 'visible'
    }
  });

  assert.equal(value.request_id, 'request-1');
  assert.equal(value.authorization, '[REDACTED]');
  assert.equal(value.nested.api_key, '[REDACTED]');
  assert.equal(value.nested.password, '[REDACTED]');
  assert.equal(value.nested.safe, 'visible');
});

test('log context carries request and plan identifiers through async work', async () => {
  await log.withContext({ request_id: 'request-2' }, async () => {
    await Promise.resolve();
    log.addContext({ plan_id: '42', deal_id: 'deal-42' });
    assert.deepEqual(log.currentContext(), {
      request_id: 'request-2',
      plan_id: '42',
      deal_id: 'deal-42'
    });
  });
  assert.deepEqual(log.currentContext(), {});
});

test('Postgres metadata names the operation and table without SQL values', () => {
  assert.deepEqual(
    queryMetadata(' update app.plans set status=$2 where id=$1 '),
    { operation: 'UPDATE', target: 'app.plans' }
  );
  assert.deepEqual(
    queryMetadata('select * from masters.products where id=$1'),
    { operation: 'SELECT', target: 'masters.products' }
  );
});

test('optional Loki exporter sends Grafana push JSON with low-cardinality labels', async () => {
  let received;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = {
        path: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      };
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const previous = {
    url: process.env.GRAFANA_LOKI_URL,
    user: process.env.GRAFANA_LOKI_USER,
    key: process.env.GRAFANA_LOKI_API_KEY
  };
  process.env.GRAFANA_LOKI_URL = `http://127.0.0.1:${server.address().port}/loki/api/v1/push`;
  process.env.GRAFANA_LOKI_USER = '12345';
  process.env.GRAFANA_LOKI_API_KEY = 'test-token';

  try {
    log.info('test.loki.export', { safe_value: 7, api_key: 'must-not-leak' });
    assert.equal(await log.flush(), true);
    assert.equal(received.path, '/loki/api/v1/push');
    assert.equal(received.authorization, `Basic ${Buffer.from('12345:test-token').toString('base64')}`);
    assert.equal(received.body.streams.length, 1);
    assert.deepEqual(Object.keys(received.body.streams[0].stream).sort(), [
      'environment',
      'level',
      'service'
    ]);
    const exported = JSON.parse(received.body.streams[0].values[0][1]);
    assert.equal(exported.event, 'test.loki.export');
    assert.equal(exported.api_key, '[REDACTED]');
  } finally {
    if (previous.url === undefined) delete process.env.GRAFANA_LOKI_URL;
    else process.env.GRAFANA_LOKI_URL = previous.url;
    if (previous.user === undefined) delete process.env.GRAFANA_LOKI_USER;
    else process.env.GRAFANA_LOKI_USER = previous.user;
    if (previous.key === undefined) delete process.env.GRAFANA_LOKI_API_KEY;
    else process.env.GRAFANA_LOKI_API_KEY = previous.key;
    await new Promise((resolve) => server.close(resolve));
  }
});
