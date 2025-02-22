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
        latest_report TEXT,
        aqi_radius INT DEFAULT 5,
        daily_report_hour INT DEFAULT 8,
        daily_report_minute INT DEFAULT 0
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

    // Create user_addresses if missing
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        address TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION
      );
    `);

    // Add column for PurpleAir sensor IDs
    try {
      await client.query(`
        ALTER TABLE user_addresses
        ADD COLUMN IF NOT EXISTS purpleair_sensor_ids TEXT;
      `);
    } catch(e) {
      console.warn('[initDB] Could not add purpleair_sensor_ids column:', e.message);
    }

    // Create table for address_hourly_data
    await client.query(`
      CREATE TABLE IF NOT EXISTS address_hourly_data (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        address_id INT REFERENCES user_addresses(id),
        timestamp TIMESTAMP NOT NULL,
        source VARCHAR(50) NOT NULL,   -- 'AirNow', 'PurpleAir', 'OpenWeather'
        aqi_closest INT,
        aqi_average INT,
        data_json JSONB,
        UNIQUE (user_id, address_id, timestamp, source)
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
