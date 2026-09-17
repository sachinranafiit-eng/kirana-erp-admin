require('dotenv').config();
const db = require('./config/db');
const migrate = require('../scripts/migrate');
async function start() {
  for (const name of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','JWT_CUSTOMER_SECRET','SETUP_KEY']) {
    if (!process.env[name] || process.env[name].length < 16) throw new Error(name+' must be configured (use npm start from the project root for first setup)');
  }
  await migrate();
  const app = require('./app');
  const port = process.env.PORT || 4000;
  const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Kirana ERP: http://localhost:${port}`));
  if (!(await db.query('SELECT 1 FROM users LIMIT 1')).rows.length) console.log('First-time installation code:',process.env.SETUP_KEY);
  const close = () => server.close(async () => { await db.pool.end(); process.exit(0); });
  process.on('SIGINT',close); process.on('SIGTERM',close);
}
start().catch(err => { console.error('Startup failed:',err.message); process.exit(1); });
