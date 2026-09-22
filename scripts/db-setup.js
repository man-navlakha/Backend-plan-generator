/**
 * Applies db/schema.sql.
 *
 * Every statement is CREATE ... IF NOT EXISTS, so this is safe to run against a
 * database that already has the schema. It does not drop anything and it does
 * not migrate existing columns -- for a real column change, add a numbered file
 * under db/migrations/ and apply it deliberately.
 *
 *   node --env-file=.env scripts/db-setup.js
 */

const fs = require('fs');
const path = require('path');
const { query, close } = require('../src/pg');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

async function main() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  console.log(`Applying ${path.relative(process.cwd(), SCHEMA_PATH)} ...`);

  // One call: the whole file runs in a single implicit transaction, so a typo
  // halfway down leaves nothing half-created.
  await query(sql);

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
