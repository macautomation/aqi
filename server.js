////////////////////////////////////////////////////////////////////////////////
// server.js (Single-File, All-In-One, NO PLACEHOLDERS)
//
// Contains:
//  - Database init
//  - Utility functions (distanceMiles, pm25->AQI, etc.)
//  - Local, Google, Apple passport strategies
//  - Passport serialize/deserialize
//  - fetchAndStoreHourlyData bounding-box logic (PurpleAir, AirNow, OpenWeather)
//  - 24-hour average logic
//  - Forgot/Reset password
//  - Daily/Hourly cron
//  - user addresses & radius logic
//  - All routes: signup, add-address, delete-address, set radius, set daily time, 
//    /api/myReport, /api/report-now, forgot/reset, delete-account, logout, etc.
//
// Make sure to rename/delete db.js, utils.js to avoid conflicts.
////////////////////////////////////////////////////////////////////////////////

import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pkg from 'pg';
const { Pool } = pkg;

import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import AppleStrategy from 'passport-apple';

import bodyParser from 'body-parser';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import cron from 'node-cron';
import axios from 'axios';
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

import path from 'path';
import { fileURLToPath } from 'url';

////////////////////////////////////////////////////////////////////////////////
// Setup for path, etc.
////////////////////////////////////////////////////////////////////////////////
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

////////////////////////////////////////////////////////////
// In-memory cache for AirNow & PurpleAir
////////////////////////////////////////////////////////////
const memoAirNow = new Map();
const memoPurple = new Map();
const MEMO_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Helper function to get current time
function nowMs() { return Date.now(); }

////////////////////////////////////////////////////////////////////////////////
// DB init logic
////////////////////////////////////////////////////////////////////////////////

let pool;
async function initDB() {
  if(!pool){
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
    });
  }
  const client = await pool.connect();
  try {
    // users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        address VARCHAR(255),
        latest_report TEXT,
        aqi_radius INT DEFAULT 5,
        daily_report_hour INT DEFAULT 8,
        daily_report_minute INT DEFAULT 0,
        closest_24hr_avg INT,
        radius_24hr_avg INT
      );
    `);
    // password_reset_tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        token VARCHAR(255),
        expires_at TIMESTAMP
      );
    `);
    // user_addresses
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        address TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION
      );
    `);
    // purpleair_sensor_ids column
    try {
      await client.query(`
        ALTER TABLE user_addresses
        ADD COLUMN IF NOT EXISTS purpleair_sensor_ids TEXT;
      `);
    } catch(e){
      console.warn('[initDB] Could not add purpleair_sensor_ids column:', e.message);
    }
    // address_hourly_data
    await client.query(`
      CREATE TABLE IF NOT EXISTS address_hourly_data (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        address_id INT REFERENCES user_addresses(id),
        timestamp TIMESTAMP NOT NULL,
        source VARCHAR(50) NOT NULL,
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

async function query(q, params){
  if(!pool){
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
    });
  }
  const client = await pool.connect();
  try {
    return await client.query(q, params);
  } finally {
    client.release();
  }
}

////////////////////////////////////////////////////////////////////////////////
// Utility functions
////////////////////////////////////////////////////////////////////////////////

function distanceMiles(lat1, lon1, lat2, lon2){
  const R=3958.8;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2 +
           Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  const c=2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

function colorCodeAQI(aqi){
  const val=Number(aqi)||0;
  if(val<=50) return 'Good';
  if(val<=100) return 'Moderate';
  if(val<=150) return 'Unhealthy for Sensitive Groups';
  if(val<=200) return 'Unhealthy';
  if(val<=300) return 'Very Unhealthy';
  return 'Hazardous';
}

function getAQIColorStyle(aqi){
  const val=Number(aqi)||0;
  let color='#000';
  if(val<=50) color='#009966';
  else if(val<=100) color='#ffde33';
  else if(val<=150) color='#ff9933';
  else if(val<=200) color='#cc0033';
  else if(val<=300) color='#660099';
  else color='#7e0023';
  return `color:${color}; font-weight:bold;`;
}

const PM25_BREAKPOINTS = [
  { pmLow:0.0, pmHigh:12.0,   aqiLow:0,   aqiHigh:50 },
  { pmLow:12.1, pmHigh:35.4, aqiLow:51,  aqiHigh:100 },
  { pmLow:35.5, pmHigh:55.4, aqiLow:101, aqiHigh:150 },
  { pmLow:55.5, pmHigh:150.4,aqiLow:151, aqiHigh:200 },
  { pmLow:150.5,pmHigh:250.4,aqiLow:201, aqiHigh:300 },
  { pmLow:250.5,pmHigh:500.4,aqiLow:301, aqiHigh:500 }
];

function pm25toAQI(pm){
  let p=pm;
  if(p<0)p=0;
  if(p>500.4)return 500;
  for(const bp of PM25_BREAKPOINTS){
    if(p>=bp.pmLow && p<=bp.pmHigh){
      const ratio=(p - bp.pmLow)/(bp.pmHigh-bp.pmLow);
      const range=(bp.aqiHigh-bp.aqiLow);
      return Math.round(bp.aqiLow + ratio*range);
    }
  }
  return 0;
}

function formatDayTimeForUser(d){
  if(!d)return 'No date';
  const now=new Date();
  const nowDay=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const dateDay=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const dayDiff=(dateDay-nowDay)/(1000*3600*24);
  let dayStr;
  if(dayDiff<1) dayStr='Today';
  else if(dayDiff<2) dayStr='Tomorrow';
  else {
    return `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} at ${formatHourMin(d)}`;
  }
  return `${dayStr} at ${formatHourMin(d)}`;
}

function formatHourMin(d){
  let hh=d.getHours();
  const mm=d.getMinutes();
  const ampm=hh>=12?'pm':'am';
  if(hh===0) hh=12;
  else if(hh>12) hh=hh-12;
  const mmStr=mm.toString().padStart(2,'0');
  return `${hh}:${mmStr}${ampm}`;
}

function getCardinal(deg){
  if(deg==null) return 'Unknown';
  const dirs=['N','NE','E','SE','S','SW','W','NW'];
  const idx=Math.round(deg/45)%8;
  return dirs[idx];
}

////////////////////////////////////////////////////////////////////////////////
// Map Display
////////////////////////////////////////////////////////////////////////////////

// Helper to convert wind degrees to an arrow symbol (rounded to nearest 45°)
function getWindArrow(deg) {
  const directions = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const idx = Math.round(deg / 45) % 8;
  return directions[idx];
}

// Generate a Google Static Maps URL for AirNow
function generateGoogleMapsUrlForAirNow(adr, an) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  let markers = [];
  // User home marker (blue with label "H")
  markers.push(`markers=${encodeURIComponent(`color:blue|label:H|${adr.lat},${adr.lon}`)}`);
  
  // Determine visible area from the last API attempt’s bounding box if available.
  let visibleParam = `${adr.lat},${adr.lon}`;
  if (an.data_json && an.data_json.debug && an.data_json.debug.tries && an.data_json.debug.tries.length) {
    const lastTry = an.data_json.debug.tries[an.data_json.debug.tries.length - 1];
    if (lastTry.boundingBox) {
      const bb = lastTry.boundingBox;
      visibleParam = `${bb.minLat},${bb.minLon}|${bb.maxLat},${bb.maxLon}`;
    }
  }
  
  // Add sensor markers using custom icons so the marker displays the AQI number.
  if (an.data_json && an.data_json.debug && an.data_json.debug.sensors && an.data_json.debug.sensors.length) {
    an.data_json.debug.sensors.forEach(sensor => {
      const iconUrl = getCustomMarkerUrl(sensor.aqi, 'FF0000'); // red marker
      markers.push(`markers=${encodeURIComponent(`icon:${iconUrl}|${sensor.lat},${sensor.lon}`)}`);
    });
  }
  
  const markerParams = markers.join('&');
  const url = `https://maps.googleapis.com/maps/api/staticmap?size=400x400&visible=${encodeURIComponent(visibleParam)}&${markerParams}&key=${key}`;
  return url;
}

