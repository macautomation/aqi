// server.js
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';
import passport from 'passport';
import bodyParser from 'body-parser';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

import { initDB, query } from './db.js';
import './auth.js'; // local, google, apple passport strategies
import { fetchOpenWeather, fetchAirNowAQI, labelAirNowAQI, getWindStatus } from './weather.js';
import { scrapeFireAirnow, scrapeXappp, scrapeArcgis } from './scraping.js';
import { distanceMiles } from './utils.js';
import axios from 'axios';

// SendGrid
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

// Node / path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Postgres pool to reuse for sessions
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});
const PgSession = pgSession(session);

// Express
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// Session with Postgres store
app.use(session({
  store: new PgSession({ pool }), // store sessions in Postgres
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Serve static .html files from the root directory
// so e.g. /index.html, /signup.html, /login.html, etc.
app.use(express.static(__dirname));

// Quick helper to send email with SendGrid
async function sendEmail(to, subject, text) {
  const msg = {
    to,
    from: 'noreply@yourapp.com',
    subject,
    text
  };
  await sgMail.send(msg);
}

/* =========================================
   ROUTES: now /api/... for form submissions
   ========================================= */

// SIGNUP (POST /api/signup)
app.post('/api/signup', async (req, res) => {
  const { email, password, address } = req.body;
  if (!email || !password || !address) return res.status(400).send('Missing fields');
  try {
    let lat = null, lon = null;
    if (process.env.GOOGLE_GEOCODE_KEY) {
      const geoURL = 'https://maps.googleapis.com/maps/api/geocode/json';
      const resp = await axios.get(geoURL, {
        params: { address, key: process.env.GOOGLE_GEOCODE_KEY }
      });
      if (resp.data.results && resp.data.results.length) {
        lat = resp.data.results[0].geometry.location.lat;
        lon = resp.data.results[0].geometry.location.lng;
      }
    }
    const hash = await bcrypt.hash(password, 10);
    await query(`
      INSERT INTO users (email, password_hash, address, lat, lon)
      VALUES ($1, $2, $3, $4, $5)
    `, [email, hash, address, lat, lon]);
    // redirect to login.html
    res.redirect('/login.html');
  } catch (err) {
    console.error('[POST /api/signup]', err);
    res.status(500).send('Error signing up');
  }
});

// LOGIN (POST /api/login)
app.post('/api/login',
  passport.authenticate('local', { failureRedirect: '/login.html' }),
  (req, res) => {
    res.redirect('/dashboard.html');
  }
);

// FORGOT (POST /api/forgot)
app.post('/api/forgot', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send('No email');
  const { rows } = await query('SELECT id FROM users WHERE email=$1', [email]);
  if (!rows.length) {
    return res.send('If your account is found, a reset link is sent.');
  }
  const userId = rows[0].id;
  const token = crypto.randomBytes(20).toString('hex');
  const expires = new Date(Date.now() + 3600 * 1000);
  await query(`
    INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES ($1, $2, $3)
  `, [userId, token, expires]);
  const link = `${process.env.APP_URL || 'http://localhost:3000'}/reset.html?token=${token}`;
  await sendEmail(email, 'Password Reset', `Click here: ${link}`);
  res.send('If your account is found, a reset link is emailed.');
});

// RESET (POST /api/reset)
app.post('/api/reset', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token) return res.status(400).send('No token');
  const now = new Date();
  const { rows } = await query(`
    SELECT user_id FROM password_reset_tokens
    WHERE token=$1 AND expires_at > $2
  `, [token, now]);
  if (!rows.length) return res.status(400).send('Invalid/expired token');

  const userId = rows[0].user_id;
  const hash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
  await query('DELETE FROM password_reset_tokens WHERE token=$1', [token]);
  res.send('Password reset. <a href="login.html">Log in</a>');
});

// DONATION
app.post('/api/donate-now', (req, res) => {
  // redirect to stripe link
  res.redirect('https://donate.stripe.com/00g02da1bgwA5he5kk');
});

/* ====================
   OAUTH ROUTES
   ==================== */
app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    res.redirect('/dashboard.html');
  }
);

app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple', { failureRedirect: '/login.html' }),
  (req, res) => res.redirect('/dashboard.html')
);

/* ============================
   DASHBOARD - AJAX endpoint
   ============================ */
app.get('/api/myReport', ensureAuth, async (req, res) => {
  const { rows } = await query('SELECT latest_report FROM users WHERE id=$1', [req.user.id]);
  if (!rows.length) return res.json({ error: 'No user found' });
  const lr = rows[0].latest_report || '{}';
  res.json(JSON.parse(lr));
});

function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login.html');
}

/* =====================
   CRON daily job
   ===================== */
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] daily triggered');
  try {
    const { rows } = await query('SELECT * FROM users');
    for (const user of rows) {
      if (!user.lat || !user.lon) continue;
      const aqi = await fetchAirNowAQI(user.lat, user.lon);
      const label = labelAirNowAQI(aqi);
      const ow = await fetchOpenWeather(user.lat, user.lon);

      const fireResult = await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
      const nearFire = fireResult?.nearFire || false;

      const xapppData = await scrapeXappp(user.lat, user.lon);
      const arcgisData = await scrapeArcgis(user.lat, user.lon);

      const windColor = getWindStatus(ow.windSpeed, ow.windDeg, nearFire);

      const lines = [];
      lines.push(`**Average AQI**: ${aqi || 0} (${label})`);
      lines.push(`**Most Recent Wind**: Speed=${ow.windSpeed}, Deg=${ow.windDeg}, Indicator=${windColor}`);
      if (xapppData) {
        lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText || 'N/A'}`);
      }
      if (arcgisData) {
        lines.push(`ArcGIS: ${arcgisData.note}`);
      }
      if (nearFire) {
        lines.push(`You are near a fire boundary (within 50 miles)`);
      }

      const report = lines.join('\n');
      await query('UPDATE users SET latest_report=$1 WHERE id=$2', [JSON.stringify({ report }), user.id]);

      await sendEmail(user.email, 'Your Daily Air Update', report);
      console.log(`Sent daily update to ${user.email}`);
    }
  } catch (err) {
    console.error('[CRON daily]', err);
  }
});

app.listen(process.env.PORT || 3000, async () => {
  await initDB();
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
