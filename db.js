// db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If needed, set SSL:
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});

export async function initDB() {
  const client = await pool.connect();
  try {
    // Create tables if they don't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        address VARCHAR(255),
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        token VARCHAR(255),
        expires_at TIMESTAMP
      );
    `);
  } finally {
    client.release();
  }
}

export async function query(q, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(q, params);
    return result;
  } finally {
    client.release();
  }
}