// Generate a Google Static Maps URL for PurpleAir
function generateGoogleMapsUrlForPurpleAir(adr, pa) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  let markers = [];
  // User home marker (blue with label "H")
  markers.push(`markers=${encodeURIComponent(`color:blue|label:H|${adr.lat},${adr.lon}`)}`);
  
  let latitudes = [], longitudes = [];
  if (pa.data_json && pa.data_json.debug && pa.data_json.debug.sensors && pa.data_json.debug.sensors.length) {
    pa.data_json.debug.sensors.forEach(sensor => {
      // Use a green marker for PurpleAir sensors
      const iconUrl = getCustomMarkerUrl(sensor.aqi, '008000');
      markers.push(`markers=${encodeURIComponent(`icon:${iconUrl}|${sensor.lat},${sensor.lon}`)}`);
      latitudes.push(sensor.lat);
      longitudes.push(sensor.lon);
    });
  }
  let visibleParam = `${adr.lat},${adr.lon}`;
  if (latitudes.length && longitudes.length) {
    const minLat = Math.min(...latitudes, adr.lat);
    const maxLat = Math.max(...latitudes, adr.lat);
    const minLon = Math.min(...longitudes, adr.lon);
    const maxLon = Math.max(...longitudes, adr.lon);
    visibleParam = `${minLat},${minLon}|${maxLat},${maxLon}`;
  }
  const markerParams = markers.join('&');
  const url = `https://maps.googleapis.com/maps/api/staticmap?size=400x400&visible=${encodeURIComponent(visibleParam)}&${markerParams}&key=${key}`;
  return url;
}

// Generate a Google Static Maps URL for OpenWeather
function generateGoogleMapsUrlForOpenWeather(adr, ow) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  let markers = [];
  // User home marker
  markers.push(`color:blue|label:H|${adr.lat},${adr.lon}`);
  
  // Wind marker(s): use the wind speed and direction from OpenWeather data
  const windSpeed = (ow.data_json && ow.data_json.windSpeed) ? ow.data_json.windSpeed : 0;
  const windDeg = (ow.data_json && ow.data_json.windDeg) ? ow.data_json.windDeg : 0;
  const arrow = getWindArrow(windDeg);
  const windLabel = `${arrow}${windSpeed}`;
  // Place three wind markers with slight offsets around the user's location
  const offset = 0.005; // about 0.3 miles
  markers.push(`color:orange|label:${windLabel}|${adr.lat + offset},${adr.lon}`);
  markers.push(`color:orange|label:${windLabel}|${adr.lat},${adr.lon + offset}`);
  markers.push(`color:orange|label:${windLabel}|${adr.lat - offset},${adr.lon}`);
  
  // Temperature marker: show temperature in bottom right corner (using an offset from user)
  const tempF = (ow.data_json && ow.data_json.tempF) ? ow.data_json.tempF : 0;
  markers.push(`color:purple|label:T:${tempF}|${adr.lat - 0.01},${adr.lon + 0.01}`);
  
  // For OpenWeather, we use a fixed visible area around the user
  const visibleParam = `${adr.lat - 0.02},${adr.lon - 0.02}|${adr.lat + 0.02},${adr.lon + 0.02}`;
  
  const markerParams = markers.map(m => `markers=${encodeURIComponent(m)}`).join('&');
  const url = `https://maps.googleapis.com/maps/api/staticmap?size=400x400&visible=${encodeURIComponent(visibleParam)}&${markerParams}&key=${key}`;
  return url;
}

function getCustomMarkerUrl(aqi, color) {
  // Uses Google Chart API to generate a marker icon with the AQI as text.
  return `https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=${aqi}|${color}|FFFFFF`;
}

////////////////////////////////////////////////////////////////////////////////
// Passport: local, google, apple
////////////////////////////////////////////////////////////////////////////////

passport.use('local', new LocalStrategy({
  usernameField:'email',
  passwordField:'password'
}, async(email,password,done)=>{
  try{
    const {rows}=await query('SELECT * FROM users WHERE email=$1',[email]);
    if(!rows.length) return done(null,false,{message:'No user found'});
    const user=rows[0];
    const match=await bcrypt.compare(password,user.password_hash||'');
    if(!match) return done(null,false,{message:'Bad password'});
    return done(null,user);
  } catch(e){
    return done(e);
  }
}));

passport.use('google', new GoogleStrategy({
  clientID:process.env.GOOGLE_CLIENT_ID||'',
  clientSecret:process.env.GOOGLE_CLIENT_SECRET||'',
  callbackURL:(process.env.APP_URL||'http://localhost:3000')+'/auth/google/callback'
}, async(accessToken,refreshToken,profile,done)=>{
  try{
    const email=(profile.emails&&profile.emails.length) ? profile.emails[0].value : 'noemail@google.com';
    let {rows}=await query('SELECT * FROM users WHERE email=$1',[email]);
    if(!rows.length){
      const ins=await query(`INSERT INTO users(email) VALUES($1) RETURNING *`,[email]);
      rows=ins.rows;
    }
    return done(null,rows[0]);
  } catch(e){
    return done(e);
  }
}));

passport.use('apple', new AppleStrategy({
  clientID:process.env.APPLE_CLIENT_ID||'',
  teamID:process.env.APPLE_TEAM_ID||'',
  keyID:process.env.APPLE_KEY_ID||'',
  privateKeyString:(process.env.APPLE_PRIVATE_KEY||'').replace(/\\n/g,'\n'),
  callbackURL:(process.env.APP_URL||'http://localhost:3000')+'/auth/apple/callback',
  scope:['name','email']
}, async(accessToken,refreshToken,idToken,profile,done)=>{
  if(!profile){
    return done(new Error('No Apple profile'));
  }
  try{
    const email=profile.email||(`noemail_${profile.id}@appleuser.com`);
    let {rows}=await query('SELECT * FROM users WHERE email=$1',[email]);
    if(!rows.length){
      const ins=await query(`INSERT INTO users(email) VALUES($1) RETURNING *`,[email]);
      rows=ins.rows;
    }
    return done(null,rows[0]);
  }catch(e){
    done(e);
  }
}));

passport.serializeUser((user,done)=>{
  done(null,user.id);
});
passport.deserializeUser(async(id,done)=>{
  try{
    const {rows}=await query('SELECT * FROM users WHERE id=$1',[id]);
    if(!rows.length)return done(null,false);
    return done(null,rows[0]);
  }catch(e){
    done(e);
  }
});

////////////////////////////////////////////////////////////////////////////////
// Express + session
////////////////////////////////////////////////////////////////////////////////

const app=express();
app.use(bodyParser.urlencoded({extended:true}));
app.use(bodyParser.json());

const PgSession = pgSession(session);
app.use(session({
  store:new PgSession({
    pool,
    createTableIfMissing:true
  }),
  secret: process.env.SESSION_SECRET||'keyboard cat',
  resave:false,
  saveUninitialized:false
}));
app.use(passport.initialize());
app.use(passport.session());

function ensureAuth(req,res,next){
  if(req.isAuthenticated())return next();
  if(req.path.startsWith('/api/')) {
    return res.status(401).json({error:'Not authenticated'});
  }
  return res.redirect('/html/login.html');
}
async function sendEmail(to, subject, text){
  const msg={to, from:'noreply@littlegiant.app', subject, text};
  await sgMail.send(msg);
}

