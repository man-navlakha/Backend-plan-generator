const app = require('./app');
const { validateAllRules } = require('./rules');

// Fail at boot, not mid-plan: a malformed rules file would otherwise silently
// disable a commercial restriction.
const rules = validateAllRules();
console.log(`Rules loaded: ${rules.files.length} files, ${rules.constraints} constraints`);

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Stop accepting new connections before exiting so in-flight requests finish.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
