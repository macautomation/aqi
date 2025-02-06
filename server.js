// server.js
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pkg from 'pg'; // use default import for CommonJS
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
import './auth.js'; // local, google, apple passport
import { fetchOpenWeather, fetchAirNowAQI, labelAirNowAQI, getWindStatus } from './weather.js';
import { scrapeFireAirnow, scrapeXappp, scrapeArcgis } from './scraping.js';
import { distanceMiles } from './utils.js';

// SendGrid
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Postgres pool for session store
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});
const PgSession = pgSession(session);

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// Session config
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

// Serve static from root (index.html) + /html
app.use(express.static(__dirname));

// Hide Google Places key with a small route
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

// Helper: Send email
async function sendEmail(to, subject, text) {
  const msg = {
    to,
    from: 'noreply@littlegiant.app',
    subject,
    text
  };
  await sgMail.send(msg);
}

// Password complexity
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
  if (!email || !password || !password2) {
    return res.status(400).send('All fields are required (email, password).');
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
    const hash = await bcrypt.hash(password, 10);

    // create user
    const result = await query(`
      INSERT INTO users (email, password_hash, latest_report)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [email, hash, JSON.stringify({})]);
    const newUserId = result.rows[0].id;

    // if user typed an address, store it (up to 1 here)
    if (address && address.trim()) {
      let lat = null, lon = null;
      if (process.env.GOOGLE_GEOCODE_KEY) {
        const geoURL = 'https://maps.googleapis.com/maps/api/geocode/json';
        // START DEBUG
        console.log('Geocoding address:', address);
        // END DEBUG
        const resp = await axios.get(geoURL, {
          params: { address, key: process.env.GOOGLE_GEOCODE_KEY }
        });
        // START DEBUG
        console.log('Geocode result:', JSON.stringify(resp.data));
        // END DEBUG

        if (resp.data.results?.length) {
          lat = resp.data.results[0].geometry.location.lat;
          lon = resp.data.results[0].geometry.location.lng;
        }
      }
      // Insert into user_addresses if lat/lon found or not
      await query(`
        INSERT INTO user_addresses (user_id, address, lat, lon)
        VALUES ($1, $2, $3, $4)
      `, [newUserId, address.trim(), lat, lon]);
    }

    // Send sign-up confirm email
    const dashLink = `${process.env.APP_URL || 'http://localhost:3000'}/html/dashboard.html`;
    await sendEmail(email, 'Welcome to AQI Updates',
      `Thanks for signing up!\nYour Dashboard:\n${dashLink}\nEnjoy!`);

    res.redirect('/html/login.html');
  } catch (err) {
    console.error('[POST /api/signup]', err);
    res.status(500).send('Error signing up');
  }
});

// ADD ADDRESS (max 3)
app.post('/api/add-address', ensureAuth, async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).send('No address provided');

  // check how many addresses user has
  const countRes = await query('SELECT COUNT(*) FROM user_addresses WHERE user_id=$1', [req.user.id]);
  const addressCount = parseInt(countRes.rows[0].count, 10);
  if (addressCount >= 3) {
    return res.status(400).send('Max 3 addresses allowed.');
  }

  let lat = null, lon = null;
  if (process.env.GOOGLE_GEOCODE_KEY) {
    // geocode
    const geoURL = 'https://maps.googleapis.com/maps/api/geocode/json';
    const resp = await axios.get(geoURL, {
      params: { address, key: process.env.GOOGLE_GEOCODE_KEY }
    });
    if (resp.data.results?.length) {
      lat = resp.data.results[0].geometry.location.lat;
      lon = resp.data.results[0].geometry.location.lng;
    }
  }
  await query(`
    INSERT INTO user_addresses (user_id, address, lat, lon)
    VALUES ($1, $2, $3, $4)
  `, [req.user.id, address.trim(), lat, lon]);

  res.redirect('/html/dashboard.html');
});

// DELETE ADDRESS
app.post('/api/delete-address', ensureAuth, async (req, res) => {
  const { addressId } = req.body;
  if (!addressId) return res.status(400).send('No addressId provided');
  // ensure user owns this address
  await query('DELETE FROM user_addresses WHERE id=$1 AND user_id=$2', [addressId, req.user.id]);
  res.redirect('/html/dashboard.html');
});

// LOGIN (Local)
app.post('/api/login',
  passport.authenticate('local', { failureRedirect: '/html/login.html' }),
  (req, res) => {
    res.redirect('/html/dashboard.html');
  }
);

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

// LOGOUT
app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/index.html');
  });
});

// GOOGLE OAUTH (Passport)
app.get('/auth/google', passport.authenticate('google', { scope: ['email','profile'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/html/login.html' }),
  (req, res) => res.redirect('/html/dashboard.html')
);

// APPLE OAUTH (Passport)
app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple', { failureRedirect: '/html/login.html' }),
  (req, res) => res.redirect('/html/dashboard.html')
);

// GET REPORT
app.get('/api/myReport', ensureAuth, async (req, res) => {
  // We'll load the user_addresses for this user
  const addrRes = await query('SELECT * FROM user_addresses WHERE user_id=$1', [req.user.id]);
  if (!addrRes.rows.length) {
    return res.json({ error: 'No addresses. Please add an address.' });
  }
  const addresses = addrRes.rows;

  // We'll create a single combined "report" from all addresses
  let combined = [];
  for (const row of addresses) {
    const lat = row.lat, lon = row.lon;
    if (!lat || !lon) {
      combined.push(`Address: ${row.address}\n(No lat/lon, cannot produce AQI)`);
      continue;
    }
    const aqi = await fetchAirNowAQI(lat, lon);
    const label = labelAirNowAQI(aqi);
    const ow = await fetchOpenWeather(lat, lon);

    const fireResult = await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
    const nearFire = fireResult?.nearFire || false;

    const xapppData = await scrapeXappp(lat, lon);
    const arcgisData = await scrapeArcgis(lat, lon);

    const windColor = getWindStatus(ow.windSpeed, ow.windDeg, nearFire);

    let lines = [];
    lines.push(`Address: ${row.address}`);
    lines.push(`**Average AQI**: ${aqi || 0} (${label})`);
    lines.push(`**Wind**: Speed=${ow.windSpeed}, Deg=${ow.windDeg}, Indicator=${windColor}`);
    if (xapppData) lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText || 'N/A'}`);
    if (arcgisData) lines.push(`ArcGIS: ${arcgisData.note}`);
    if (nearFire) lines.push(`Near fire boundary (<50 miles)`);
    combined.push(lines.join('\n'));
  }
  const finalReport = combined.join('\n\n');
  return res.json({ report: finalReport });
});