////////////////////////////////////////////////////////////////////////////////
// bounding-box logic, 24-hour average, hourly fetch
////////////////////////////////////////////////////////////////////////////////

async function initializePurpleAirSensorsForAddress(addressId, userRadiusMiles) {
  const addrRes = await query('SELECT * FROM user_addresses WHERE id=$1', [addressId]);
  if (!addrRes.rows.length) return;
  const row = addrRes.rows[0];
  if (!row.lat || !row.lon) return;

  // Always start at 0.5 miles, unless userRadiusMiles is passed in
  let radiusMiles = userRadiusMiles || 0.5;
  let attempts = 0;
  const maxAttempts = 5;
  let chosenSensors = [];

  while (!chosenSensors.length && attempts < maxAttempts) {
    attempts++;

    // Convert miles to roughly degrees (about 69 miles per degree lat)
    const latOffset = radiusMiles / 69;
    const lonOffset = radiusMiles / 69;
    const minLat = row.lat - latOffset;
    const maxLat = row.lat + latOffset;
    const minLon = row.lon - lonOffset;
    const maxLon = row.lon + lonOffset;

    // Call PurpleAir bounding-box API
    const fields = 'sensor_index,last_seen,latitude,longitude,uptime,confidence,voc,pm1.0,pm2.5,pm2.5_60minute,pm2.5_alt,pm10.0,position_rating,ozone1';
    const resp = await axios.get('https://api.purpleair.com/v1/sensors', {
      headers: { 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params: {
        location_type: 0,
        nwlng: minLon,
        nwlat: maxLat,
        selng: maxLon,
        selat: minLat,
        fields
      }
    });

    const data = resp.data?.data || [];
    if (!data.length) {
      // No sensors at all => expand and try again
      radiusMiles *= 2;
      continue;
    }

    // We got some sensors => let’s keep them, ignoring the "<= radiusMiles" distance filter
    // We'll parse them into objects, compute distance, then pick the 10 physically closest
    const nowSec = Math.floor(Date.now() / 1000);

    let sensorDetails = data.map(arr => ({
      sensorIndex: arr[0],
      lastSeen: arr[1],
      lat: arr[2],
      lon: arr[3],
      uptime: arr[4],
      confidence: arr[5],
      voc: arr[6],
      pm1_0: arr[7],
      pm2_5: arr[8],
      pm2_5_60m: arr[9],
      pm2_5_alt: arr[10],
      pm10_0: arr[11],
      position_rating: arr[12],
      ozone1: arr[13]
    }));

    // Optionally filter out sensors not updated in last hour
    sensorDetails = sensorDetails.filter(s => (nowSec - s.lastSeen) <= 3600);

    // Compute distance for each
    sensorDetails.forEach(s => {
      s.distMiles = distanceMiles(row.lat, row.lon, s.lat, s.lon);
    });

    // Sort by distance ascending
    sensorDetails.sort((a, b) => a.distMiles - b.distMiles);

    // We only want the 10 physically closest sensors
    chosenSensors = sensorDetails.slice(0, 10);

    // Break out immediately after storing
    break;
  }

  if (!chosenSensors.length) {
    // We never found any sensors after expansions => store blank
    await query('UPDATE user_addresses SET purpleair_sensor_ids=$1 WHERE id=$2', ['', addressId]);
    return;
  }

  // Otherwise, build a show_only list of sensor indices
  const sensorIDs = chosenSensors.map(s => s.sensorIndex).join(',');
  await query('UPDATE user_addresses SET purpleair_sensor_ids=$1 WHERE id=$2', [sensorIDs, addressId]);
}

async function fetchPurpleAirForAddressWithCache(addressRow) {
  const key = `purple:${addressRow.lat},${addressRow.lon},${addressRow.purpleair_sensor_ids || ''}`;
  const cached = memoPurple.get(key);
  if (cached) {
    if (nowMs() - cached.timestamp < MEMO_TTL_MS) {
      return cached.data;
    } else {
      memoPurple.delete(key);
    }
  }
  const result = await fetchPurpleAirForAddress(addressRow);
  memoPurple.set(key, {
    timestamp: nowMs(),
    data: result
  });
  return result;
}

// REPLACE your entire fetchPurpleAirForAddress function with this dynamic approach
async function fetchPurpleAirForAddress(addressRow) {
  if (!addressRow.purpleair_sensor_ids) {
    return { closest: 0, average: 0, debug: { fallback: 'No sensor IDs' } };
  }

  const showOnly = addressRow.purpleair_sensor_ids;
  if (!showOnly) {
    return { closest: 0, average: 0, debug: { fallback: 'No sensor IDs string' } };
  }

  // We'll request these columns. PurpleAir might shuffle or add others, so let's map them by name below.
  const requestedFields = [
    "sensor_index",
    "last_seen",
    "latitude",
    "longitude",
    "uptime",
    "confidence",
    "voc",
    "pm1.0_cf_1",
    "pm2.5_cf_1",
    "pm2.5_60minute",
    "pm2.5_alt",
    "pm10.0",
    "position_rating",
    "ozone1"
  ];

  const resp = await axios.get("https://api.purpleair.com/v1/sensors", {
    headers: { "X-API-Key": process.env.PURPLEAIR_API_KEY },
    params: {
      location_type: 0,
      show_only: showOnly,
      fields: requestedFields.join(",")
    }
  });

  // Confirm the actual fields array from the response:
  const actualFields = resp.data.fields || [];
  const data = resp.data.data || [];

  if (!data.length) {
    return {
      closest: 0,
      average: 0,
      debug: {
        showOnly,
        message: "No sensors from show_only",
        fieldsReturned: actualFields
      }
    };
  }

  // We'll create a lookup:  field -> index
  // so we can safely read arr[indexOf["latitude"]] for lat, etc.
  const indexOf = {};
  for (let i = 0; i < actualFields.length; i++) {
    indexOf[actualFields[i]] = i;
  }

  // We'll parse the array lines using the dynamic indexes
  // If a field name doesn't exist, we do indexOf[field] == null => skip
  let sensorDetails = data.map((arr) => {
    const nowSec = Math.floor(Date.now() / 1000);

    const sensor = {
      sensorIndex: 0,
      lastSeen: 0,
      lat: 0,
      lon: 0,
      pm2_5: null,
      pm2_5_60m: null,
      pm2_5_alt: null,
      pm10_0: null,
      pm1_0: null,
      ozone1: null,
      voc: null,
      confidence: null,
      distMiles: 0,
      aqi: 0
    };

    // For each field, check if indexOf has it:
    if (indexOf["sensor_index"] != null) sensor.sensorIndex = arr[indexOf["sensor_index"]];
    if (indexOf["last_seen"] != null) sensor.lastSeen = arr[indexOf["last_seen"]];
    if (indexOf["latitude"] != null) sensor.lat = arr[indexOf["latitude"]];
    if (indexOf["longitude"] != null) sensor.lon = arr[indexOf["longitude"]];
    if (indexOf["confidence"] != null) sensor.confidence = arr[indexOf["confidence"]];
    if (indexOf["voc"] != null) sensor.voc = arr[indexOf["voc"]];
    if (indexOf["pm1.0_cf_1"] != null) sensor.pm1_0 = arr[indexOf["pm1.0_cf_1"]];
    if (indexOf["pm2.5_cf_1"] != null) sensor.pm2_5 = arr[indexOf["pm2.5_cf_1"]];
    if (indexOf["pm2.5_60minute"] != null) sensor.pm2_5_60m = arr[indexOf["pm2.5_60minute"]];
    if (indexOf["pm2.5_alt"] != null) sensor.pm2_5_alt = arr[indexOf["pm2.5_alt"]];
    if (indexOf["pm10.0"] != null) sensor.pm10_0 = arr[indexOf["pm10.0"]];
    if (indexOf["ozone1"] != null) sensor.ozone1 = arr[indexOf["ozone1"]];

    // Filter out sensors older than 1 hour
    const ageSec = nowSec - sensor.lastSeen;
    if (ageSec > 3600) {
      // We'll mark a property "ignore: true" so we can filter it out below
      sensor.ignore = true;
    }

    // We'll do distanceMiles after
    return sensor;
  });

  // Filter out sensors older than 1 hour
  sensorDetails = sensorDetails.filter((s) => !s.ignore);

  // If none left after older check:
  if (!sensorDetails.length) {
    return {
      closest: 0,
      average: 0,
      debug: {
        showOnly,
        sensorCount: 0,
        fieldsReturned: actualFields,
        message: "All sensors older than 1 hour or no valid sensors."
      }
    };
  }

  // Compute distances, fallback logic for pm2.5 => pm2_5_60m => pm2_5_alt => 0
  sensorDetails.forEach((s) => {
    s.distMiles = distanceMiles(addressRow.lat, addressRow.lon, s.lat, s.lon);

    let rawPM25 = s.pm2_5;
    if (rawPM25 == null) {
      if (s.pm2_5_60m != null) rawPM25 = s.pm2_5_60m;
      else if (s.pm2_5_alt != null) rawPM25 = s.pm2_5_alt;
      else rawPM25 = 0;
    }
    s.aqi = pm25toAQI(rawPM25);
  });

  // Sum up for average, find the physically closest
  let sum = 0;
  let count = 0;
  let closestDist = Infinity;
  let closestVal = 0;

  sensorDetails.forEach((s) => {
    sum += s.aqi;
    count++;
    if (s.distMiles < closestDist) {
      closestDist = s.distMiles;
      closestVal = s.aqi;
    }
  });

  if (count === 0) {
    return {
      closest: 0,
      average: 0,
      debug: {
        showOnly,
        sensorCount: 0,
        fieldsReturned: actualFields,
        message: "No valid sensors after distance or PM2.5 logic?"
      }
    };
  }

  const avg = Math.round(sum / count);

  // Return final debug, listing the sensor objects
  return {
    closest: closestVal,
    average: avg,
    debug: {
      approach: "show_only (dynamic index mapping)",
      lat: addressRow.lat,
      lon: addressRow.lon,
      sensorCount: count,
      nearestDistance: closestDist,
      fieldsReturned: actualFields,
      sensors: sensorDetails.map((s) => ({
        sensorIndex: s.sensorIndex,
        lat: s.lat,
        lon: s.lon,
        distMiles: s.distMiles, // in miles
        pm2_5_cf_1: s.pm2_5,
        pm2_5_60m: s.pm2_5_60m,
        pm2_5_alt: s.pm2_5_alt,
        pm1_0_cf_1: s.pm1_0,
        pm10_0: s.pm10_0,
        ozone1: s.ozone1,
        voc: s.voc,
        confidence: s.confidence,
        aqi: s.aqi,
        lastSeen: s.lastSeen
      }))
    }
  };
}

async function fetchAirNowAQIWithCache(lat, lon, initialMiles) {
  // Build a key. For example, lat,lon, plus we can store the current hour or radius
  const key = `airnow:${lat},${lon},${initialMiles}`;
  const cached = memoAirNow.get(key);
  if (cached) {
    // check if it's still valid
    if (nowMs() - cached.timestamp < MEMO_TTL_MS) {
      // return the cached data immediately
      return cached.data;
    } else {
      // remove the old entry
      memoAirNow.delete(key);
    }
  }

  // If not cached, we call the real function
  const result = await fetchAirNowAQI(lat, lon, initialMiles);
  // store it
  memoAirNow.set(key, {
    timestamp: nowMs(),
    data: result
  });
  return result;
}
async function fetchAirNowAQI(lat, lon, initialMiles) {
  let radiusMiles = initialMiles || 0.5;
  let attempts = 0;
  let maxAttempts = 5;
  let foundSensors = false;

  // We'll store the "best" debug info if we never find sensors
  let finalResult = {
    closest: 0,
    average: 0,
    debug: {
      approach: 'autoExpand',
      lat,
      lon,
      tries: []
    }
  };

  while (!foundSensors && attempts < maxAttempts) {
    attempts++;
    let degOffset = radiusMiles / 69;
    let minLat = lat - degOffset;
    let maxLat = lat + degOffset;
    let minLon = lon - degOffset;
    let maxLon = lon + degOffset;

    let debugInfo = {
      pass: attempts,
      radiusMiles,
      boundingBox: { minLat, maxLat, minLon, maxLon }
    };

    const hourStr = new Date().toISOString().slice(0, 13);
    const url = 'https://www.airnowapi.org/aq/data/';
    try {
      const resp = await axios.get(url, {
        params: {
          startDate: hourStr,
          endDate: hourStr,
          parameters: 'pm25',
          BBOX: `${minLon},${minLat},${maxLon},${maxLat}`,
          dataType: 'A',
          format: 'application/json',
          verbose: 0,
          API_KEY: process.env.AIRNOW_API_KEY
        }
      });

      if (!Array.isArray(resp.data) || !resp.data.length) {
        debugInfo.message = 'No AirNow sensors returned';
        finalResult.debug.tries.push(debugInfo);
        radiusMiles *= 2;
      } else {
        let sum = 0;
        let count = 0;
        let closestDist = Infinity;
        let closestVal = 0;
        let sensorDetails = [];

        for (const s of resp.data) {
          const dist = distanceMiles(lat, lon, s.Latitude, s.Longitude);
          sensorDetails.push({ lat: s.Latitude, lon: s.Longitude, aqi: s.AQI, dist });
        }
        sensorDetails = sensorDetails.filter(x => x.dist <= radiusMiles);
        if (!sensorDetails.length) {
          debugInfo.message = 'No sensors within radiusMiles in the returned data.';
          finalResult.debug.tries.push(debugInfo);
          radiusMiles *= 2;
        } else {
          for (const sd of sensorDetails) {
            sum += sd.aqi;
            count++;
            if (sd.dist < closestDist) {
              closestDist = sd.dist;
              closestVal = sd.aqi;
            }
          }
          const avg = Math.round(sum / count);
          debugInfo.sensorCount = count;
          debugInfo.closestDist = closestDist;
          debugInfo.closestAQI = closestVal;
          debugInfo.averageAQI = avg;

          finalResult.closest = closestVal;
          finalResult.average = avg;
          finalResult.debug.tries.push(debugInfo);
          foundSensors = true;
        }
      }
    } catch (e) {
      debugInfo.error = e.message;
      finalResult.debug.tries.push(debugInfo);
      radiusMiles *= 2;
    }
  }

  // Add the debug log before returning:
  console.log('AirNow debug info:', JSON.stringify(finalResult.debug, null, 2));
  return finalResult;
}

  while (!foundSensors && attempts < maxAttempts) {
    attempts++;
    // Convert miles -> degrees. Approx 69 miles per degree latitude
    let degOffset = radiusMiles / 69;
    let minLat = lat - degOffset;
    let maxLat = lat + degOffset;
    let minLon = lon - degOffset;
    let maxLon = lon + degOffset;

    // We'll record the attempt in debug
    let debugInfo = {
      pass: attempts,
      radiusMiles,
      boundingBox: { minLat, maxLat, minLon, maxLon }
    };

    // Build request
    const hourStr = new Date().toISOString().slice(0, 13);
    const url = 'https://www.airnowapi.org/aq/data/';
    try {
      const resp = await axios.get(url, {
        params: {
          startDate: hourStr,
          endDate: hourStr,
          parameters: 'pm25',
          BBOX: `${minLon},${minLat},${maxLon},${maxLat}`,
          dataType: 'A',
          format: 'application/json',
          verbose: 0,
          API_KEY: process.env.AIRNOW_API_KEY
        }
      });

      if (!Array.isArray(resp.data) || !resp.data.length) {
        // no sensors => record and expand
        debugInfo.message = 'No AirNow sensors returned';
        finalResult.debug.tries.push(debugInfo);
        radiusMiles *= 2;
      } else {
        // we have data => filter by distance
        let sum = 0;
        let count = 0;
        let closestDist = Infinity;
        let closestVal = 0;
        let sensorDetails = [];

        for (const s of resp.data) {
          const dist = distanceMiles(lat, lon, s.Latitude, s.Longitude);
          sensorDetails.push({ lat: s.Latitude, lon: s.Longitude, aqi: s.AQI, dist });
        }
        // filter if dist <= radiusMiles
        sensorDetails = sensorDetails.filter(x => x.dist <= radiusMiles);
        if (!sensorDetails.length) {
          debugInfo.message = 'No sensors within radiusMiles in the returned data.';
          finalResult.debug.tries.push(debugInfo);
          radiusMiles *= 2;
        } else {
          // Found sensors => compute average
          for (const sd of sensorDetails) {
            sum += sd.aqi;
            count++;
            if (sd.dist < closestDist) {
              closestDist = sd.dist;
              closestVal = sd.aqi;
            }
          }
          const avg = Math.round(sum / count);
          debugInfo.sensorCount = count;
          debugInfo.closestDist = closestDist;
          debugInfo.closestAQI = closestVal;
          debugInfo.averageAQI = avg;

          finalResult.closest = closestVal;
          finalResult.average = avg;
          finalResult.debug.tries.push(debugInfo);

          foundSensors = true;
        }
      }
    } catch (e) {
      debugInfo.error = e.message;
      finalResult.debug.tries.push(debugInfo);
      // We'll still expand the radius and try again.
      radiusMiles *= 2;
    }
  }

  // If we never found sensors, finalResult.closest stays 0, etc.
  // finalResult.debug will record each attempt. 
  return finalResult;
}

