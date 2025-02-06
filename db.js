// db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});

export async function initDB() {
  const client = await pool.connect();
  try {
    // Create 'users' if you haven't already:
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        address VARCHAR(255),
        -- We no longer rely on lat/lon here for multiple addresses
        latest_report TEXT
      );
    `);

    // Create table for password reset tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        token VARCHAR(255),
        expires_at TIMESTAMP
      );
    `);

    // Create a separate table for addresses
    // Each user can have up to 3 addresses
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        address TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION
      );
    `);

  } finally {
    client.release();
  }
}

export async function query(q, params) {
  const client = await pool.connect();
  try {
    return await client.query(q, params);
  } finally {
    client.release();
  }
}
