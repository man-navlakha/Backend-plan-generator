const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const contextStorage = new AsyncLocalStorage();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = '[REDACTED]';
const SECRET_KEY = /authorization|api[_-]?key|token|password|passwd|secret|cookie|db[_-]?url|database[_-]?url/i;
const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const minimumLevel = LEVELS[configuredLevel] || LEVELS.info;

const baseFields = {
  service: process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'backend-plan-generator',
  environment:
    process.env.VERCEL_ENV ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.NODE_ENV ||
    'development',
  deployment_id: process.env.VERCEL_DEPLOYMENT_ID || process.env.RAILWAY_DEPLOYMENT_ID || undefined,
  commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || undefined
};

let lokiQueue = [];
let lokiTimer = null;
let lokiInFlight = null;
let timestampSequence = 0n;

function cleanString(value, limit = 12_000) {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

/** Recursively redact secrets and keep log entries JSON-safe and bounded. */
function sanitize(value, key = '', seen = new WeakSet()) {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return cleanString(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorDetails(value);
  if (Buffer.isBuffer(value)) return { type: 'Buffer', bytes: value.length };
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, key, seen));
  if (typeof value !== 'object') return cleanString(value);
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    const cleaned = sanitize(childValue, childKey, seen);
    if (cleaned !== undefined) output[childKey] = cleaned;
  }
  seen.delete(value);
  return output;
}

function errorDetails(error) {
  const details = {
    name: error?.name || 'Error',
    message: cleanString(error?.message || String(error), 4_000),
    code: error?.code || undefined,
    status: error?.status || undefined,
    type: error?.type || undefined,
    stack: error?.stack ? cleanString(error.stack, 12_000) : undefined
  };
  if (error?.cause && error.cause !== error) {
    details.cause = {
      name: error.cause.name || 'Error',
      message: cleanString(error.cause.message || String(error.cause), 2_000),
      code: error.cause.code || undefined
    };
  }
  return sanitize(details);
}

function requestId(value) {
  const supplied = String(value || '').trim();
  if (/^[A-Za-z0-9._:-]{1,100}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function currentContext() {
  return contextStorage.getStore() || {};
}

function withContext(fields, callback) {
  return contextStorage.run({ ...currentContext(), ...sanitize(fields) }, callback);
}

/** Add plan/deal fields after a request has progressed far enough to know them. */
function addContext(fields) {
  const store = contextStorage.getStore();
  if (store) Object.assign(store, sanitize(fields));
}

function lokiConfig() {
  const url = process.env.GRAFANA_LOKI_URL || process.env.LOKI_URL || '';
  const username = process.env.GRAFANA_LOKI_USER || process.env.LOKI_USERNAME || '';
  const password = process.env.GRAFANA_LOKI_API_KEY || process.env.LOKI_PASSWORD || '';
  const tenant = process.env.GRAFANA_LOKI_TENANT_ID || process.env.LOKI_TENANT_ID || '';
  return { url, username, password, tenant, enabled: Boolean(url) };
}

function safeLabel(value, fallback) {
  return String(value || fallback || 'unknown').slice(0, 120);
}

function lokiTimestamp() {
  timestampSequence = (timestampSequence + 1n) % 1_000_000n;
  return (BigInt(Date.now()) * 1_000_000n + timestampSequence).toString();
}

function enqueueForLoki(entry, line) {
  const config = lokiConfig();
  if (!config.enabled) return;

  lokiQueue.push({ timestamp: lokiTimestamp(), entry, line });
  const requestedBatch = Number(process.env.GRAFANA_LOKI_BATCH_SIZE || 25);
  const batchSize = process.env.VERCEL ? 1 : Math.max(1, Math.min(requestedBatch || 25, 100));
  if (lokiQueue.length >= batchSize) {
    void flush();
    return;
  }

  if (!lokiTimer) {
    lokiTimer = setTimeout(() => {
      lokiTimer = null;
      void flush();
    }, Math.max(100, Number(process.env.GRAFANA_LOKI_FLUSH_MS || 1000)));
    lokiTimer.unref?.();
  }
}

function directDiagnostic(level, event, fields) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitize(fields)
  });
  if (level === 'error') console.error(line);
  else console.warn(line);
}

async function pushLoki(items) {
  const config = lokiConfig();
  if (!config.enabled || !items.length) return true;

  const grouped = new Map();
  for (const item of items) {
    const labels = {
      service: safeLabel(item.entry.service, baseFields.service),
      environment: safeLabel(item.entry.environment, baseFields.environment),
      level: safeLabel(item.entry.level, 'info')
    };
    const key = JSON.stringify(labels);
    if (!grouped.has(key)) grouped.set(key, { stream: labels, values: [] });
    grouped.get(key).values.push([item.timestamp, item.line]);
  }

  const headers = { 'content-type': 'application/json' };
  if (config.username || config.password) {
    headers.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }
  if (config.tenant) headers['x-scope-orgid'] = config.tenant;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.GRAFANA_LOKI_TIMEOUT_MS || 5000));
  timeout.unref?.();
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ streams: [...grouped.values()] }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Loki returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

/** Flushes queued Loki logs. Export failures never fail a client request. */
async function flush() {
  if (lokiInFlight) return lokiInFlight;
  if (lokiTimer) {
    clearTimeout(lokiTimer);
    lokiTimer = null;
  }
  const items = lokiQueue.splice(0, 100);
  if (!items.length) return true;

  lokiInFlight = pushLoki(items)
    .catch((error) => {
      directDiagnostic('error', 'observability.loki_export_failed', {
        dropped_entries: items.length,
        error: errorDetails(error)
      });
      return false;
    })
    .finally(() => {
      lokiInFlight = null;
      if (lokiQueue.length) void flush();
    });
  return lokiInFlight;
}

async function shutdown() {
  if (lokiTimer) clearTimeout(lokiTimer);
  lokiTimer = null;
  return flush();
}

function status() {
  const config = lokiConfig();
  let endpointHost = null;
  if (config.url) {
    try { endpointHost = new URL(config.url).host; } catch { endpointHost = 'invalid_url'; }
  }
  return {
    format: 'json',
    level: Object.hasOwn(LEVELS, configuredLevel) ? configuredLevel : 'info',
    stdout: true,
    loki: {
      enabled: config.enabled,
      endpoint_host: endpointHost,
      basic_auth_configured: Boolean(config.username && config.password),
      tenant_configured: Boolean(config.tenant)
    }
  };
}

function write(level, event, fields = {}) {
  if ((LEVELS[level] || LEVELS.info) < minimumLevel) return null;
  const entry = sanitize({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...baseFields,
    ...currentContext(),
    ...fields
  });
  const line = JSON.stringify(entry);

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  enqueueForLoki(entry, line);
  return entry;
}

module.exports = {
  debug: (event, fields) => write('debug', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  errorDetails,
  requestId,
  withContext,
  addContext,
  currentContext,
  flush,
  shutdown,
  status,
  sanitize
};