async function fetchOpenWeather(lat,lon){
  const debugInfo={lat,lon};
  try{
    const url='https://api.openweathermap.org/data/2.5/weather';
    const resp=await axios.get(url,{
      params:{
        lat,lon,
        appid:process.env.OPENWEATHER_API_KEY,
        units:'imperial'
      }
    });
    const wind=resp.data.wind||{};
    const main=resp.data.main||{};
    debugInfo.temperatureF=main.temp;
    debugInfo.humidity=main.humidity;
    debugInfo.windSpeed=wind.speed;
    debugInfo.windDeg=wind.deg;
    return {
      tempF: main.temp||0,
      humidity: main.humidity||0,
      windSpeed: wind.speed||0,
      windDeg: wind.deg||0,
      windDir:getCardinal(wind.deg),
      debug:debugInfo
    };
  }catch(e){
    debugInfo.error=e.message;
    return {tempF:0,humidity:0,windSpeed:0,windDeg:0,windDir:'Unknown', debug:debugInfo};
  }
}

async function earliestTimestampForAddress(addressId,source){
  const res=await query(`
    SELECT MIN(timestamp) as mint
    FROM address_hourly_data
    WHERE address_id=$1
      AND source=$2
  `,[addressId,source]);
  if(!res.rows.length||!res.rows[0].mint)return null;
  return new Date(res.rows[0].mint);
}
function format24hrAvailable(earliest){
  if(!earliest)return 'No data yet';
  const d=new Date(earliest.getTime()+24*3600*1000);
  return formatDayTimeForUser(d);
}
async function updateTrailing24hAverages(userId, addressId, timestamp, source) {
  const dayAgo = new Date(timestamp);
  dayAgo.setHours(dayAgo.getHours() - 24);

  const rows = await query(`
    SELECT AVG(aqi_closest) as cAvg,
           AVG(aqi_average) as rAvg,
           COUNT(*) as cnt
    FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND source=$3
      AND timestamp >= $4
  `,[userId, addressId, source, dayAgo]);
  
  if (!rows.rows.length) return;
  
  const c24 = Math.round(rows.rows[0].cavg || 0);
  const r24 = Math.round(rows.rows[0].ravg || 0);
  const count = Number(rows.rows[0].cnt) || 0;

  const newRow = await query(`
    SELECT * FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND source=$3
      AND timestamp=$4
  `,[userId, addressId, source, timestamp]);
  if (!newRow.rows.length) return;

  let dbRow = newRow.rows[0];
  let d = dbRow.data_json || {};

  if (count >= 24) {
    d.closest24hrAvg = c24;
    d.radius24hrAvg = r24;

   // Also store them in the new columns
   await query(`
     UPDATE address_hourly_data
     SET data_json=$1,
         closest_24hr_avg=$2,
         radius_24hr_avg=$3
     WHERE id=$4
   `,[d, c24, r24, dbRow.id]);
  } else {
    // If < 24, we might just update data_json but set columns to null
   await query(`
     UPDATE address_hourly_data
     SET data_json=$1,
         closest_24hr_avg=NULL,
         radius_24hr_avg=NULL
     WHERE id=$2
   `,[d, dbRow.id]);
  }
}
async function fetchAndStoreHourlyDataForUser(userId){
  const userRes=await query('SELECT aqi_radius FROM users WHERE id=$1',[userId]);
  if(!userRes.rows.length)return;
  const radiusMiles=userRes.rows[0].aqi_radius||0.5;
  const addrRes=await query(`
    SELECT id,user_id,address,lat,lon,purpleair_sensor_ids
    FROM user_addresses
    WHERE user_id=$1
  `,[userId]);
  for(const adr of addrRes.rows){
    if(!adr.lat||!adr.lon)continue;

    if(!adr.purpleair_sensor_ids){
      await initializePurpleAirSensorsForAddress(adr.id,radiusMiles);
      const upd=await query('SELECT * FROM user_addresses WHERE id=$1',[adr.id]);
      if(upd.rows.length){
        adr.purpleair_sensor_ids=upd.rows[0].purpleair_sensor_ids;
      }
    }

    const airRes=await fetchAirNowAQIWithCache(adr.lat,adr.lon,radiusMiles);
    const purpleRes=await fetchPurpleAirForAddressWithCache(adr);
    const owRes=await fetchOpenWeather(adr.lat,adr.lon);

    const now=new Date();
    // AirNow
    let dataAir={
      type:'AirNow',
      fetchedAt:now.toISOString(),
      closestAQI:airRes.closest,
      radiusAQI:airRes.average,
      debug:airRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'AirNow',$4,$5,$6)
      ON CONFLICT DO NOTHING
    `,[userId,adr.id,now,airRes.closest,airRes.average,dataAir]);
    await updateTrailing24hAverages(userId,adr.id,now,'AirNow');

    // PurpleAir
    let dataPA={
      type:'PurpleAir',
      fetchedAt:now.toISOString(),
      closestAQI:purpleRes.closest,
      radiusAQI:purpleRes.average,
      debug:purpleRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'PurpleAir',$4,$5,$6)
      ON CONFLICT DO NOTHING
    `,[userId,adr.id,now,purpleRes.closest,purpleRes.average,dataPA]);
    await updateTrailing24hAverages(userId,adr.id,now,'PurpleAir');

    // OpenWeather
    let dataOW={
      type:'OpenWeather',
      fetchedAt:now.toISOString(),
      tempF:owRes.tempF,
      humidity:owRes.humidity,
      windSpeed:owRes.windSpeed,
      windDeg:owRes.windDeg,
      windDir:owRes.windDir,
      debug:owRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'OpenWeather',0,0,$4)
      ON CONFLICT DO NOTHING
    `,[userId,adr.id,now,dataOW]);
    await updateTrailing24hAverages(userId,adr.id,now,'OpenWeather');
  }
}
async function latestSourceRow(addressId,source){
  const rec=await query(`
    SELECT * FROM address_hourly_data
    WHERE address_id=$1 AND source=$2
    ORDER BY timestamp DESC
    LIMIT 1
  `,[addressId,source]);
  if(!rec.rows.length)return null;
  return rec.rows[0];
}

////////////////////////////////////////////////////////////////////////////////
// CRON
////////////////////////////////////////////////////////////////////////////////

cron.schedule('0 * * * *', async()=>{
  console.log('[CRON] hourly triggered');
  try{
    const {rows:users}=await query('SELECT id FROM users');
    for(const u of users){
      await fetchAndStoreHourlyDataForUser(u.id);
    }
  }catch(e){
    console.error('[CRON hourly]',e);
  }
});
cron.schedule('*/15 * * * *', async()=>{
  console.log('[CRON] daily check');
  try{
    const now=new Date();
    const hour=now.getHours();
    const minute=now.getMinutes();
    const block=Math.floor(minute/15)*15;
    const {rows:dueUsers}=await query(`
      SELECT id,email
      FROM users
      WHERE daily_report_hour=$1
        AND daily_report_minute=$2
    `,[hour,block]);
    for(const du of dueUsers){
      await fetchAndStoreHourlyDataForUser(du.id);
      const final=await buildDailyEmail(du.id);
      if(final){
        await sendEmail(du.email,'Your Daily AQI Update',final);
        console.log(`Sent daily update to ${du.email}`);
      }
    }
  }catch(e){
    console.error('[CRON daily check]',e);
  }
});
async function buildDailyEmail(userId){
  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  if(!addrRes.rows.length)return null;
  let lines=[];
  for(const adr of addrRes.rows){
    if(!adr.lat||!adr.lon){
      lines.push(`Address: ${adr.address}\n(No lat/lon)`);
      continue;
    }
    lines.push(`Address: ${adr.address}`);

    const an = await latestSourceRow(adr.id,'AirNow');
    if (an) {
      let c = an.aqi_closest || 0;
      let r = an.aqi_average || 0;

     let c24 = an.closest_24hr_avg; 
     let r24 = an.radius_24hr_avg;
      if (c24 == null) {
        const earliest = await earliestTimestampForAddress(adr.id,'AirNow');
        c24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      if (r24 == null) {
        const earliest = await earliestTimestampForAddress(adr.id,'AirNow');
        r24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      lines.push(` AirNow => ClosestAQI=${c}, RadiusAvg=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(` AirNow => No data`);
    }

    const pa = await latestSourceRow(adr.id,'PurpleAir');
    if (pa) {
      let c = pa.aqi_closest || 0;
      let r = pa.aqi_average || 0;

     let c24 = pa.closest_24hr_avg; 
     let r24 = pa.radius_24hr_avg;
      if (c24 == null) {
        const earliest = await earliestTimestampForAddress(adr.id,'PurpleAir');
        c24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      if (r24 == null) {
        const earliest = await earliestTimestampForAddress(adr.id,'PurpleAir');
        r24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      lines.push(` PurpleAir => ClosestAQI=${c}, RadiusAvg=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(` PurpleAir => No data`);
    }

    const ow=await latestSourceRow(adr.id,'OpenWeather');
    if(ow){
      const d=ow.data_json||{};
      let c24=d.ow24hrTemp;
      if(c24===undefined){
        const earliest=await earliestTimestampForAddress(adr.id,'OpenWeather');
        c24=`Available at ${format24hrAvailable(earliest)}`;
      }
      lines.push(` OpenWeather => Now: Temp=${d.tempF||0}F, Wind=${d.windSpeed||0} mph, 24hrAvgTemp=${c24}`);
    } else {
      lines.push(` OpenWeather => No data`);
    }
  }
  return lines.join('\n');
}

////////////////////////////////////////////////////////////////////////////////
// Routes
////////////////////////////////////////////////////////////////////////////////

app.use(express.static(__dirname));

app.get('/',(req,res)=>{
  if(req.isAuthenticated()) return res.redirect('/html/dashboard.html');
  res.sendFile(path.join(__dirname,'index.html'));
});

// google places key
app.get('/js/autocomplete.js',(req,res)=>{
  const key=process.env.GOOGLE_GEOCODE_KEY||'';
  const content=`
    function loadGooglePlaces(){
      var s=document.createElement('script');
      s.src="https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=initAutocomplete";
      document.head.appendChild(s);
    }
    function initAutocomplete(){
      var inp=document.getElementById('addressInput');
      if(!inp)return;
      new google.maps.places.Autocomplete(inp);
    }
    window.onload=loadGooglePlaces;
  `;
  res.type('js').send(content);
});

// signup
app.post('/api/signup', async(req,res)=>{
  const { email, password, password2, address, agreePolicy, agreeTerms} = req.body;
  if(!email||!password||!password2){
    return res.status(400).send('All fields required');
  }
  if(!agreePolicy||!agreeTerms){
    return res.status(400).send('Must accept policy/terms');
  }
  if(password!==password2){
    return res.status(400).send('Passwords do not match');
  }
  if(password.length<8||!/[0-9]/.test(password)||!/[A-Za-z]/.test(password)||!/[^A-Za-z0-9]/.test(password)){
    return res.status(400).send('Password not complex enough');
  }
  try{
    const hash=await bcrypt.hash(password,10);
    const userRes=await query(`
      INSERT INTO users(email,password_hash,latest_report)
      VALUES($1,$2,$3)
      RETURNING id
    `,[email,hash,JSON.stringify({})]);
    const newUserId=userRes.rows[0].id;
    if(address && address.trim()){
      let lat=null,lon=null;
      if(process.env.GOOGLE_GEOCODE_KEY){
        const geoURL='https://maps.googleapis.com/maps/api/geocode/json';
        const resp=await axios.get(geoURL,{params:{address,key:process.env.GOOGLE_GEOCODE_KEY}});
        if(resp.data.results?.length){
          lat=resp.data.results[0].geometry.location.lat;
          lon=resp.data.results[0].geometry.location.lng;
        }
      }
      await query(`
        INSERT INTO user_addresses(user_id,address,lat,lon)
        VALUES($1,$2,$3,$4)
      `,[newUserId,address.trim(),lat,lon]);
    }
    const dashLink=`${process.env.APP_URL||'http://localhost:3000'}/html/dashboard.html`;
    await sendEmail(email,'Welcome to AQI Updates',`Thanks for signing up!\n${dashLink}\nEnjoy!`);
    res.redirect('/html/login.html');
  } catch(e){
    console.error('[signup error]',e);
    res.status(500).send('Error signing up');
  }
});

// add address
app.post('/api/add-address', ensureAuth, async(req,res)=>{
  const {address}=req.body;
  if(!address) return res.status(400).send('No address provided');
  const cnt=await query('SELECT COUNT(*) FROM user_addresses WHERE user_id=$1',[req.user.id]);
  const c=parseInt(cnt.rows[0].count,10);
  if(c>=3){
    return res.status(400).send('Max 3 addresses allowed');
  }
  let lat=null,lon=null;
  if(process.env.GOOGLE_GEOCODE_KEY){
    const geoURL='https://maps.googleapis.com/maps/api/geocode/json';
    const resp=await axios.get(geoURL,{params:{address,key:process.env.GOOGLE_GEOCODE_KEY}});
    if(resp.data.results?.length){
      lat=resp.data.results[0].geometry.location.lat;
      lon=resp.data.results[0].geometry.location.lng;
    }
  }
  await query(`
    INSERT INTO user_addresses(user_id,address,lat,lon)
    VALUES($1,$2,$3,$4)
  `,[req.user.id,address.trim(),lat,lon]);
  res.redirect('/html/dashboard.html');
});

// delete address
// REPLACE your entire delete-address route with this:
app.post('/api/delete-address', ensureAuth, async (req, res) => {
  const { addressId } = req.body;
  if (!addressId) return res.status(400).send('No addressId');

  try {
    // 1) Delete references in address_hourly_data
    await query(
      'DELETE FROM address_hourly_data WHERE address_id = $1 AND user_id = $2',
      [addressId, req.user.id]
    );

    // 2) Delete from user_addresses
    await query(
      'DELETE FROM user_addresses WHERE id = $1 AND user_id = $2',
      [addressId, req.user.id]
    );

    // 3) Done
    return res.redirect('/html/dashboard.html');
  } catch (err) {
    console.error('[delete-address error]', err);
    return res.status(500).send('Error deleting address');
  }
});

// set-aqi-radius
app.post('/api/set-aqi-radius', ensureAuth, async(req,res)=>{
  const {radius}=req.body;
  if(!radius)return res.status(400).json({error:'No radius'});
  await query('UPDATE users SET aqi_radius=$1 WHERE id=$2',[parseInt(radius,10),req.user.id]);
  res.json({success:true});
});

// set-daily-time
app.post('/api/set-daily-time', ensureAuth, async(req,res)=>{
  const {hour,minute}=req.body;
  if(hour===undefined||minute===undefined) return res.status(400).json({error:'Missing hour/minute'});
  await query('UPDATE users SET daily_report_hour=$1, daily_report_minute=$2 WHERE id=$3',
    [parseInt(hour,10),parseInt(minute,10),req.user.id]);
  res.json({success:true});
});

// list addresses
app.get('/api/list-addresses', ensureAuth, async(req,res)=>{
  try{
    const {rows}=await query('SELECT id,address,lat,lon FROM user_addresses WHERE user_id=$1 ORDER BY id',[req.user.id]);
    res.json(rows);
  }catch(e){
    console.error('/api/list-addresses error', e);
    res.status(500).json({error:'Internal error'});
  }
});

app.get('/api/myReport', ensureAuth, async(req,res)=>{
  try{
    const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[req.user.id]);
    if(!addrRes.rows.length){
      return res.json({error:'No addresses. Please add an address.'});
    }
    let html='';
    for(const adr of addrRes.rows){
      html+=`<h4>Address: ${adr.address}</h4>`;
      if(!adr.lat||!adr.lon){
        html+=`<p>(No lat/lon, cannot produce AQI)</p>`;
        continue;
      }
      let an=await latestSourceRow(adr.id,'AirNow');
      let pa=await latestSourceRow(adr.id,'PurpleAir');
      let ow=await latestSourceRow(adr.id,'OpenWeather');
      html+=await buildAddressReportHTML(adr,an,pa,ow);
    }
    res.json({html});
  } catch(e){
    console.error('[myReport error]', e);
    res.status(500).json({error:'Internal server error'});
  }
});

async function buildAirNowSection(adr, an) {
  if (!an) return `<p>AirNow => No data</p>`;

  const c = an.aqi_closest || 0;
  const r = an.aqi_average || 0;
  const cat = colorCodeAQI(c);
  const cStyle = getAQIColorStyle(c);
  const rStyle = getAQIColorStyle(r);

  let c24 = an.closest_24hr_avg;
  let r24 = an.radius_24hr_avg;
  if (c24 == null) {
    const earliest = await earliestTimestampForAddress(adr.id, 'AirNow');
    c24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  if (r24 == null) {
    const earliest = await earliestTimestampForAddress(adr.id, 'AirNow');
    r24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  const c24Style = (typeof c24 === 'number') ? getAQIColorStyle(c24) : '';
  const r24Style = (typeof r24 === 'number') ? getAQIColorStyle(r24) : '';

  let nearestLine = '';
  if (an.data_json?.debug?.nearestDistance !== undefined) {
    nearestLine = `<br>Nearest sensor is ${an.data_json.debug.nearestDistance.toFixed(1)} miles away`;
  }

  const debugObj = an.data_json?.debug || {};
  const debugHTML = buildDebugPopupHTML(debugObj, 'AirNow Debug');

  return `
    <table style="border-collapse:collapse;width:100%;margin-bottom:10px;">
      <thead>
        <tr style="background:#f0f0f0;"><th colspan="2">AirNow</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>Current Closest AQI</td>
          <td style="${cStyle}">
            ${c} (${cat})
            <a href="#" data-debug="${encodeURIComponent(debugHTML)}"
               onclick="showDetailPopup(decodeURIComponent(this.getAttribute('data-debug')), event);return false;">
               [details]
            </a>
          </td>
        </tr>
        <tr>
          <td>Current Radius Average</td>
          <td style="${rStyle}">${r}</td>
        </tr>
        <tr>
          <td>Closest 24hr Average</td>
          <td style="${c24Style}">${c24}</td>
        </tr>
        <tr>
          <td>Radius 24hr Average</td>
          <td style="${r24Style}">${r24}</td>
        </tr>
        <tr>
          <td>Nearest Sensor Distance</td>
          <td>${nearestLine}</td>
        </tr>
        <tr>
          <td colspan="2"><a href="#" onclick="showMapPopup('AirNow', ${encodeURIComponent(JSON.stringify(adr))}, ${encodeURIComponent(JSON.stringify(an))}); return false;">[view on map]</a></td>
        </tr>
      </tbody>
    </table>
  `;
}

// PurpleAir Section

async function buildPurpleAirSection(adr, pa) {
  if (!pa) return `<p>PurpleAir => No data</p>`;
  
  const c = pa.aqi_closest || 0;
  const r = pa.aqi_average || 0;
  const cat = colorCodeAQI(c);
  const cStyle = getAQIColorStyle(c);
  const rStyle = getAQIColorStyle(r);
  
  let c24 = pa.closest_24hr_avg;
  let r24 = pa.radius_24hr_avg;
  if (c24 == null) {
    const earliest = await earliestTimestampForAddress(adr.id, 'PurpleAir');
    c24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  if (r24 == null) {
    const earliest = await earliestTimestampForAddress(adr.id, 'PurpleAir');
    r24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  const c24Style = (typeof c24 === 'number') ? getAQIColorStyle(c24) : '';
  const r24Style = (typeof r24 === 'number') ? getAQIColorStyle(r24) : '';
  
  let nearestLine = '';
  if (pa.data_json?.debug?.nearestDistance !== undefined) {
    nearestLine = `<br>Nearest sensor is ${pa.data_json.debug.nearestDistance.toFixed(1)} miles away`;
  }
  
  const debugObj = pa.data_json?.debug || {};
  const debugHTML = buildDebugPopupHTML(debugObj, 'PurpleAir Debug');
  
  return `
    <table style="border-collapse:collapse;width:100%;margin-bottom:10px;">
      <thead>
        <tr style="background:#f0f0f0;"><th colspan="2">PurpleAir</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>Current Closest AQI</td>
          <td style="${cStyle}">
            ${c} (${cat})
            <a href="#" data-debug="${encodeURIComponent(debugHTML)}"
               onclick="showDetailPopup(decodeURIComponent(this.getAttribute('data-debug')), event);return false;">
               [details]
            </a>
          </td>
        </tr>
        <tr>
          <td>Current Radius Average</td>
          <td style="${rStyle}">${r}</td>
        </tr>
        <tr>
          <td>Closest 24hr Average</td>
          <td style="${c24Style}">${c24}</td>
        </tr>
        <tr>
          <td>Radius 24hr Average</td>
          <td style="${r24Style}">${r24}</td>
        </tr>
        <tr>
          <td>Nearest Sensor Distance</td>
          <td>${nearestLine}</td>
        </tr>
        <tr>
          <td colspan="2">
            <a href="#" onclick="showMapPopup('PurpleAir', ${encodeURIComponent(JSON.stringify(adr))}, ${encodeURIComponent(JSON.stringify(pa))}); return false;">
              [view on map]
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  `;
}

async function buildAddressReportHTML(adr, an, pa, ow) {
  let html = '';
  html += await buildAirNowSection(adr, an);
  html += await buildPurpleAirSection(adr, pa);
  html += await buildOpenWeatherSection(adr, ow);
  return html;
}

async function buildOpenWeatherSection(adr, ow) {
  if (!ow) return `<p>OpenWeather => No data</p>`;
  const d = ow.data_json || {};
  let c24 = (d.ow24hrTemp !== undefined)
    ? d.ow24hrTemp
    : `Available at ${format24hrAvailable(await earliestTimestampForAddress(adr.id, 'OpenWeather'))}`;
  const debugObj = d.debug || {};
  const debugHTML = buildDebugPopupHTML(debugObj, 'OpenWeather Debug');
  
  // Build the table with OpenWeather data.
  const tableHtml = `
    <table style="border-collapse:collapse;width:100%;margin-bottom:10px;">
      <thead>
        <tr style="background:#f0f0f0;"><th colspan="2">OpenWeather</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>Current Hourly</td>
          <td>
            Temp=${d.tempF || 0}F, Wind=${d.windSpeed || 0} mph from ${d.windDir || '??'} (${d.windDeg || 0}°)
            <a href="#" data-debug="${encodeURIComponent(debugHTML)}" onclick="showDetailPopup(decodeURIComponent(this.getAttribute('data-debug')), event);return false;">[details]</a>
          </td>
        </tr>
        <tr>
          <td>24hr Average</td>
          <td>Temp=${c24}F</td>
        </tr>
      </tbody>
    </table>
  `;
  // Instead of inline map, we now include the OpenWeather map below the table.
  const mapHtml = `<div style="margin-top:10px;"><img src="${generateGoogleMapsUrlForOpenWeather_Client(adr, ow)}" alt="OpenWeather Map" style="max-width:100%;"></div>`;
  return tableHtml + mapHtml;
}

function buildDebugPopupHTML(debugObj, title) {
  const raw = JSON.stringify(debugObj, null, 2);
  return `<h3>${title}</h3><pre>${raw.replace(/`/g, '\\`')}</pre>`;
}

app.post('/api/report-now', ensureAuth, async(req,res)=>{
  try{
    await fetchAndStoreHourlyDataForUser(req.user.id);
    const baseUrl=`${req.protocol}://${req.get('host')}`;
    const r=await axios.get(`${baseUrl}/api/myReport`,{
      headers:{cookie:req.headers.cookie||''}
    });
    res.json(r.data);
  }catch(e){
    console.error('[report-now error]',e);
    res.status(502).json({error:'Error: HTTP 502 - '+e});
  }
});

////////////////////////////////////////////////////////////////////////////////
// forgot & reset
////////////////////////////////////////////////////////////////////////////////

app.post('/api/forgot', async(req,res)=>{
  const {email}=req.body;
  if(!email)return res.status(400).send('No email');
  const {rows}=await query('SELECT id FROM users WHERE email=$1',[email]);
  if(!rows.length){
    return res.send('If found, a reset link is sent.');
  }
  const userId=rows[0].id;
  const token=crypto.randomBytes(20).toString('hex');
  const expires=new Date(Date.now()+3600000);
  await query(`
    INSERT INTO password_reset_tokens(user_id,token,expires_at)
    VALUES($1,$2,$3)
  `,[userId,token,expires]);
  const link=`${process.env.APP_URL||'http://localhost:3000'}/html/reset.html?token=${token}`;
  await sendEmail(email,'Password Reset',`Click here:\n${link}`);
  res.send('If found, a reset link is emailed.');
});

app.post('/api/reset', async(req,res)=>{
  const {token,newPassword}=req.body;
  if(!token||!newPassword)return res.status(400).send('Missing token or newPassword');
  if(newPassword.length<8||!/[0-9]/.test(newPassword)||!/[A-Za-z]/.test(newPassword)||!/[^A-Za-z0-9]/.test(newPassword)){
    return res.status(400).send('New password not complex enough');
  }
  const now=new Date();
  const {rows}=await query(`
    SELECT user_id FROM password_reset_tokens
    WHERE token=$1 AND expires_at>$2
  `,[token,now]);
  if(!rows.length)return res.status(400).send('Invalid/expired token');
  const userId=rows[0].user_id;
  const hash=await bcrypt.hash(newPassword,10);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,userId]);
  await query('DELETE FROM password_reset_tokens WHERE token=$1',[token]);
  res.send('Password reset. <a href="login.html">Log in</a>');
});

////////////////////////////////////////////////////////////////////////////////
// delete account
////////////////////////////////////////////////////////////////////////////////

// REPLACE your entire delete-account route with this:
app.post('/api/delete-account', ensureAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    // 1) Find the user’s email for the farewell message
    const { rows } = await query('SELECT email FROM users WHERE id=$1', [userId]);
    if (!rows.length) {
      // If user not found, just log them out
      return req.logout(() => res.redirect('/index.html'));
    }
    const userEmail = rows[0].email;

    // 2) Delete rows in address_hourly_data => because they reference addresses
    await query('DELETE FROM address_hourly_data WHERE user_id=$1', [userId]);

    // 3) Delete addresses
    await query('DELETE FROM user_addresses WHERE user_id=$1', [userId]);

    // 4) Finally, delete the user row
    await query('DELETE FROM users WHERE id=$1', [userId]);

    // 5) Log them out, then send the farewell email asynchronously
    req.logout(() => {
      sendEmail(
        userEmail,
        'Account Deleted',
        `Your account is deleted.\nNo more emails.\nIf you want to sign up again, just do so from the main site.`
      ).catch(e => console.error('[delete-account email]', e));

      // 6) Redirect to home
      res.redirect('/index.html');
    });
  } catch (err) {
    console.error('[delete-account error]', err);
    return res.status(500).send('Error deleting account');
  }
});

////////////////////////////////////////////////////////////////////////////////
// local, google, apple endpoints
////////////////////////////////////////////////////////////////////////////////

app.post('/api/login',
  passport.authenticate('local',{failureRedirect:'/html/login.html'}),
  (req,res)=>res.redirect('/html/dashboard.html')
);

app.get('/auth/google', passport.authenticate('google',{scope:['email','profile']}));
app.get('/auth/google/callback',
  passport.authenticate('google',{failureRedirect:'/html/login.html'}),
  (req,res)=> res.redirect('/html/dashboard.html')
);

app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple',{failureRedirect:'/html/login.html'}),
  (req,res)=>res.redirect('/html/dashboard.html')
);

////////////////////////////////////////////////////////////////////////////////
// Start server
////////////////////////////////////////////////////////////////////////////////

const port=process.env.PORT||3000;
app.listen(port, async()=>{
  await initDB();
  console.log(`Server running on port ${port}`);
});
