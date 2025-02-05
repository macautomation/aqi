// server.js
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import bodyParser from 'body-parser';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { initDB, query } from './db.js';
import './auth.js'; // sets up passport strategies
import { getPurpleAirPM25, getAqrcData, getAqmdAqi, getArcgisData } from './scraping.js';
import { distanceMiles } from './utils.js';
import cron from 'node-cron';

// ENV
const PORT = process.env.PORT || 3000;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Serve static
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'views')));

// HOME
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// SIGNUP
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

app.post('/signup', async (req, res) => {
  try {
    const { email, password, address } = req.body;
    if (!email || !password || !address) return res.status(400).send('Missing fields');
    const hash = await bcrypt.hash(password, 10);
    // For now, lat/lon remain null until geocoding or you can do your own geocode approach
    await query(
      'INSERT INTO users (email, password_hash, address) VALUES ($1, $2, $3)',
      [email, hash, address]
    );
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
  passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login'
  })
);

// FORGOT PASSWORD
app.get('/forgot', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'forgot.html'));
});

app.post('/forgot', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send('No email provided');
  const { rows } = await query('SELECT id FROM users WHERE email=$1', [email]);
  if (!rows.length) {
    return res.send('If that email is registered, you will receive a reset link.');
  }
  const userId = rows[0].id;
  const token = crypto.randomBytes(20).toString('hex');
  const expires = new Date(Date.now() + 3600000); // 1 hour
  await query(`
    INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES ($1, $2, $3)
  `, [userId, token, expires]);
  const link = `${process.env.APP_URL || 'http://localhost:3000'}/reset/${token}`;
  await transporter.sendMail({
    from: `"Air Quality" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Password Reset',
    text: `Click here to reset: ${link}`
  });
  res.send('If your account is found, a reset link has been emailed.');
});

// RESET
app.get('/reset/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'reset.html'));
});

app.post('/reset/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;
    const now = new Date();
    const { rows } = await query(`
      SELECT user_id FROM password_reset_tokens
      WHERE token=$1 AND expires_at > $2
    `, [token, now]);
    if (!rows.length) return res.status(400).send('Token invalid or expired');

    const userId = rows[0].user_id;
    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
    await query('DELETE FROM password_reset_tokens WHERE token=$1', [token]);
    res.send('Password reset successful. <a href="/login">Log in</a>');
  } catch (err) {
    console.error('[POST /reset/:token]', err);
    res.status(500).send('Error resetting password');
  }
});

// GOOGLE OAUTH
app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/');
  }
);

// APPLE OAUTH
app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/');
  }
);

// DONATION (Stripe Payment Link)
app.get('/donation', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'donation.html'));
});

// If user wants to donate, we just redirect to your Payment Link
app.post('/donate-now', (req, res) => {
  res.redirect('https://donate.stripe.com/00g02da1bgwA5he5kk');
});

// CRON: daily job
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] daily triggered');
  try {
    const { rows } = await query('SELECT * FROM users');
    for (const user of rows) {
      // If lat/lon are null, skip or geocode them if needed
      // We'll gather data from scraping
      if (!user.lat || !user.lon) {
        continue;
      }
      const lines = [];
      // PurpleAir
      const pm = await getPurpleAirPM25(user.lat, user.lon);
      if (pm != null) lines.push(`PurpleAir PM2.5: ${pm}`);
      // aqrc
      const aqrc = await getAqrcData(user.lat, user.lon);
      if (aqrc) {
        lines.push(`(aqrc near ${aqrc.site} => lead=${aqrc.lead}, chlorine=${aqrc.chlorine}, bromine=${aqrc.bromine})`);
      }
      // xappp
      const aqmd = await getAqmdAqi(user.lat, user.lon);
      if (aqmd) {
        lines.push(`AQMD Station(${aqmd.station}): AQI=${aqmd.aqi}`);
      }
      // arcgis
      const arc = await getArcgisData(user.lat, user.lon);
      if (arc) {
        lines.push(`ArcGIS: ${JSON.stringify(arc)}`);
      }
      if (lines.length) {
        const msg = lines.join('\n');
        await transporter.sendMail({
          from: `"Air Updates" <${process.env.SMTP_USER}>`,
          to: user.email,
          subject: 'Your Daily Air Update',
          text: `Hello, your data:\n${msg}`
        });
        console.log(`Sent daily update to ${user.email}`);
      }
    }
  } catch (err) {
    console.error('[CRON daily] error', err);
  }
});

app.listen(PORT, async () => {
  await initDB();
  console.log(`Server running on port ${PORT}`);
});
