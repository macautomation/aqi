// auth.js
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import AppleStrategy from 'passport-apple';
import bcrypt from 'bcrypt';
import { query } from './db.js';

// Added for test
import app from "./server.js"; // Adjust the path based on your file structure

app.get('/debug/apple-jwt', (req, res) => {
    res.json({ message: "JWT Debugging Route Works!" });
});

/**
 * Local Strategy
 */
passport.use('local', new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) return done(null, false, { message: 'No user' });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return done(null, false, { message: 'Bad password' });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

/**
 * Google Strategy
 */
passport.use('google', new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: (process.env.APP_URL || 'http://localhost:3000') + '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    let { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) {
      // create user
      const insertRes = await query(`
        INSERT INTO users (email) VALUES ($1) RETURNING *
      `, [email]);
      rows = insertRes.rows;
    }
    return done(null, rows[0]);
  } catch (err) {
    done(err);
  }
}));

/**
 * Apple Strategy
 */
passport.use('apple', new AppleStrategy({
  clientID: process.env.APPLE_CLIENT_ID,
  teamID: process.env.APPLE_TEAM_ID,
  keyID: process.env.APPLE_KEY_ID,
  privateKeyString: process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  callbackURL: (process.env.APP_URL || 'http://localhost:3000') + '/auth/apple/callback',
  scope: ['name', 'email']
}, async (accessToken, refreshToken, idToken, profile, done) => {
  console.log("Access Token:", accessToken);
  console.log("ID Token:", idToken);
  console.log("Profile:", profile);

  if (!profile) {
    return done(new Error("Failed to retrieve profile from Apple"));
  }

  try {
    const email = profile.email || `noemail_${profile.id}@appleuser.com`;
    let { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) {
      const insertRes = await query(`
        INSERT INTO users (email) VALUES ($1) RETURNING *
      `, [email]);
      rows = insertRes.rows;
    }
    return done(null, rows[0]);
  } catch (err) {
    console.error("Database Error:", err);
    done(err);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id=$1', [id]);
    if (!rows.length) return done(null, false);
    done(null, rows[0]);
  } catch (err) {
    done(err);
  }
});

// Test JWT
import jwt from "jsonwebtoken";

app.get('/debug/apple-jwt', (req, res) => {
    try {
        const teamID = process.env.APPLE_TEAM_ID;
        const keyID = process.env.APPLE_KEY_ID;
        const clientID = process.env.APPLE_CLIENT_ID;
        const privateKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');

        const claims = {
            iss: teamID,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 86400 * 180, // 6 months
            aud: "https://appleid.apple.com",
            sub: clientID
        };

        const clientSecret = jwt.sign(claims, privateKey, {
            algorithm: "ES256",
            keyid: keyID,
        });

        res.json({ clientSecret }); // Return the generated JWT
    } catch (err) {
        console.error("JWT Error:", err);
        res.status(500).json({ error: err.message });
    }
});

