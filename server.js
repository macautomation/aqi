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
import axios from 'axios';

import { initDB, query } from './db.js';
import './auth.js'; // local, google, apple passport
import { fetchOpenWeather, fetchAirNowAQI, labelAirNowAQI, getWindStatus } from './weather.js';
import { scrapeFireAirnow, scrapeXappp, scrapeArcgis } from './scraping.js';
import { distanceMiles } from './utils.js';

// SendGrid
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

// Session store
app.use(session({
  store: new PgSession({ pool }),
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Serve static from root. index.html stays in root, others in /html
app.use(express.static(__dirname));

// Helper: sendEmail
async function sendEmail(to, subject, text) {
  const msg = {
    to,
    from: 'noreply@littlegiant.app',
    subject,
    text
  };
  await sgMail.send(msg);
}

/* ========================================
   Password & Account Helpers
   ======================================== */
function isPasswordComplex(password) {
  // Example policy: >=8 chars, 1 digit, 1 letter, 1 special char
  if (password.length < 8) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

/* ========================================
   Routes
   ======================================== */

// SIGNUP
app.post('/api/signup', async (req, res) => {
  const { email, password, password2, address } = req.body;
  if (!email || !password || !password2 || !address) {
    return res.status(400).send('All fields are required.');
  }
  if (password !== password2) {
    return res.status(400).send('Passwords do not match.');
  }
  if (!isPasswordComplex(password)) {
    return res.status(400).send('Password not complex enough (>=8 chars, digit, letter, special char).');
  }

  try {
    // Geocode address if we have Google key
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

    // Hash
    const hash = await bcrypt.hash(password, 10);
    // Track manual request usage
    // We'll store manualRequests in JSON for simplicity: { "count": 0, "resetAt": <timestamp> }
    await query(`
      INSERT INTO users (email, password_hash, address, lat, lon, latest_report)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [email, hash, address, lat, lon, JSON.stringify({
      manualRequests: { count: 0, resetAt: null }
    })]);

    // redirect to login
    res.redirect('/html/login.html');
  } catch (err) {
    console.error('[POST /api/signup]', err);
    res.status(500).send('Error signing up');
  }
});

// LOGIN (Local)
app.post('/api/login',
  passport.authenticate('local', { failureRedirect: '/html/login.html' }),
  (req, res) => {
    res.redirect('/html/dashboard.html');
  }
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
  await sendEmail(email, 'Password Reset', `Click here: ${link}`);
  res.send('If your account is found, a reset link is emailed.');
});

// RESET
app.post('/api/reset', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).send('Missing token or newPassword');
  if (!isPasswordComplex(newPassword)) {
    return res.status(400).send('New password not complex enough.');
  }
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

// DELETE ACCOUNT
app.post('/api/delete-account', ensureAuth, async (req, res) => {
  // Actually remove user from DB
  const userId = req.user.id;
  await query('DELETE FROM users WHERE id=$1', [userId]);
  // logout
  req.logout(() => {
    res.redirect('/index.html');
  });
});

// DONATION
app.post('/api/donate-now', (req, res) => {
  res.redirect('https://donate.stripe.com/00g02da1bgwA5he5kk');
});

/* ================ OAUTH ROUTES ================ */
app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/html/login.html' }),
  (req, res) => res.redirect('/html/dashboard.html')
);

app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple', { failureRedirect: '/html/login.html' }),
  (req, res) => res.redirect('/html/dashboard.html')
);

/* =============== DASHBOARD API =============== */
app.get('/api/myReport', ensureAuth, async (req, res) => {
  const { rows } = await query('SELECT latest_report FROM users WHERE id=$1', [req.user.id]);
  if (!rows.length) return res.json({ error: 'No user found' });
  const lr = rows[0].latest_report || '{}';
  res.json(JSON.parse(lr));
});

// Trigger immediate report (limited 2 times per 24 hours)
app.post('/api/report-now', ensureAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT latest_report, lat, lon FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(400).json({ error: 'No user found' });

    const user = rows[0];
    let lr = user.latest_report ? JSON.parse(user.latest_report) : {};
    let manReq = lr.manualRequests || { count: 0, resetAt: null };

    // Check if we should reset count
    const now = Date.now();
    if (manReq.resetAt && now > manReq.resetAt) {
      manReq.count = 0;
      manReq.resetAt = null;
    }
    if (manReq.count >= 2) {
      return res.status(429).json({ error: 'Max 2 manual updates in 24 hours reached.' });
    }

    // If lat/lon missing => can't do a report
    if (!user.lat || !user.lon) {
      return res.status(400).json({ error: 'No lat/lon for user.' });
    }

    // Update manualRequests
    manReq.count += 1;
    if (manReq.count === 1) {
      // first time => set resetAt for 24 hours
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
    if (xapppData) {
      lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText || 'N/A'}`);
    }
    if (arcgisData) {
      lines.push(`ArcGIS: ${arcgisData.note}`);
    }
    if (nearFire) {
      lines.push(`You are near a fire boundary (within 50 miles)`);
    }

    const reportStr = lines.join('\n');
    // Save
    lr.report = reportStr;
    lr.manualRequests = manReq;

    await query('UPDATE users SET latest_report=$1 WHERE id=$2', [JSON.stringify(lr), req.user.id]);
    return res.json({ report: reportStr });
  } catch (err) {
    console.error('[POST /api/report-now]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* =============== CRON (daily) =============== */
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] daily triggered');
  try {
    const { rows } = await query('SELECT * FROM users');
    for (const u of rows) {
      if (!u.lat || !u.lon) continue;
      let lr = u.latest_report ? JSON.parse(u.latest_report) : {};
      if (!lr.manualRequests) {
        lr.manualRequests = { count: 0, resetAt: null };
      }

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
      if (xapppData) {
        lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText || 'N/A'}`);
      }
      if (arcgisData) {
        lines.push(`ArcGIS: ${arcgisData.note}`);
      }
      if (nearFire) {
        lines.push(`You are near a fire boundary (within 50 miles)`);
      }
      const reportStr = lines.join('\n');
      lr.report = reportStr;

      // Save back
      await query('UPDATE users SET latest_report=$1 WHERE id=$2', [JSON.stringify(lr), u.id]);

      // Email
      await sendEmail(u.email, 'Your Daily Air Update', reportStr);
      console.log(`Sent daily update to ${u.email}`);
    }
  } catch (err) {
    console.error('[CRON daily]', err);
  }
});

// Ensure user is authenticated
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/html/login.html');
}

app.listen(process.env.PORT || 3000, async () => {
  await initDB();
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
