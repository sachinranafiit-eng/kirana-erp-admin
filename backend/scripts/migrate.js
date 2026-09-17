const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');
async function migrate() {
  const exists = (await db.query("SELECT to_regclass('public.users') AS present")).rows[0].present;
  if (!exists) {
    for (const file of ['schema.sql','seed.sql','002_communications_and_store_schema.sql','002_communications_and_store_seed.sql']) {
      await db.execSql(fs.readFileSync(path.resolve(__dirname, '../../database', file), 'utf8'));
    }
  }
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
  for (const file of ['003_erp.sql','004_finish.sql']) {
    if (!(await db.query('SELECT 1 FROM schema_migrations WHERE name=$1',[file])).rows.length) {
      await db.execSql('BEGIN;\n' + fs.readFileSync(path.resolve(__dirname,'../../database',file),'utf8') + `\nINSERT INTO schema_migrations(name) VALUES ('${file}'); COMMIT;`);
    }
  }
}
module.exports = migrate;
if (require.main === module) migrate().then(() => db.pool.end()).catch(err => { console.error(err.message); process.exit(1); });
