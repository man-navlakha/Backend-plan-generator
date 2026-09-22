const express = require('express');
const { db: transitDb } = require('../db');
const { db: radioDb } = require('../radio-db');
const { db: cinemaDb } = require('../cinema-db');
const { db: otherMastersDb } = require('../other-masters-db');
const planStorage = require('../storage/appwrite');
const pg = require('../pg');

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

// Readiness checks every master database used by the catalogs.
router.get('/ready', async (req, res) => {
  /*
   * The SQLite catalogs are legacy: they back the read-only browse routes under
   * /api/*, and the plan generator does not touch them. They are built from the
   * Excel masters, which are not all in the repository, so a deployment that
   * never builds them is a correct deployment -- not a broken one.
   *
   * So a missing catalog is reported as `not_built`, like an unconfigured
   * dependency, and does not make the service unready. A catalog that exists but
   * fails to answer is still `down`, because that is a real fault.
   */
  const checks = {
    transitDatabase: await sqliteProbe('transit', transitDb),
    radioDatabase: await sqliteProbe('radio', radioDb),
    cinemaDatabase: await sqliteProbe('cinema', cinemaDb),
    otherMastersDatabase: await sqliteProbe('other masters', otherMastersDb)
  };

  // Postgres holds the unified master and every generated plan. Like storage,
  // it is only a readiness condition once a connection string exists, so the
  // SQLite-only local setup still reports ready.
  checks.postgres = pg.isConfigured()
    ? await probe('postgres', () => pg.ping(), 5000)
    : { status: 'not_configured', missing: ['DB_URL'] };

  // Plan storage is only a readiness condition once it is configured. A local
  // run with no Appwrite credentials is still ready to serve the catalogs.
  checks.planStorage = planStorage.isConfigured()
    ? await probe('plan storage bucket', () => planStorage.ping(), 4000)
    : { status: 'not_configured', missing: planStorage.missingConfig() };

  const failed = Object.values(checks).filter(
    (c) => !['up', 'not_configured', 'not_built'].includes(c.status)
  );
  const status = failed.length === 0 ? 'ready' : 'not_ready';

  res.status(failed.length === 0 ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    checks
  });
});

/**
 * A SQLite catalog check that tells "never built" apart from "broken".
 *
 * better-sqlite3 opens with fileMustExist in read-only mode, so an absent
 * catalog surfaces as an ENOENT-flavoured error on the first query rather than
 * at require time. That is the signal used here.
 */
async function sqliteProbe(name, handle) {
  const result = await probe(`${name} database`, () => handle.prepare('SELECT 1').get());

  // better-sqlite3 words this several ways depending on whether the file or its
  // parent directory is missing, and Vercel hits the directory case ("Cannot
  // open database because the directory does not exist"). All of them mean the
  // same thing: the catalog was never built here.
  const ABSENT = /unable to open|cannot open database|no such file|does not exist|ENOENT/i;

  if (result.status === 'down' && ABSENT.test(result.error || '')) {
    return {
      status: 'not_built',
      note: `The ${name} SQLite catalog was not built on this host. The plan generator does not need it.`
    };
  }
  return result;
}

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
