// auth.js
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import AppleStrategy from 'passport-apple';
import bcrypt from 'bcrypt';
import { query } from './db.js';

// 1) LOCAL STRATEGY
passport.use('local', new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) return done(null, false, { message: 'Unknown user' });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return done(null, false, { message: 'Bad password' });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

// 2) GOOGLE STRATEGY
passport.use('google', new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    let { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) {
      // create user
      const insertRes = await query(
        'INSERT INTO users (email) VALUES ($1) RETURNING *',
        [email]
      );
      rows = insertRes.rows;
    }
    return done(null, rows[0]);
  } catch (err) {
    done(err);
  }
}));

// 3) APPLE STRATEGY (stub)
passport.use('apple', new AppleStrategy({
  clientID: process.env.APPLE_CLIENT_ID || '',
  teamID: process.env.APPLE_TEAM_ID || '',
  keyID: process.env.APPLE_KEY_ID || '',
  privateKeyString: process.env.APPLE_PRIVATE_KEY || '',
  callbackURL: `${process.env.APP_URL || 'http://localhost:3000'}/auth/apple/callback`,
  scope: ['name', 'email']
}, async (accessToken, refreshToken, idToken, profile, done) => {
  try {
    // Apple may or may not provide an email.
    const email = profile.email || 'no_email_apple_user@example.com';
    let { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) {
      const insertRes = await query(
        'INSERT INTO users (email) VALUES ($1) RETURNING *',
        [email]
      );
      rows = insertRes.rows;
    }
    return done(null, rows[0]);
  } catch (err) {
    done(err);
  }
}));

// SERIALIZE / DESERIALIZE
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id=$1', [id]);
    if (!rows.length) return done(null, false);
    done(null, rows[0]);
  } catch (err) {
    done(err);
  }
});
