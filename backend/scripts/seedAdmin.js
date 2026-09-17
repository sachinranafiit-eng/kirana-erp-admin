/* eslint-disable no-console */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/db');

async function main() {
  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be set to a strong password of at least 12 characters.');
  }
  const fullName = process.env.SEED_ADMIN_NAME || 'Store Owner';
  const email = process.env.SEED_ADMIN_EMAIL || null;

  const role = await pool.query("SELECT id FROM roles WHERE name = 'super_admin'");
  if (!role.rows[0]) {
    throw new Error("Role 'super_admin' not found — run database/schema.sql and database/seed.sql first.");
  }

  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows[0]) {
    console.log(`User '${username}' already exists — nothing to do.`);
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (full_name, username, email, password_hash, role_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [fullName, username, email, passwordHash, role.rows[0].id]
  );

  console.log('Super admin created:');
  console.log(`  username: ${username}`);
  console.log('  password: supplied through SEED_ADMIN_PASSWORD (change this immediately after first login)');
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to seed admin user:', err.message);
  process.exit(1);
});
