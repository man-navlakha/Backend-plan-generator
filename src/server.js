const app = require('./app');
const { validateAllRules } = require('./rules');
const log = require('./log');

// Fail at boot, not mid-plan: a malformed rules file would otherwise silently
// disable a commercial restriction.
const rules = validateAllRules();
log.info('server.rules.loaded', {
  files: rules.files.length,
  constraints: rules.constraints
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  log.info('server.started', {
    port: Number(PORT) || PORT,
    node_version: process.version,
    process_id: process.pid,
    logging: log.status()
  });
});

// Observe fatal errors without changing Node's normal crash semantics.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  log.error('process.uncaught_exception', {
    origin,
    error: log.errorDetails(error)
  });
  void log.flush();
});

process.on('warning', (warning) => {
  log.warn('process.warning', { warning: log.errorDetails(warning) });
});

// Stop accepting new connections before exiting so in-flight requests finish.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log.info('server.shutdown.started', { signal });
    server.close(async () => {
      await log.shutdown();
      process.exit(0);
    });
  });
}
