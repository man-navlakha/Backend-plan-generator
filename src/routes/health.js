const express = require('express');
const { db: transitDb } = require('../db');
const { db: radioDb } = require('../radio-db');

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

// Readiness includes the SQLite dependency used by the transit catalog.
router.get('/ready', async (req, res) => {
  const checks = {
    transitDatabase: await probe('transit database', () => transitDb.prepare('SELECT 1').get()),
    radioDatabase: await probe('radio database', () => radioDb.prepare('SELECT 1').get())
  };

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
 * Exported for any future dependency probes.
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
