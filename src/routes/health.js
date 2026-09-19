const express = require('express');

const router = express.Router();
const startedAt = Date.now();

// Liveness: is the process up? Cheap, no dependency checks.
router.get('/', (req, res) => {
  const memory = process.memoryUsage();

  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    startedAt: new Date(startedAt).toISOString(),
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    memory: {
      rssMb: +(memory.rss / 1024 / 1024).toFixed(2),
      heapUsedMb: +(memory.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMb: +(memory.heapTotal / 1024 / 1024).toFixed(2)
    }
  });
});

// Readiness: can we serve traffic? Add dependency probes (db, cache, queues) here.
router.get('/ready', async (req, res) => {
  const checks = {};

  // Example shape — replace with real probes as dependencies are added:
  // checks.database = await probe('database', () => db.query('SELECT 1'));

  const failed = Object.values(checks).filter((c) => c.status !== 'up');
  const status = failed.length === 0 ? 'ready' : 'not_ready';

  res.status(failed.length === 0 ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    checks
  });
});

/**
 * Runs a dependency check with a timeout so a hung dependency can't hang the probe.
 * Kept exported for use once real dependencies exist.
 */
async function probe(name, fn, timeoutMs = 2000) {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - start, error: err.message };
  }
}

module.exports = router;
module.exports.probe = probe;
