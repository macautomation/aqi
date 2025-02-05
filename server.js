// server.js
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import bodyParser from 'body-parser';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { initDB, query } from './db.js';
import './auth.js'; // loads passport strategies
import { fetchOpenWeather, fetchAirNowAQI, labelAirNowAQI, getWindStatus } from './weather.js';
import { scrapeFireAirnow, scrapeXappp, scrapeArcgis } from './scraping.js';
import { distanceMiles } from './utils.js';
import axios from 'axios';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';

// SendGrid
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, 'views')));

// Helper to send email
async function sendEmail(to, subject, text) {
  const msg = {
    to,
    from: 'noreply@yourapp.com',
    subject,
    text
  };
  await sgMail.send(msg);
}

// HOME
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// SIGNUP (Local)
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

app.post('/signup', async (req, res) => {
  const { email, password, address } = req.body;
  if (!email || !password || !address) return res.status(400).send('Missing fields');
  try {
    let lat = null, lon = null;
    if (process.env.GOOGLE_GEOCODE_KEY) {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json';
      const resp = await axios.get(url, {
        params: {
          address,
          key: process.env.GOOGLE_GEOCODE_KEY
        }
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
    res.redirect('/login');
  } catch (err) {
    console.error('[POST /signup]', err);
    res.status(500).send('Error signing up');
  }
});

// LOGIN
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login',
  passport.authenticate('local', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/dashboard')
);

// FORGOT
app.get('/forgot', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'forgot.html'));
});

app.post('/forgot', async (req, res) => {
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
  const link = `${APP_URL}/reset/${token}`;
  await sendEmail(email, 'Password Reset', `Click here: ${link}`);
  res.send('If your account is found, a reset link is emailed.');
});

// RESET
app.get('/reset/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'reset.html'));
});

app.post('/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { newPassword } = req.body;
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
  res.send('Password reset. <a href="/login">Log in</a>');
});

// GOOGLE
app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/dashboard')
);

// APPLE
app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/dashboard')
);

// DONATION
app.get('/donation', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'donation.html'));
});

app.post('/donate-now', (req, res) => {
  res.redirect('https://donate.stripe.com/00g02da1bgwA5he5kk');
});

// DASHBOARD
app.get('/dashboard', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/api/myReport', ensureAuth, async (req, res) => {
  const { rows } = await query('SELECT latest_report FROM users WHERE id=$1', [req.user.id]);
  if (!rows.length) return res.json({ error: 'No user found' });
  const lr = rows[0].latest_report || '{}';
  res.json(JSON.parse(lr));
});

// CRON daily job (8 AM)
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] daily triggered');
  try {
    const { rows } = await query('SELECT * FROM users');
    for (const user of rows) {
      if (!user.lat || !user.lon) continue;
      const aqi = await fetchAirNowAQI(user.lat, user.lon);
      const label = labelAirNowAQI(aqi);
      const ow = await fetchOpenWeather(user.lat, user.lon);

      // Fire AirNow
      const fireResult = await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
      const nearFire = fireResult && fireResult.nearFire;

      // XAPPP
      const xapppData = await scrapeXappp(user.lat, user.lon);
      // ArcGIS
      const arcgisData = await scrapeArcgis(user.lat, user.lon);

      const windColor = getWindStatus(ow.windSpeed, ow.windDeg, nearFire);

      // Construct report
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

// helper
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// START
app.listen(PORT, async () => {
  await initDB();
  console.log(`Server on ${PORT}, url=${APP_URL}`);
});
