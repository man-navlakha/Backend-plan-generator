/**
 * Applies db/schema.sql.
 *
 * Every schema statement is CREATE ... IF NOT EXISTS, and idempotent numbered
 * migrations under db/migrations are then applied in filename order. This is
 * safe to rerun against an existing database and does not drop application data.
 *
 *   node --env-file=.env scripts/db-setup.js
 */

const fs = require('fs');
const path = require('path');
const { query, close } = require('../src/pg');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
const MIGRATIONS_PATH = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  console.log(`Applying ${path.relative(process.cwd(), SCHEMA_PATH)} ...`);

  // One call: the whole file runs in a single implicit transaction, so a typo
  // halfway down leaves nothing half-created.
  await query(sql);

  const migrations = fs.existsSync(MIGRATIONS_PATH)
    ? fs.readdirSync(MIGRATIONS_PATH).filter((name) => name.endsWith('.sql')).sort()
    : [];
  for (const name of migrations) {
    const filename = path.join(MIGRATIONS_PATH, name);
    console.log(`Applying ${path.relative(process.cwd(), filename)} ...`);
    await query(fs.readFileSync(filename, 'utf8'));
  }

  const { rows } = await query(`
    select table_schema, table_name
      from information_schema.tables
     where table_schema in ('masters','app')
     order by table_schema, table_name
  `);

  console.log(`\n${rows.length} tables:`);
  for (const row of rows) console.log(`  ${row.table_schema}.${row.table_name}`);
}

main()
  .then(() => close())
  .catch(async (error) => {
    console.error('\nFailed:', error.message);
    await close();
    process.exit(1);
  });
