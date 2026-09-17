const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const embedded = process.env.DB_DRIVER === 'pglite';
let pg, queue = Promise.resolve();
function serial(fn) { const task = queue.then(fn); queue = task.catch(() => {}); return task; }
if (embedded) {
  const { PGlite } = require('@electric-sql/pglite');
  const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
  // Keep the embedded database separate from any PostgreSQL cluster that
  // may already exist in the project data directory.
  const dataPath = process.env.DB_PATH || path.resolve(__dirname, '../../../data/kirana-pglite');
  if (!dataPath.startsWith('memory://')) fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  pg = new PGlite(dataPath, { extensions: { pg_trgm } });
} else {
  const { Pool } = require('pg');
  pg = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 20
  });
  pg.on('error', err => console.error('Database connection error:', err.message));
}
function normalize(r) { return { ...r, rowCount: r.rowCount ?? r.affectedRows ?? r.rows?.length ?? 0 }; }
async function query(text, params) {
  if (!embedded) return pg.query(text, params);
  return serial(async () => normalize(await pg.query(text, params)));
}
async function withTransaction(fn) {
  if (embedded) return serial(() => pg.transaction(tx => fn({ query: async (sql, params) => normalize(await tx.query(sql, params)) })));
  const client = await pg.connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}
async function execSql(sql) {
  if (embedded) return serial(() => pg.exec(sql.replace(/CREATE EXTENSION IF NOT EXISTS "pgcrypto";[^\n]*/g, '')));
  return pg.query(sql);
}
async function runSqlFile(relativePath) { await execSql(fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8')); await end(); }
async function end() { await queue; return embedded ? pg.close() : pg.end(); }
module.exports = { query, withTransaction, execSql, runSqlFile, pool: { query, end }, embedded };
