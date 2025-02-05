// server.js
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import bodyParser from 'body-parser';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { initDB, query } from './db.js';
import './auth.js'; // loads passport strategies
import { parseAirNowFireUrl } from './utils.js';
import { fetchOpenWeather, fetchAirNowAQI, labelAirNowAQI } from './weather.js';
import { scrapeFireAirnow, scrapeXappp } from './scraping.js';
import { distanceMiles } from './utils.js';

// GEOCODING (Google)
import axios from 'axios';

// SendGrid for email
import sendgrid from 'sendgrid';
const sg = sendgrid(process.env.SENDGRID_API_KEY);

import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Node-cron
import cron from 'node-cron';

// ENV
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// session
app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Serve static
app.use(express.static(path.join(__dirname, 'views')));

// HELPER: sendEmail via SendGrid
function sendEmail(to, subject, text) {
  const request = sg.emptyRequest({
    method: 'POST',
    path: '/v3/mail/send',
    body: {
      personalizations: [{
        to: [{ email: to }],
        subject
      }],
      from: { email: 'noreply@yourapp.com' },
      content: [{
        type: 'text/plain',
        value: text
      }]
    }
  });
  return new Promise((resolve, reject) => {
    sg.API(request, function (error, response) {
      if (error) return reject(error);
      resolve(response);
    });
  });
}

// HOME
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// SIGNUP
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

app.post('/signup', async (req, res) => {
  const { email, password, address } = req.body;
  if (!email || !password || !address) return res.status(400).send('Missing fields');
  try {
    // Geocode address
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
  (req, res) => {
    res.redirect('/dashboard');
  }
);

// FORGOT
app.get('/forgot', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'forgot.html'));
});

app.post('/forgot', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send('No email provided');
  const { rows } = await query('SELECT id FROM users WHERE email=$1', [email]);
  if (!rows.length) {
    return res.send('If your account is found, a reset link is sent.');
  }
  const userId = rows[0].id;
  const token = crypto.randomBytes(20).toString('hex');
  const expires = new Date(Date.now() + 3600 * 1000); // 1 hr
  await query(`
    INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES ($1, $2, $3)
  `, [userId, token, expires]);
  const resetLink = `${APP_URL}/reset/${token}`;
  await sendEmail(email, 'Password Reset', `Click here: ${resetLink}`);
  res.send('If your account is found, a reset link has been emailed.');
});

// RESET
app.get('/reset/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'reset.html'));
});

app.post('/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).send('No password');
  const now = new Date();
  const { rows } = await query(`
    SELECT user_id FROM password_reset_tokens
    WHERE token=$1 AND expires_at > $2
  `, [token, now]);
  if (!rows.length) return res.status(400).send('Invalid or expired');
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
  // Hard-coded Payment Link
  res.redirect('https://donate.stripe.com/00g02da1bgwA5he5kk');
});

// DASHBOARD - user can see their most recent report
app.get('/dashboard', ensureAuthenticated, async (req, res) => {
  // load user from req.user
  // show them a page with latest_report
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/api/myReport', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { rows } = await query(`
    SELECT latest_report FROM users WHERE id=$1
  `, [userId]);
  if (!rows.length) return res.json({ error: 'No user' });
  const lr = rows[0].latest_report || '{}';
  res.json(JSON.parse(lr));
});

// CRON daily
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] daily triggered');
  try {
    const { rows } = await query('SELECT * FROM users');
    for (const user of rows) {
      if (!user.lat || !user.lon) {
        continue; // skip if no coords
      }
      const aqi = await fetchAirNowAQI(user.lat, user.lon);
      const aqiLabel = labelAirNowAQI(aqi);
      const openW = await fetchOpenWeather(user.lat, user.lon);

      // parse the "fire airnow" as an example:
      const fireResult = await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
      let windColor = 'Green';
      if (fireResult) {
        // placeholder logic
        windColor = (openW && openW.windSpeed > 5) ? 'Red' : 'Yellow';
      }

      // xappp
      const xapppData = await scrapeXappp(user.lat, user.lon);

      // average AQI (we only have 1 from AirNow for now)
      const avgAQI = aqi || 0;
      // The "Most Recent Wind Direction" in bold:
      const windDir = `Wind Speed: ${openW.windSpeed}, Deg: ${openW.windDeg}, Color: ${windColor}`;

      const lines = [];
      lines.push(`**Average AQI**: ${avgAQI} (${aqiLabel})`);
      lines.push(`**Most Recent Wind Direction**: ${windDir}`);
      if (xapppData) {
        lines.push(`xappp station: ${xapppData.station}, AQI: ${xapppData.aqiText}`);
      }
      if (fireResult && fireResult.nearFire) {
        lines.push(`You are near a fire boundary (~${fireResult.fireDist.toFixed(1)} miles)`);
      }

      const report = lines.join('\n');
      // store into user.latest_report
      await query('UPDATE users SET latest_report=$1 WHERE id=$2', [JSON.stringify({ report }), user.id]);

      // send email
      await sendEmail(user.email, 'Your Daily Air Update', report);
      console.log(`Sent daily update to ${user.email}`);
    }
  } catch (err) {
    console.error('[CRON daily] error', err);
  }
});

// helper
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// LISTEN
app.listen(PORT, async () => {
  await initDB();
  console.log(`Server running on ${PORT}, app url: ${APP_URL}`);
});