// MANUAL RECHECK
app.post('/api/report-now', ensureAuth, async (req, res) => {
  // same logic as /api/myReport, but also apply the 2/day limit if you prefer
  // For simplicity, we'll just call GET /api/myReport logic:
  const url = `${req.protocol}://${req.get('host')}/api/myReport`;
  try {
    const resp = await axios.get(url, {
      headers: { cookie: req.headers.cookie || '' }
    });
    if (resp.data.error) return res.status(400).json({ error: resp.data.error });
    return res.json({ report: resp.data.report });
  } catch (err) {
    console.error('[report-now error]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// CRON daily
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] daily triggered');
  try {
    // load all users
    const { rows:users } = await query('SELECT id, email FROM users');
    for (const user of users) {
      // find addresses
      const { rows:addresses } = await query('SELECT * FROM user_addresses WHERE user_id=$1', [user.id]);
      if (!addresses.length) {
        // no addresses => skip or send an email?
        console.log(`User ${user.email} has no addresses, skipping daily email.`);
        continue;
      }
      let combined = [];
      for (const row of addresses) {
        if (!row.lat || !row.lon) {
          combined.push(`Address: ${row.address}\n(No lat/lon)`);
          continue;
        }
        const aqi = await fetchAirNowAQI(row.lat, row.lon);
        const label = labelAirNowAQI(aqi);
        const ow = await fetchOpenWeather(row.lat, row.lon);

        const fireResult = await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
        const nearFire = fireResult?.nearFire || false;

        const xapppData = await scrapeXappp(row.lat, row.lon);
        const arcgisData = await scrapeArcgis(row.lat, row.lon);

        const windColor = getWindStatus(ow.windSpeed, ow.windDeg, nearFire);

        let lines = [];
        lines.push(`Address: ${row.address}`);
        lines.push(`**Average AQI**: ${aqi||0} (${label})`);
        lines.push(`**Wind**: Speed=${ow.windSpeed}, Deg=${ow.windDeg}, Indicator=${windColor}`);
        if (xapppData) lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText||'N/A'}`);
        if (arcgisData) lines.push(`ArcGIS: ${arcgisData.note}`);
        if (nearFire) lines.push(`Near fire boundary (<50 miles)`);
        combined.push(lines.join('\n'));
      }
      const finalReport = combined.join('\n\n');
      if (!finalReport) continue;

      await sendEmail(user.email, 'Your Daily AQI Update', finalReport);
      console.log(`Sent daily update to ${user.email}`);
    }
  } catch (err) {
    console.error('[CRON daily]', err);
  }
});

function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/html/login.html');
}

app.listen(process.env.PORT || 3000, async () => {
  await initDB();
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
