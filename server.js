// server.js
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pkg from 'pg'; // Use default import for CommonJS
const { Pool } = pkg;
import passport from 'passport';
import bodyParser from 'body-parser';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import axios from 'axios';

import { initDB, query } from './db.js';
import './auth.js'; // local, google, apple passport (still present if you want to use them)
import { fetchOpenWeather, fetchAirNowAQI, labelAirNowAQI, getWindStatus } from './weather.js';
import { scrapeFireAirnow, scrapeXappp, scrapeArcgis } from './scraping.js';
import { distanceMiles } from './utils.js';

// SendGrid for emails
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

// Node & path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Postgres pool for sessions
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});
const PgSession = pgSession(session);

// Express
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// Session with PG store, auto-create session table if missing
app.use(session({
  store: new PgSession({
    pool,
    createTableIfMissing: true 
  }),
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Serve static files from root + /html folder
app.use(express.static(__dirname));

/**
 * Hide your Google Places key in a small JS route
 */
app.get('/js/autocomplete.js', (req, res) => {
  const key = process.env.GOOGLE_GEOCODE_KEY || '';
  const content = `
    function loadGooglePlaces() {
      var script = document.createElement('script');
      script.src = "https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=initAutocomplete";
      document.head.appendChild(script);
    }
    function initAutocomplete() {
      var input = document.getElementById('addressInput');
      if (!input) return;
      new google.maps.places.Autocomplete(input);
    }
    window.onload = loadGooglePlaces;
  `;
  res.setHeader('Content-Type', 'application/javascript');
  res.send(content);
});

// Helper: Send email with SendGrid
async function sendEmail(to, subject, text) {
  const msg = { to, from: 'noreply@littlegiant.app', subject, text };
  await sgMail.send(msg);
}

// Simple password complexity
function isPasswordComplex(password) {
  if (password.length < 8) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

// SIGN UP 
app.post('/api/signup', async (req, res) => {
  const { email, password, password2, address, agreePolicy, agreeTerms } = req.body;
  if (!email || !password || !password2 || !address) {
    return res.status(400).send('All fields are required.');
  }
  if (!agreePolicy || !agreeTerms) {
    return res.status(400).send('You must accept the privacy policy & terms.');
  }
  if (password !== password2) {
    return res.status(400).send('Passwords do not match.');
  }
  if (!isPasswordComplex(password)) {
    return res.status(400).send('Password not complex enough (>=8 chars, digit, letter, special char).');
  }

  try {
    let lat = null, lon = null;
    if (process.env.GOOGLE_GEOCODE_KEY) {
      const geoURL = 'https://maps.googleapis.com/maps/api/geocode/json';
      const resp = await axios.get(geoURL, {
        params: { address, key: process.env.GOOGLE_GEOCODE_KEY }
      });
      if (resp.data.results?.length) {
        lat = resp.data.results[0].geometry.location.lat;
        lon = resp.data.results[0].geometry.location.lng;
      }
    }
    const hash = await bcrypt.hash(password, 10);

    // Store initial manualRequests usage
    await query(`
      INSERT INTO users (email, password_hash, address, lat, lon, latest_report)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [email, hash, address, lat, lon, JSON.stringify({
      manualRequests: { count: 0, resetAt: null }
    })]);

    // Confirmation email
    const dashLink = `${process.env.APP_URL || 'http://localhost:3000'}/html/dashboard.html`;
    await sendEmail(email, 'Welcome to AQI Updates',
      `Thanks for signing up!\n\nVisit your dashboard here:\n${dashLink}\nEnjoy!`);

    res.redirect('/html/login.html');
  } catch (err) {
    console.error('[POST /api/signup]', err);
    res.status(500).send('Error signing up');
  }
});

// LOGIN (Local)
app.post('/api/login',
  passport.authenticate('local', { failureRedirect: '/html/login.html' }),
  (req, res) => res.redirect('/html/dashboard.html')
);

// LOGOUT
app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/index.html');
  });
});

// FORGOT
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

  const link = `${process.env.APP_URL || 'http://localhost:3000'}/html/reset.html?token=${token}`;
  await sendEmail(email, 'Password Reset', `Click here to reset:\n${link}`);
  res.send('If your account is found, a reset link is emailed.');
});

// RESET
app.post('/api/reset', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).send('Missing token or newPassword');
  }
  if (!isPasswordComplex(newPassword)) {
    return res.status(400).send('New password not complex enough.');
  }
  const now = new Date();
  const { rows } = await query(`
    SELECT user_id FROM password_reset_tokens
    WHERE token=$1 AND expires_at > $2
  `, [token, now]);
  if (!rows.length) return res.status(400).send('Invalid or expired token');

  const userId = rows[0].user_id;
  const hash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
  await query('DELETE FROM password_reset_tokens WHERE token=$1', [token]);
  res.send('Password reset. <a href="login.html">Log in</a>');
});

// DELETE ACCOUNT
app.post('/api/delete-account', ensureAuth, async (req, res) => {
  const userId = req.user.id;
  await query('DELETE FROM users WHERE id=$1', [userId]);
  req.logout(() => {
    res.redirect('/index.html');
  });
});

// DONATION
app.post('/api/donate-now', (req, res) => {
  res.redirect('https://donate.stripe.com/00g02da1bgwA5he5kk');
});

/** 
 * Google Identity / Apple sign-in are now done 
 * in front-end (GSI snippet / Apple snippet).
 * The old '/auth/google' or '/auth/apple' routes 
 * remain if needed for a different approach.
 * 
 * If you want to remove them completely, 
 * remove the passport code in auth.js / these routes.
 */

// CURRENT REPORT
app.get('/api/myReport', ensureAuth, async (req, res) => {
  const { rows } = await query('SELECT latest_report FROM users WHERE id=$1', [req.user.id]);
  if (!rows.length) return res.json({ error: 'No user found' });
  const lr = rows[0].latest_report || '{}';
  res.json(JSON.parse(lr));
});

// TRIGGER IMMEDIATE REPORT (2x / 24hr limit)
app.post('/api/report-now', ensureAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT latest_report, lat, lon FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(400).json({ error: 'No user found' });

    const user = rows[0];
    let lr = user.latest_report ? JSON.parse(user.latest_report) : {};
    let manReq = lr.manualRequests || { count: 0, resetAt: null };

    const now = Date.now();
    if (manReq.resetAt && now > manReq.resetAt) {
      manReq.count = 0;
      manReq.resetAt = null;
    }
    if (manReq.count >= 2) {
      return res.status(429).json({ error: 'Max 2 manual updates in 24 hours reached.' });
    }
    if (!user.lat || !user.lon) {
      return res.status(400).json({ error: 'No lat/lon for user.' });
    }

    manReq.count += 1;
    if (manReq.count === 1) {
      manReq.resetAt = now + (24 * 3600 * 1000);
    }

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
    if (xapppData) lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText || 'N/A'}`);
    if (arcgisData) lines.push(`ArcGIS: ${arcgisData.note}`);
    if (nearFire) lines.push(`You are near a fire boundary (within 50 miles)`);

    const reportStr = lines.join('\n');
    lr.report = reportStr;
    lr.manualRequests = manReq;

    await query('UPDATE users SET latest_report=$1 WHERE id=$2', [JSON.stringify(lr), req.user.id]);
    res.json({ report: reportStr });
  } catch (err) {
    console.error('[POST /api/report-now]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// CRON daily (8 AM)
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] daily triggered');
  try {
    const { rows } = await query('SELECT * FROM users');
    for (const u of rows) {
      if (!u.lat || !u.lon) continue;
      let lr = u.latest_report ? JSON.parse(u.latest_report) : {};
      if (!lr.manualRequests) lr.manualRequests = { count: 0, resetAt: null };

      const aqi = await fetchAirNowAQI(u.lat, u.lon);
      const label = labelAirNowAQI(aqi);
      const ow = await fetchOpenWeather(u.lat, u.lon);

      const fireResult = await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
      const nearFire = fireResult?.nearFire || false;

      const xapppData = await scrapeXappp(u.lat, u.lon);
      const arcgisData = await scrapeArcgis(u.lat, u.lon);
      const windColor = getWindStatus(ow.windSpeed, ow.windDeg, nearFire);

      const lines = [];
      lines.push(`**Average AQI**: ${aqi || 0} (${label})`);
      lines.push(`**Most Recent Wind**: Speed=${ow.windSpeed}, Deg=${ow.windDeg}, Indicator=${windColor}`);
      if (xapppData) lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText || 'N/A'}`);
      if (arcgisData) lines.push(`ArcGIS: ${arcgisData.note}`);
      if (nearFire) lines.push(`You are near a fire boundary (within 50 miles)`);

      const reportStr = lines.join('\n');
      lr.report = reportStr;

      await query('UPDATE users SET latest_report=$1 WHERE id=$2', [JSON.stringify(lr), u.id]);
      await sendEmail(u.email, 'Your Daily Air Update', reportStr);
      console.log(`Sent daily update to ${u.email}`);
    }
  } catch (err) {
    console.error('[CRON daily]', err);
  }
});

// Ensure user is logged in
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/html/login.html');
}

app.listen(process.env.PORT || 3000, async () => {
  await initDB();
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
