const crypto = require('crypto');

/**
 * Emit compact JSON logs that Railway can search by event, request_id or
 * plan_id. Callers pass only operational metadata; client briefs and secrets
 * must never be included in the fields object.
 */
function write(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  const line = JSON.stringify(entry);

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  return entry;
}

function errorDetails(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || undefined,
    status: error?.status || undefined,
    stack: error?.stack || undefined
  };
}

function requestId(value) {
  const supplied = String(value || '').trim();
  if (/^[A-Za-z0-9._:-]{1,100}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

module.exports = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  errorDetails,
  requestId
};
