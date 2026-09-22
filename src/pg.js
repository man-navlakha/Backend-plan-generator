/**
 * The Postgres pool.
 *
 * One pool per process, created lazily so a script that never touches the
 * database (the renderer fixtures, the rules validator) can still require this
 * module without a connection string in the environment.
 *
 *   DB_URL   postgresql://user:pass@host:port/db
 *
 * Pool size is deliberately small. On Vercel every warm lambda holds its own
 * pool, and Railway's Postgres caps connections well below what a dozen
 * lambdas with 10 sockets each would open.
 */

const { Pool } = require('pg');

let pool = null;

function isConfigured() {
  return Boolean(process.env.DB_URL);
}

function getPool() {
  if (!process.env.DB_URL) {
    throw new Error('DB_URL is not set. Copy .env.example to .env and fill it in.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DB_URL,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      // Railway terminates the public proxy connection without a clean FIN now
      // and then; without this the pool hands out a dead socket.
      keepAlive: true
    });
    // An idle client erroring out must not take the process down with it.
    pool.on('error', (err) => {
      console.error('[pg] idle client error:', err.message);
    });
  }
  return pool;
}

/** `query('select * from masters.products where id = $1', [id])` */
function query(text, params) {
  return getPool().query(text, params);
}

/** Rows only, for the common case. */
async function rows(text, params) {
  const result = await query(text, params);
  return result.rows;
}

/** First row or undefined. */
async function one(text, params) {
  const result = await query(text, params);
  return result.rows[0];
}

/**
 * Runs `fn` inside a transaction on a dedicated client, rolling back on throw.
 * The client is always released, including when the rollback itself fails.
 */
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[pg] rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Proves the database answers. Used by /health/ready. */
async function ping() {
  const row = await one('select current_database() as db, version() as version');
  return { database: row.db, version: row.version.split(' ').slice(0, 2).join(' ') };
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, rows, one, transaction, ping, close, isConfigured };
