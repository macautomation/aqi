////////////////////////////////////////////////////////////////////////////////
// server.js
//
// Changes in this version:
// 1) Bounding boxes for AirNow & PurpleAir maps now include both home location
//    and any sensors, guaranteeing sensors appear on the map.
// 2) OpenWeather map shows an orange wind-direction arrow + a pink circle/pin
//    with temperature (no red balloons).
// 3) All static map images are now 800x800 (double the previous ~400x400).
// 4) 24-hour averages only show if we actually have 24 or more data points.
//    Otherwise, it will say "Available at ..." for each metric, matching your
//    request that we not show a partial average.
// 5) Debug popups are nicely formatted (indented JSON in <pre>) with HTML-safe
//    escaping.
// 6) The map popup is centered in the window (fixed positioning) rather than
//    appearing near the cursor, per request.
// 7) No backslash escapes before backticks or ${} placeholders.
//
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

////////////////////////////////////////////////////////////////////////////////
// In-memory caching for AirNow & PurpleAir results
////////////////////////////////////////////////////////////////////////////////
const memoAirNow = new Map();
const memoPurple = new Map();
const MEMO_TTL_MS = 15 * 60 * 1000; // 15 minutes

function nowMs() {
  return Date.now();
}

////////////////////////////////////////////////////////////////////////////////
// DB init logic
////////////////////////////////////////////////////////////////////////////////

let pool;
async function initDB() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
    });
  }
  const client = await pool.connect();
  try {
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        token VARCHAR(255),
        expires_at TIMESTAMP
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        address TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION
      );
    `);
    // PurpleAir sensor IDs column
    try {
      await client.query(`
        ALTER TABLE user_addresses
        ADD COLUMN IF NOT EXISTS purpleair_sensor_ids TEXT;
      `);
    } catch (e) {
      console.warn('[initDB] Could not add purpleair_sensor_ids column:', e.message);
    }

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

async function query(q, params) {
  if (!pool) {
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

function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function colorCodeAQI(aqi) {
  const val = Number(aqi)||0;
  if(val<=50) return 'Good';
  if(val<=100) return 'Moderate';
  if(val<=150) return 'Unhealthy for Sensitive Groups';
  if(val<=200) return 'Unhealthy';
  if(val<=300) return 'Very Unhealthy';
  return 'Hazardous';
}

function getAQIColorStyle(aqi) {
  const val = Number(aqi)||0;
  let color = '#000';
  if(val<=50) color='#009966';
  else if(val<=100) color='#ffde33';
  else if(val<=150) color='#ff9933';
  else if(val<=200) color='#cc0033';
  else if(val<=300) color='#660099';
  else color='#7e0023';
  return `color:${color}; font-weight:bold;`;
}

const PM25_BREAKPOINTS = [
  { pmLow:0.0,   pmHigh:12.0,   aqiLow:0,   aqiHigh:50 },
  { pmLow:12.1,  pmHigh:35.4,   aqiLow:51,  aqiHigh:100 },
  { pmLow:35.5,  pmHigh:55.4,   aqiLow:101, aqiHigh:150 },
  { pmLow:55.5,  pmHigh:150.4,  aqiLow:151, aqiHigh:200 },
  { pmLow:150.5, pmHigh:250.4,  aqiLow:201, aqiHigh:300 },
  { pmLow:250.5, pmHigh:500.4,  aqiLow:301, aqiHigh:500 }
];

function pm25toAQI(pm) {
  let p = pm;
  if (p < 0) p = 0;
  if (p > 500.4) return 500;
  for (const bp of PM25_BREAKPOINTS) {
    if (p >= bp.pmLow && p <= bp.pmHigh) {
      const ratio = (p - bp.pmLow) / (bp.pmHigh - bp.pmLow);
      const range = (bp.aqiHigh - bp.aqiLow);
      return Math.round(bp.aqiLow + ratio * range);
    }
  }
  return 0;
}

function formatHourMin(d) {
  // 12-hour format
  let hh = d.getHours();
  const mm = d.getMinutes();
  const ampm = hh >= 12 ? 'pm' : 'am';
  if (hh === 0) hh = 12;
  else if (hh > 12) hh -= 12;
  const mmStr = mm.toString().padStart(2,'0');
  return `${hh}:${mmStr}${ampm}`;
}

/**
 * formatDayTimeForUser(d):
 *   - If date is the same local day => "Today 1:30pm"
 *   - If next local day => "Tomorrow 1:30pm"
 *   - Else => "MM/DD at HH:MMpm"
 */
function formatDayTimeForUser(d) {
  if (!d) return 'No date';
  // Convert to local time from possible UTC
  const local = new Date(d.getTime() - d.getTimezoneOffset()*60000);

  const now = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset()*60000);

  const nowDay = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate());
  const dateDay = new Date(local.getFullYear(), local.getMonth(), local.getDate());
  const dayDiff = (dateDay - nowDay) / (1000*3600*24);

  if (dayDiff < 1 && dayDiff >= 0) {
    return `Today ${formatHourMin(local)}`;
  } else if (dayDiff < 2 && dayDiff >= 0) {
    return `Tomorrow ${formatHourMin(local)}`;
  } else {
    const mo = String(local.getMonth()+1).padStart(2,'0');
    const da = String(local.getDate()).padStart(2,'0');
    return `${mo}/${da} at ${formatHourMin(local)}`;
  }
}

function getCardinal(deg) {
  if (deg==null) return 'Unknown';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(deg/45)%8;
  return dirs[idx];
}

function getWindArrow(deg) {
  const directions = ['↑','↗','→','↘','↓','↙','←','↖'];
  const idx = Math.round(deg/45) % 8;
  return directions[idx];
}

////////////////////////////////////////////////////////////////////////////////
// Google Static Map marker generation
////////////////////////////////////////////////////////////////////////////////

function getTemperatureMarkerUrl(tempF) {
  // Pink circle/pin: text = e.g. "72°"
  const t = Math.round(tempF) + '°';
  return `https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=${encodeURIComponent(t)}|FF69B4|000000`;
}

function getWindMarkerUrl(windDeg, windSpeed) {
  // Orange arrow + speed
  const arrow = getWindArrow(windDeg);
  const label = arrow + (Math.round(windSpeed)||0);
  // background color: orange, text: black
  return `https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=${encodeURIComponent(label)}|FFA500|000000`;
}

/**
 * AirNow: we now combine lat/lon from user + any sensors if present
 */
function generateGoogleMapsUrlForAirNow(adr, an) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  let markers = [];
  let latVals = [adr.lat];
  let lonVals = [adr.lon];

  // Mark home in blue
  markers.push(`markers=${encodeURIComponent(`color:blue|label:H|${adr.lat},${adr.lon}`)}`);

  // If we have sensor data, add them in red
  if (an.data_json?.debug?.sensors) {
    an.data_json.debug.sensors.forEach(s => {
      // red
      const url = `https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=${s.aqi}|FF0000|FFFFFF`;
      markers.push(`markers=${encodeURIComponent(`icon:${url}|${s.lat},${s.lon}`)}`);
      latVals.push(s.lat);
      lonVals.push(s.lon);
    });
  }

  // Determine bounding box from min/max lat/lon
  const minLat = Math.min(...latVals);
  const maxLat = Math.max(...latVals);
  const minLon = Math.min(...lonVals);
  const maxLon = Math.max(...lonVals);

  const visibleParam = `${minLat},${minLon}|${maxLat},${maxLon}`;
  const markerParams = markers.join('&');

  // 2x size => 800x800
  return `https://maps.googleapis.com/maps/api/staticmap?size=800x800&visible=${encodeURIComponent(visibleParam)}&${markerParams}&key=${key}`;
}

/**
 * PurpleAir bounding box similarly
 */
function generateGoogleMapsUrlForPurpleAir(adr, pa) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  let markers = [];
  let latVals = [adr.lat];
  let lonVals = [adr.lon];

  // Home marker in blue
  markers.push(`markers=${encodeURIComponent(`color:blue|label:H|${adr.lat},${adr.lon}`)}`);

  if (pa.data_json?.debug?.sensors) {
    pa.data_json.debug.sensors.forEach(s => {
      // green marker
      const url = `https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=${s.aqi}|008000|FFFFFF`;
      markers.push(`markers=${encodeURIComponent(`icon:${url}|${s.lat},${s.lon}`)}`);
      latVals.push(s.lat);
      lonVals.push(s.lon);
    });
  }

  const minLat = Math.min(...latVals);
  const maxLat = Math.max(...latVals);
  const minLon = Math.min(...lonVals);
  const maxLon = Math.max(...lonVals);
  const visibleParam = `${minLat},${minLon}|${maxLat},${maxLon}`;
  const markerParams = markers.join('&');

  return `https://maps.googleapis.com/maps/api/staticmap?size=800x800&visible=${encodeURIComponent(visibleParam)}&${markerParams}&key=${key}`;
}

/**
 * OpenWeather:
 *  - Blue "H"
 *  - 3 orange arrow pins for wind
 *  - 1 pink pin for temperature
 *  - bounding box ~ user lat/lon +/- 0.03
 */
function generateGoogleMapsUrlForOpenWeather(adr, ow) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  let markers = [];

  // Blue H
  markers.push(`markers=${encodeURIComponent(`color:blue|label:H|${adr.lat},${adr.lon}`)}`);

  // Arrow markers
  const windDeg = ow.data_json?.windDeg || 0;
  const windSpeed = ow.data_json?.windSpeed || 0;
  const windIconUrl = getWindMarkerUrl(windDeg, windSpeed);

  // We'll place 3 arrow pins around the home
  const offset = 0.005;
  markers.push(`markers=${encodeURIComponent(`icon:${windIconUrl}|${adr.lat + offset},${adr.lon}`)}`);
  markers.push(`markers=${encodeURIComponent(`icon:${windIconUrl}|${adr.lat},${adr.lon + offset}`)}`);
  markers.push(`markers=${encodeURIComponent(`icon:${windIconUrl}|${adr.lat - offset},${adr.lon}`)}`);

  // Temperature pin
  const tempF = ow.data_json?.tempF || 0;
  const tempMarkerUrl = getTemperatureMarkerUrl(tempF);
  markers.push(`markers=${encodeURIComponent(`icon:${tempMarkerUrl}|${adr.lat},${adr.lon - offset}`)}`);

  // Make the bounding region 0.03 in each direction
  const minLat = adr.lat - 0.03;
  const maxLat = adr.lat + 0.03;
  const minLon = adr.lon - 0.03;
  const maxLon = adr.lon + 0.03;
  const visibleParam = `${minLat},${minLon}|${maxLat},${maxLon}`;
  const markerParams = markers.join('&');

  // 800x800
  return `https://maps.googleapis.com/maps/api/staticmap?size=800x800&visible=${encodeURIComponent(visibleParam)}&${markerParams}&key=${key}`;
  console.log("Using new openweather marker logic!", adr, ow);
}

////////////////////////////////////////////////////////////////////////////////
// Passport
////////////////////////////////////////////////////////////////////////////////

passport.use('local', new LocalStrategy({
  usernameField:'email',
  passwordField:'password'
}, async(email,password,done)=>{
  try {
    const {rows} = await query('SELECT * FROM users WHERE email=$1',[email]);
    if(!rows.length) return done(null,false,{message:'No user found'});
    const user = rows[0];
    const match = await bcrypt.compare(password,user.password_hash||'');
    if(!match) return done(null,false,{message:'Bad password'});
    return done(null,user);
  } catch(e){
    return done(e);
  }
}));

passport.use('google', new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: (process.env.APP_URL||'http://localhost:3000') + '/auth/google/callback'
}, async(accessToken,refreshToken,profile,done)=>{
  try {
    const email = (profile.emails && profile.emails.length) ? profile.emails[0].value : 'noemail@google.com';
    let {rows} = await query('SELECT * FROM users WHERE email=$1',[email]);
    if(!rows.length){
      const ins = await query(`INSERT INTO users(email) VALUES($1) RETURNING *`,[email]);
      rows = ins.rows;
    }
    return done(null,rows[0]);
  } catch(e){
    return done(e);
  }
}));

passport.use('apple', new AppleStrategy({
  clientID: process.env.APPLE_CLIENT_ID || '',
  teamID: process.env.APPLE_TEAM_ID || '',
  keyID: process.env.APPLE_KEY_ID || '',
  privateKeyString: (process.env.APPLE_PRIVATE_KEY||'').replace(/\\n/g,'\n'),
  callbackURL: (process.env.APP_URL||'http://localhost:3000') + '/auth/apple/callback',
  scope: ['name','email']
}, async(accessToken,refreshToken,idToken,profile,done)=>{
  if(!profile) {
    return done(new Error('No Apple profile'));
  }
  try {
    const email = profile.email || (`noemail_${profile.id}@appleuser.com`);
    let {rows} = await query('SELECT * FROM users WHERE email=$1',[email]);
    if(!rows.length){
      const ins = await query(`INSERT INTO users(email) VALUES($1) RETURNING *`,[email]);
      rows = ins.rows;
    }
    return done(null, rows[0]);
  } catch(e){
    done(e);
  }
}));

passport.serializeUser((user,done)=>{
  done(null,user.id);
});
passport.deserializeUser(async(id,done)=>{
  try {
    const {rows} = await query('SELECT * FROM users WHERE id=$1',[id]);
    if(!rows.length) return done(null,false);
    return done(null,rows[0]);
  } catch(e){
    done(e);
  }
});

////////////////////////////////////////////////////////////////////////////////
// Express + session
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(bodyParser.urlencoded({extended:true}));
app.use(bodyParser.json());

const PgSession = pgSession(session);
app.use(session({
  store:new PgSession({
    pool,
    createTableIfMissing:true
  }),
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave:false,
  saveUninitialized:false
}));
app.use(passport.initialize());
app.use(passport.session());

function ensureAuth(req,res,next){
  if(req.isAuthenticated()) return next();
  if(req.path.startsWith('/api/')) {
    return res.status(401).json({error:'Not authenticated'});
  }
  return res.redirect('/html/login.html');
}
async function sendEmail(to, subject, text) {
  const msg = { to, from:'noreply@littlegiant.app', subject, text };
  await sgMail.send(msg);
}

////////////////////////////////////////////////////////////////////////////////
// bounding-box logic, 24-hour average, fallback for zero readings
////////////////////////////////////////////////////////////////////////////////

async function initializePurpleAirSensorsForAddress(addressId, userRadiusMiles) {
  const addrRes = await query('SELECT * FROM user_addresses WHERE id=$1',[addressId]);
  if(!addrRes.rows.length) return;
  const row = addrRes.rows[0];
  if(!row.lat || !row.lon) return;

  let radiusMiles = userRadiusMiles || 0.5;
  let attempts=0;
  const maxAttempts=5;
  let chosenSensors=[];

  while(!chosenSensors.length && attempts<maxAttempts) {
    attempts++;
    const latOff = radiusMiles / 69;
    const lonOff = radiusMiles / 69;
    const minLat = row.lat - latOff;
    const maxLat = row.lat + latOff;
    const minLon = row.lon - lonOff;
    const maxLon = row.lon + lonOff;

    const fields='sensor_index,last_seen,latitude,longitude,uptime,confidence,voc,pm1.0,pm2.5,pm2.5_60minute,pm2.5_alt,pm10.0,position_rating,ozone1';
    try {
      const resp = await axios.get('https://api.purpleair.com/v1/sensors', {
        headers: { 'X-API-Key': process.env.PURPLEAIR_API_KEY },
        params: {
          location_type:0,
          nwlng: minLon,
          nwlat: maxLat,
          selng: maxLon,
          selat: minLat,
          fields
        }
      });
      const data = resp.data?.data || [];
      if(!data.length){
        radiusMiles*=2;
        continue;
      }
      const nowSec = Math.floor(Date.now()/1000);
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
      sensorDetails = sensorDetails.filter(s=> (nowSec - s.lastSeen)<=3600);
      sensorDetails.forEach(s=>{
        s.distMiles = distanceMiles(row.lat, row.lon, s.lat, s.lon);
      });
      sensorDetails.sort((a,b)=> a.distMiles - b.distMiles);
      chosenSensors = sensorDetails.slice(0, 10);
    } catch(e){
      console.error('PurpleAir init error:', e.message);
      radiusMiles*=2;
      continue;
    }
  }

  if(!chosenSensors.length){
    await query('UPDATE user_addresses SET purpleair_sensor_ids=$1 WHERE id=$2',['', addressId]);
    return;
  }
  const sensorIDs = chosenSensors.map(s=> s.sensorIndex).join(',');
  await query('UPDATE user_addresses SET purpleair_sensor_ids=$1 WHERE id=$2',[sensorIDs, addressId]);
}

/**
 * Return the PurpleAir reading (cache)
 */
async function fetchPurpleAirForAddressWithCache(addressRow) {
  const key = `purple:${addressRow.lat},${addressRow.lon},${addressRow.purpleair_sensor_ids||''}`;
  const cached = memoPurple.get(key);
  if(cached && (nowMs()-cached.timestamp < MEMO_TTL_MS)) {
    return cached.data;
  }
  const data = await fetchPurpleAirForAddress(addressRow);
  memoPurple.set(key, {timestamp: nowMs(), data});
  return data;
}

/**
 * Actually fetch from PurpleAir
 */
async function fetchPurpleAirForAddress(addressRow) {
  if(!addressRow.purpleair_sensor_ids) {
    return { closest:0, average:0, debug:{ fallback:'No sensor IDs' } };
  }
  const showOnly = addressRow.purpleair_sensor_ids;
  if(!showOnly) {
    return { closest:0, average:0, debug:{ fallback:'No sensor IDs string' } };
  }
  const fields = [
    'sensor_index','last_seen','latitude','longitude','confidence','voc','pm1.0_cf_1',
    'pm2.5_cf_1','pm2.5_60minute','pm2.5_alt','pm10.0','position_rating','ozone1'
  ];
  try {
    const resp = await axios.get('https://api.purpleair.com/v1/sensors', {
      headers: { 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params: {
        location_type:0,
        show_only: showOnly,
        fields: fields.join(',')
      }
    });
    const actualFields = resp.data.fields || [];
    const data = resp.data.data || [];
    if(!data.length){
      return { closest:0, average:0, debug:{ showOnly, message:'No sensors from show_only' } };
    }
    const idxOf = {};
    actualFields.forEach((f,i)=> { idxOf[f]=i; });

    const nowSec = Math.floor(Date.now()/1000);
    let sensorDetails = data.map(arr => {
      const s = {
        sensorIndex: arr[idxOf['sensor_index']],
        lastSeen: arr[idxOf['last_seen']],
        lat: arr[idxOf['latitude']],
        lon: arr[idxOf['longitude']],
        confidence: arr[idxOf['confidence']],
        voc: arr[idxOf['voc']],
        pm1_0: arr[idxOf['pm1.0_cf_1']],
        pm2_5: arr[idxOf['pm2.5_cf_1']],
        pm2_5_60m: arr[idxOf['pm2.5_60minute']],
        pm2_5_alt: arr[idxOf['pm2.5_alt']],
        pm10_0: arr[idxOf['pm10.0']],
        ozone1: arr[idxOf['ozone1']],
      };
      const ageSec = nowSec - s.lastSeen;
      if(ageSec>3600) s.ignore=true;
      return s;
    });
    sensorDetails = sensorDetails.filter(s=> !s.ignore);
    if(!sensorDetails.length){
      return { closest:0, average:0, debug:{ showOnly, message:'All sensors older than 1 hour' } };
    }

    sensorDetails.forEach(s=>{
      s.distMiles = distanceMiles(addressRow.lat, addressRow.lon, s.lat, s.lon);
      let raw = s.pm2_5;
      if(raw==null) {
        if(s.pm2_5_60m!=null) raw = s.pm2_5_60m;
        else if(s.pm2_5_alt!=null) raw = s.pm2_5_alt;
        else raw=0;
      }
      s.aqi = pm25toAQI(raw);
    });

    let sum=0, count=0;
    let closestVal=0, closestDist=9999999;
    sensorDetails.forEach(s=>{
      sum+=s.aqi; count++;
      if(s.distMiles<closestDist) {
        closestDist=s.distMiles;
        closestVal=s.aqi;
      }
    });
    if(!count) {
      return { closest:0, average:0, debug:{ showOnly, message:'No valid sensors after filter' } };
    }
    const avg = Math.round(sum/count);
    return {
      closest: closestVal,
      average: avg,
      debug:{
        approach:'show_only',
        lat: addressRow.lat,
        lon: addressRow.lon,
        sensorCount: count,
        nearestDistance: closestDist,
        sensors: sensorDetails.map(s=>({
          sensorIndex: s.sensorIndex,
          lat: s.lat,
          lon: s.lon,
          distMiles: s.distMiles,
          aqi: s.aqi,
          lastSeen: s.lastSeen
        }))
      }
    };
  } catch(e){
    return { closest:0, average:0, debug:{ error:e.message } };
  }
}

/**
 * AirNow fetch w/ bounding box expansion
 */
async function fetchAirNowAQIWithCache(lat, lon, initialMiles) {
  const key = `airnow:${lat},${lon},${initialMiles}`;
  const cached = memoAirNow.get(key);
  if(cached && (nowMs()-cached.timestamp < MEMO_TTL_MS)) {
    return cached.data;
  }
  const result = await fetchAirNowAQI(lat, lon, initialMiles);
  memoAirNow.set(key, {timestamp: nowMs(), data: result});
  return result;
}

async function fetchAirNowAQI(lat, lon, initialMiles) {
  let radiusMiles = initialMiles || 0.5;
  let attempts=0, foundSensors=false;
  const maxAttempts=5;
  const final = {
    closest: 0,
    average: 0,
    debug: {
      approach:'autoExpand',
      lat, lon,
      tries:[]
    }
  };
  while(!foundSensors && attempts<maxAttempts) {
    attempts++;
    const degOff = radiusMiles / 69;
    const minLat = lat - degOff;
    const maxLat = lat + degOff;
    const minLon = lon - degOff;
    const maxLon = lon + degOff;

    let debugInfo = {
      pass: attempts,
      radiusMiles,
      boundingBox: { minLat,maxLat,minLon,maxLon }
    };
    const hourStr = new Date().toISOString().slice(0,13);
    try {
      const resp = await axios.get('https://www.airnowapi.org/aq/data/', {
        params: {
          startDate: hourStr,
          endDate: hourStr,
          parameters:'pm25',
          BBOX: `${minLon},${minLat},${maxLon},${maxLat}`,
          dataType:'A',
          format:'application/json',
          verbose:0,
          API_KEY: process.env.AIRNOW_API_KEY
        }
      });
      if(!Array.isArray(resp.data) || !resp.data.length){
        debugInfo.message='No sensors returned';
        final.debug.tries.push(debugInfo);
        radiusMiles*=2;
      } else {
        let sensorDetails=[];
        resp.data.forEach(s=>{
          const dist = distanceMiles(lat, lon, s.Latitude, s.Longitude);
          sensorDetails.push({
            lat: s.Latitude,
            lon: s.Longitude,
            aqi: s.AQI,
            dist
          });
        });
        sensorDetails = sensorDetails.filter(x=> x.dist<=radiusMiles);
        if(!sensorDetails.length){
          debugInfo.message='No sensors within radiusMiles in returned data';
          final.debug.tries.push(debugInfo);
          radiusMiles*=2;
        } else {
          let sum=0, count=0, closestDist=9999999, closestVal=0;
          for(const sd of sensorDetails){
            sum+=sd.aqi; count++;
            if(sd.dist<closestDist) {
              closestDist=sd.dist;
              closestVal=sd.aqi;
            }
          }
          const avg = Math.round(sum/count);
          debugInfo.sensorCount = count;
          debugInfo.closestDist = closestDist;
          debugInfo.closestAQI = closestVal;
          debugInfo.averageAQI = avg;
          final.closest=closestVal;
          final.average=avg;
          final.debug.tries.push(debugInfo);
          foundSensors=true;
          final.debug.nearestDistance=closestDist;
        }
      }
    } catch(e){
      debugInfo.error=e.message;
      final.debug.tries.push(debugInfo);
      radiusMiles*=2;
    }
  }
  return final;
}

async function fetchOpenWeather(lat, lon) {
  const debugInfo = { lat, lon };
  try {
    const url='https://api.openweathermap.org/data/2.5/weather';
    const resp = await axios.get(url,{
      params:{
        lat, lon,
        appid: process.env.OPENWEATHER_API_KEY,
        units:'imperial'
      }
    });
    const wind=resp.data.wind || {};
    const main=resp.data.main || {};
    debugInfo.temperatureF = main.temp;
    debugInfo.humidity = main.humidity;
    debugInfo.windSpeed = wind.speed;
    debugInfo.windDeg = wind.deg;

    return {
      tempF: main.temp || 0,
      humidity: main.humidity || 0,
      windSpeed: wind.speed || 0,
      windDeg: wind.deg || 0,
      windDir: getCardinal(wind.deg),
      debug: debugInfo
    };
  } catch(e){
    debugInfo.error = e.message;
    return {tempF:0, humidity:0, windSpeed:0, windDeg:0, windDir:'Unknown', debug:debugInfo};
  }
}

/**
 * We only want to show an OpenWeather "24hr average" if we have 24 or more data points
 */
async function getOpenWeather24hrAverages(addressId) {
  const since = new Date(Date.now() - 24*3600*1000);
  const res = await query(`
    SELECT
      COUNT(*) as cnt,
      AVG((data_json->>'tempF')::numeric) as avgTemp,
      AVG((data_json->>'windSpeed')::numeric) as avgWindSpeed,
      AVG((data_json->>'windDeg')::numeric) as avgWindDeg
    FROM address_hourly_data
    WHERE address_id=$1
      AND source='OpenWeather'
      AND timestamp >= $2
  `,[addressId, since]);

  if(!res.rows.length) return null;
  const row = res.rows[0];
  const count = Number(row.cnt) || 0;
  if(count < 24) {
    // Not enough data for a 24-hr average
    return null;
  }
  return {
    avgTemp: Number(row.avgtemp)||0,
    avgWindSpeed: Number(row.avgwindspeed)||0,
    avgWindDeg: Number(row.avgwinddeg)||0,
    windCardinal: getCardinal(row.avgwinddeg)
  };
}

async function earliestTimestampForAddress(addressId, source) {
  let condition = '';
  if(source==='AirNow' || source==='PurpleAir') {
    condition='AND aqi_closest>0';
  }
  const res = await query(`
    SELECT MIN(timestamp) as mint
    FROM address_hourly_data
    WHERE address_id=$1
      AND source=$2
      ${condition}
  `,[addressId, source]);
  if(!res.rows.length || !res.rows[0].mint) return null;
  return new Date(res.rows[0].mint);
}

/**
 * Show "Available at earliest + 24 hours" if not enough data
 */
function format24hrAvailable(earliest) {
  if(!earliest) return 'No data yet';
  const t = new Date(earliest.getTime() + 24*3600*1000);
  return formatDayTimeForUser(t);
}

/**
 * Update trailing 24h averages for AirNow or PurpleAir if we have 24 data points
 */
async function updateTrailing24hAverages(userId, addressId, timestamp, source) {
  let condition='';
  if(source==='AirNow' || source==='PurpleAir') {
    // skip zero or null
    condition='AND aqi_closest>0';
  }
  const rows = await query(`
    SELECT
      COUNT(*) as cnt,
      AVG(aqi_closest) as cAvg,
      AVG(aqi_average) as rAvg
    FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND source=$3
      AND timestamp >= $4
      ${condition}
  `, [userId, addressId, source, new Date(timestamp.getTime() - 24*3600*1000)]);

  if(!rows.rows.length) return;
  const row = rows.rows[0];
  const count = Number(row.cnt)||0;
  const c24 = Math.round(row.cavg||0);
  const r24 = Math.round(row.ravg||0);

  // find newly inserted row
  const newRow = await query(`
    SELECT *
    FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND source=$3
      AND timestamp=$4
  `,[userId, addressId, source, timestamp]);
  if(!newRow.rows.length) return;

  let dbRow = newRow.rows[0];
  let d = dbRow.data_json||{};

  if(count>=24){
    d.closest24hrAvg = c24;
    d.radius24hrAvg = r24;
    await query(`
      UPDATE address_hourly_data
      SET data_json=$1,
          closest_24hr_avg=$2,
          radius_24hr_avg=$3
      WHERE id=$4
    `,[d, c24, r24, dbRow.id]);
  } else {
    // Not enough data => clear out 24hr
    delete d.closest24hrAvg;
    delete d.radius24hrAvg;
    await query(`
      UPDATE address_hourly_data
      SET data_json=$1,
          closest_24hr_avg=NULL,
          radius_24hr_avg=NULL
      WHERE id=$2
    `,[d, dbRow.id]);
  }
}

/**
 * For each user, fetch new hourly data from AirNow, PurpleAir, OpenWeather
 */
async function fetchAndStoreHourlyDataForUser(userId) {
  const userRes = await query('SELECT aqi_radius FROM users WHERE id=$1',[userId]);
  if(!userRes.rows.length) return;
  const radiusMiles = userRes.rows[0].aqi_radius || 0.5;

  const addrRes = await query(`
    SELECT id,user_id,address,lat,lon,purpleair_sensor_ids
    FROM user_addresses
    WHERE user_id=$1
  `,[userId]);

  for(const adr of addrRes.rows){
    if(!adr.lat || !adr.lon) continue;

    if(!adr.purpleair_sensor_ids){
      await initializePurpleAirSensorsForAddress(adr.id, radiusMiles);
      const upd = await query('SELECT * FROM user_addresses WHERE id=$1',[adr.id]);
      if(upd.rows.length){
        adr.purpleair_sensor_ids = upd.rows[0].purpleair_sensor_ids;
      }
    }

    const airRes = await fetchAirNowAQIWithCache(adr.lat, adr.lon, radiusMiles);
    const purpleRes = await fetchPurpleAirForAddressWithCache(adr);
    const owRes = await fetchOpenWeather(adr.lat, adr.lon);

    const now = new Date();

    // AirNow
    let dataAir = {
      type:'AirNow',
      fetchedAt: now.toISOString(),
      closestAQI: airRes.closest,
      radiusAQI: airRes.average,
      debug: airRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'AirNow',$4,$5,$6)
      ON CONFLICT DO NOTHING
    `,[userId, adr.id, now, airRes.closest, airRes.average, dataAir]);
    await updateTrailing24hAverages(userId, adr.id, now, 'AirNow');

    // PurpleAir
    let dataPA = {
      type:'PurpleAir',
      fetchedAt: now.toISOString(),
      closestAQI: purpleRes.closest,
      radiusAQI: purpleRes.average,
      debug: purpleRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'PurpleAir',$4,$5,$6)
      ON CONFLICT DO NOTHING
    `,[userId, adr.id, now, purpleRes.closest, purpleRes.average, dataPA]);
    await updateTrailing24hAverages(userId, adr.id, now, 'PurpleAir');

    // OpenWeather
    let dataOW = {
      type:'OpenWeather',
      fetchedAt: now.toISOString(),
      tempF: owRes.tempF,
      humidity: owRes.humidity,
      windSpeed: owRes.windSpeed,
      windDeg: owRes.windDeg,
      windDir: owRes.windDir,
      debug: owRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'OpenWeather',0,0,$4)
      ON CONFLICT DO NOTHING
    `,[userId, adr.id, now, dataOW]);
    await updateTrailing24hAverages(userId, adr.id, now, 'OpenWeather');
  }
}

/**
 * If the newest row is 0 for AirNow/PurpleAir, we fallback to a previous row
 */
async function latestSourceRow(addressId, source) {
  let rec = await query(`
    SELECT * FROM address_hourly_data
    WHERE address_id=$1 AND source=$2
    ORDER BY timestamp DESC
    LIMIT 1
  `,[addressId, source]);
  if(!rec.rows.length) return null;
  const newest = rec.rows[0];

  if((source==='AirNow' || source==='PurpleAir') && (!newest.aqi_closest || newest.aqi_closest===0)) {
    // fallback
    let fbRec = await query(`
      SELECT * FROM address_hourly_data
      WHERE address_id=$1 AND source=$2
        AND aqi_closest>0
      ORDER BY timestamp DESC
      LIMIT 1
    `,[addressId, source]);
    if(!fbRec.rows.length) {
      return newest; // no older non-zero
    } else {
      let fb = fbRec.rows[0];
      fb.isFallback = true;
      fb.fallbackFromTimestamp = newest.timestamp;
      return fb;
    }
  }
  return newest;
}

////////////////////////////////////////////////////////////////////////////////
// CRON
////////////////////////////////////////////////////////////////////////////////

cron.schedule('0 * * * *', async()=>{
  console.log('[CRON] hourly triggered');
  try {
    const {rows:users} = await query('SELECT id FROM users');
    for(const u of users){
      await fetchAndStoreHourlyDataForUser(u.id);
    }
  } catch(e){
    console.error('[CRON hourly]', e);
  }
});

// daily in 15-min blocks
cron.schedule('*/15 * * * *', async()=>{
  console.log('[CRON] daily check');
  try {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const block = Math.floor(minute/15)*15;
    const {rows:dueUsers} = await query(`
      SELECT id,email
      FROM users
      WHERE daily_report_hour=$1
        AND daily_report_minute=$2
    `,[hour, block]);
    for(const du of dueUsers){
      await fetchAndStoreHourlyDataForUser(du.id);
      const final = await buildDailyEmail(du.id);
      if(final){
        await sendEmail(du.email, 'Your Daily AQI Update', final);
        console.log(`Sent daily update to ${du.email}`);
      }
    }
  } catch(e){
    console.error('[CRON daily check]', e);
  }
});

/**
 * Build the daily email for a user
 */
async function buildDailyEmail(userId) {
  const addrRes = await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  if(!addrRes.rows.length) return null;

  let lines = [];
  for(const adr of addrRes.rows) {
    if(!adr.lat || !adr.lon) {
      lines.push(`Address: ${adr.address}\n(No lat/lon)`);
      continue;
    }
    lines.push(`Address: ${adr.address}`);

    // OpenWeather 24hr
    const owAvg = await getOpenWeather24hrAverages(adr.id);
    if(owAvg) {
      lines.push(`OpenWeather 24hr: Temp=${Math.round(owAvg.avgTemp)}°F, Wind=${Math.round(owAvg.avgWindSpeed)} mph from ${owAvg.windCardinal} (${Math.round(owAvg.avgWindDeg)}°)`);
    }

    // AirNow
    const an = await latestSourceRow(adr.id, 'AirNow');
    if(an) {
      let c = an.aqi_closest || 0;
      let r = an.aqi_average || 0;
      let c24 = an.closest_24hr_avg;
      let r24 = an.radius_24hr_avg;
      if(c24==null) {
        const earliest = await earliestTimestampForAddress(adr.id,'AirNow');
        c24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      if(r24==null) {
        const earliest = await earliestTimestampForAddress(adr.id,'AirNow');
        r24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      let fbNote = '';
      if(an.isFallback) {
        fbNote = `(Fallback from latest reading: ${formatDayTimeForUser(an.fallbackFromTimestamp)})`;
      }
      lines.push(`AirNow: Closest AQI=${c}, Radius Avg=${r}, c24=${c24}, r24=${r24} ${fbNote}`);
    } else {
      lines.push('AirNow: No data');
    }

    // PurpleAir
    const pa = await latestSourceRow(adr.id, 'PurpleAir');
    if(pa) {
      let c = pa.aqi_closest || 0;
      let r = pa.aqi_average || 0;
      let c24 = pa.closest_24hr_avg;
      let r24 = pa.radius_24hr_avg;
      if(c24==null) {
        const earliest = await earliestTimestampForAddress(adr.id,'PurpleAir');
        c24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      if(r24==null) {
        const earliest = await earliestTimestampForAddress(adr.id,'PurpleAir');
        r24 = `Available at ${format24hrAvailable(earliest)}`;
      }
      let fbNote = '';
      if(pa.isFallback) {
        fbNote = `(Fallback from latest reading: ${formatDayTimeForUser(pa.fallbackFromTimestamp)})`;
      }
      lines.push(`PurpleAir: Closest AQI=${c}, Radius Avg=${r}, c24=${c24}, r24=${r24} ${fbNote}`);
    } else {
      lines.push('PurpleAir: No data');
    }

    // The newest openweather row
    const ow = await latestSourceRow(adr.id, 'OpenWeather');
    if(ow) {
      const d = ow.data_json||{};
      lines.push(`OpenWeather: Temp=${d.tempF||0}°F, Wind=${d.windSpeed||0} mph from ${d.windDir||'??'} (${d.windDeg||0}°)`);
    } else {
      lines.push('OpenWeather: No data');
    }
    lines.push(''); // blank line between addresses
  }
  return lines.join('\n');
}

////////////////////////////////////////////////////////////////////////////////
// Build the HTML for the dashboard
////////////////////////////////////////////////////////////////////////////////

function escapeHtml(str) {
  return str.replace(/[<>&]/g, c => {
    switch(c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
    }
    return c;
  });
}

function buildDebugPopupHTML(debugObj, title){
  const raw = JSON.stringify(debugObj, null, 2);
  const safe = escapeHtml(raw);
  return `<h3>${title}</h3><pre>${safe}</pre>`;
}

async function buildAirNowSection(adr, an) {
  if(!an) return `<p>AirNow => No data</p>`;
  const c = an.aqi_closest||0;
  const r = an.aqi_average||0;
  const cat = colorCodeAQI(c);
  const cStyle = getAQIColorStyle(c);
  const rStyle = getAQIColorStyle(r);

  let c24 = an.closest_24hr_avg;
  let r24 = an.radius_24hr_avg;
  if(c24==null){
    const earliest = await earliestTimestampForAddress(adr.id,'AirNow');
    c24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  if(r24==null){
    const earliest = await earliestTimestampForAddress(adr.id,'AirNow');
    r24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  const c24Style = (typeof c24 === 'number') ? getAQIColorStyle(c24) : '';
  const r24Style = (typeof r24 === 'number') ? getAQIColorStyle(r24) : '';

  let fallbackNote = '';
  if(an.isFallback) {
    fallbackNote = `<br><em>Fallback from latest reading: ${formatDayTimeForUser(an.fallbackFromTimestamp)}</em>`;
  }

  const debugHTML = encodeURIComponent(buildDebugPopupHTML(an.data_json?.debug||{}, 'AirNow Debug'));
  let nearestLine = an.data_json?.debug?.nearestDistance
    ? `${an.data_json.debug.nearestDistance.toFixed(1)} miles away`
    : '';

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
          <a href="#" onclick="showDetailPopup(decodeURIComponent('${debugHTML}'));return false;">[details]</a>
          ${fallbackNote}
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
        <td>Nearest Sensor Dist.</td>
        <td>${nearestLine}</td>
      </tr>
      <tr>
        <td colspan="2">
          <a href="#" onclick="showMapPopup('AirNow','${encodeURIComponent(JSON.stringify(adr))}','${encodeURIComponent(JSON.stringify(an))}');return false;">
            [view on map]
          </a>
        </td>
      </tr>
    </tbody>
  </table>
  `;
}

async function buildPurpleAirSection(adr, pa) {
  if(!pa) return `<p>PurpleAir => No data</p>`;
  const c = pa.aqi_closest||0;
  const r = pa.aqi_average||0;
  const cat = colorCodeAQI(c);
  const cStyle = getAQIColorStyle(c);
  const rStyle = getAQIColorStyle(r);

  let c24 = pa.closest_24hr_avg;
  let r24 = pa.radius_24hr_avg;
  if(c24==null){
    const earliest = await earliestTimestampForAddress(adr.id,'PurpleAir');
    c24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  if(r24==null){
    const earliest = await earliestTimestampForAddress(adr.id,'PurpleAir');
    r24 = `Available at ${format24hrAvailable(earliest)}`;
  }
  const c24Style = (typeof c24==='number')? getAQIColorStyle(c24):'';
  const r24Style = (typeof r24==='number')? getAQIColorStyle(r24):'';

  let fallbackNote = '';
  if(pa.isFallback){
    fallbackNote = `<br><em>Fallback from latest reading: ${formatDayTimeForUser(pa.fallbackFromTimestamp)}</em>`;
  }
  const debugHTML = encodeURIComponent(buildDebugPopupHTML(pa.data_json?.debug||{}, 'PurpleAir Debug'));
  let nearestLine = pa.data_json?.debug?.nearestDistance
    ? `${pa.data_json.debug.nearestDistance.toFixed(1)} miles away`
    : '';

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
          <a href="#" onclick="showDetailPopup(decodeURIComponent('${debugHTML}'));return false;">[details]</a>
          ${fallbackNote}
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
        <td>Nearest Sensor Dist.</td>
        <td>${nearestLine}</td>
      </tr>
      <tr>
        <td colspan="2">
          <a href="#" onclick="showMapPopup('PurpleAir','${encodeURIComponent(JSON.stringify(adr))}','${encodeURIComponent(JSON.stringify(pa))}');return false;">
            [view on map]
          </a>
        </td>
      </tr>
    </tbody>
  </table>
  `;
}

async function buildOpenWeatherSection(adr, ow) {
  if(!ow) return `<p>OpenWeather => No data</p>`;
  const d = ow.data_json||{};

  // 24hr
  const avg = await getOpenWeather24hrAverages(adr.id);
  let avgInfo='';
  if(!avg) {
    // not enough data
    const earliest = await earliestTimestampForAddress(adr.id,'OpenWeather');
    avgInfo = `Available at ${format24hrAvailable(earliest)}`;
  } else {
    const t = Math.round(avg.avgTemp);
    const wS = Math.round(avg.avgWindSpeed);
    const wD = Math.round(avg.avgWindDeg);
    const wC = avg.windCardinal;
    avgInfo = `Temp=${t}F, Wind=${wS} mph from ${wC} (${wD}°)`;
  }

  const debugHTML = encodeURIComponent(buildDebugPopupHTML(d.debug||{}, 'OpenWeather Debug'));
  return `
  <table style="border-collapse:collapse;width:100%;margin-bottom:10px;">
    <thead>
      <tr style="background:#f0f0f0;"><th colspan="2">OpenWeather</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>Current Hourly</td>
        <td>
          Temp=${d.tempF||0}F,
          Wind=${d.windSpeed||0} mph from ${d.windDir||'??'} (${d.windDeg||0}°)
          <a href="#" onclick="showDetailPopup(decodeURIComponent('${debugHTML}'));return false;">[details]</a>
        </td>
      </tr>
      <tr>
        <td>24hr Average</td>
        <td>${avgInfo}</td>
      </tr>
      <tr>
        <td colspan="2">
          <a href="#" onclick="showMapPopup('OpenWeather','${encodeURIComponent(JSON.stringify(adr))}','${encodeURIComponent(JSON.stringify(ow))}');return false;">
            [view on map]
          </a>
        </td>
      </tr>
    </tbody>
  </table>
  `;
}

/**
 * Combine for an address
 */
async function buildAddressReportHTML(adr) {
  let an = await latestSourceRow(adr.id,'AirNow');
  let pa = await latestSourceRow(adr.id,'PurpleAir');
  let ow = await latestSourceRow(adr.id,'OpenWeather');

  let html='';
  html += await buildAirNowSection(adr, an);
  html += await buildPurpleAirSection(adr, pa);
  html += await buildOpenWeatherSection(adr, ow);
  return html;
}

////////////////////////////////////////////////////////////////////////////////
// API endpoints
////////////////////////////////////////////////////////////////////////////////

// Return the user's addresses
app.get('/api/list-addresses', ensureAuth, async(req,res)=>{
  const {rows} = await query('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY id',[req.user.id]);
  res.json(rows);
});

// Return the user's combined report
app.get('/api/myReport', ensureAuth, async(req,res)=>{
  try {
    const addrRes = await query('SELECT * FROM user_addresses WHERE user_id=$1',[req.user.id]);
    if(!addrRes.rows.length){
      return res.json({error:'No addresses. Please add an address.'});
    }
    let html='';
    for(const adr of addrRes.rows){
      html+=`<h4>Address: ${adr.address}</h4>`;
      if(!adr.lat || !adr.lon){
        html+=`<p>(No lat/lon, cannot produce AQI)</p>`;
      } else {
        html += await buildAddressReportHTML(adr);
      }
    }
    res.json({html});
  } catch(e){
    console.error('[myReport error]', e);
    res.status(500).json({error:'Internal server error'});
  }
});

// Return static map URL
app.get('/api/getMapUrl', async(req,res)=>{
  const {source, lat, lon, data} = req.query;
  if(!source || !lat || !lon){
    return res.status(400).json({error:'Missing required parameters'});
  }
  try {
    let url='';
    const adr = { lat: parseFloat(lat), lon: parseFloat(lon) };
    let parsed = {};
    if(data) {
      try {
        parsed = JSON.parse(decodeURIComponent(data));
      } catch(e){
        console.error('Error parsing data JSON:', e);
      }
    }
    if(source==='OpenWeather'){
      url = generateGoogleMapsUrlForOpenWeather(adr, { data_json: parsed });
    } else if(source==='AirNow'){
      url = generateGoogleMapsUrlForAirNow(adr, { data_json: parsed });
    } else if(source==='PurpleAir'){
      url = generateGoogleMapsUrlForPurpleAir(adr, { data_json: parsed });
    } else {
      return res.status(400).json({error:'Unknown source'});
    }
    res.json({url});
  } catch(e){
    console.error(e);
    return res.status(500).json({error:'Server error'});
  }
});

// Serve static from __dirname
app.use(express.static(__dirname));

// Root route
app.get('/', (req,res)=>{
  if(req.isAuthenticated()) return res.redirect('/html/dashboard.html');
  res.sendFile(path.join(__dirname,'index.html'));
});

// google places key
app.get('/js/autocomplete.js',(req,res)=>{
  const key = process.env.GOOGLE_GEOCODE_KEY || '';
  const content = `
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
  const { email, password, password2, address, agreePolicy, agreeTerms } = req.body;
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
  try {
    const hash = await bcrypt.hash(password,10);
    const userRes = await query(`
      INSERT INTO users(email,password_hash,latest_report)
      VALUES($1,$2,$3)
      RETURNING id
    `,[email, hash, JSON.stringify({})]);
    const newUserId = userRes.rows[0].id;

    if(address && address.trim()){
      let lat=null, lon=null;
      if(process.env.GOOGLE_GEOCODE_KEY) {
        const geoURL='https://maps.googleapis.com/maps/api/geocode/json';
        const resp = await axios.get(geoURL,{params:{address,key:process.env.GOOGLE_GEOCODE_KEY}});
        if(resp.data.results?.length){
          lat=resp.data.results[0].geometry.location.lat;
          lon=resp.data.results[0].geometry.location.lng;
        }
      }
      await query(`
        INSERT INTO user_addresses(user_id,address,lat,lon)
        VALUES($1,$2,$3,$4)
      `,[newUserId, address.trim(), lat, lon]);
    }

    const dashLink = `${process.env.APP_URL||'http://localhost:3000'}/html/dashboard.html`;
    await sendEmail(email,'Welcome to AQI Updates', `Thanks for signing up!\n${dashLink}\nEnjoy!`);
    res.redirect('/html/login.html');
  } catch(e){
    console.error('[signup error]', e);
    res.status(500).send('Error signing up');
  }
});

// add-address
app.post('/api/add-address', ensureAuth, async(req,res)=>{
  const {address} = req.body;
  if(!address) return res.status(400).send('No address provided');
  const cnt = await query('SELECT COUNT(*) FROM user_addresses WHERE user_id=$1',[req.user.id]);
  const c = parseInt(cnt.rows[0].count,10);
  if(c>=3){
    return res.status(400).send('Max 3 addresses allowed');
  }
  let lat=null, lon=null;
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

// delete-address
app.post('/api/delete-address', ensureAuth, async(req,res)=>{
  const { addressId } = req.body;
  if(!addressId) return res.status(400).send('No addressId');
  try {
    await query('DELETE FROM address_hourly_data WHERE address_id=$1 AND user_id=$2',[addressId, req.user.id]);
    await query('DELETE FROM user_addresses WHERE id=$1 AND user_id=$2',[addressId, req.user.id]);
    return res.redirect('/html/dashboard.html');
  } catch(e){
    console.error('[delete-address error]', e);
    return res.status(500).send('Error deleting address');
  }
});

// set-aqi-radius
app.post('/api/set-aqi-radius', ensureAuth, async(req,res)=>{
  const {radius} = req.body;
  if(!radius) return res.status(400).json({error:'No radius'});
  await query('UPDATE users SET aqi_radius=$1 WHERE id=$2',[parseInt(radius,10), req.user.id]);
  res.json({success:true});
});

// set-daily-time
app.post('/api/set-daily-time', ensureAuth, async(req,res)=>{
  const {hour, minute} = req.body;
  if(hour===undefined||minute===undefined) {
    return res.status(400).json({error:'Missing hour/minute'});
  }
  await query('UPDATE users SET daily_report_hour=$1, daily_report_minute=$2 WHERE id=$3',
    [parseInt(hour,10), parseInt(minute,10), req.user.id]);
  res.json({success:true});
});

// "Update my report now"
app.post('/api/report-now', ensureAuth, async(req,res)=>{
  try {
    await fetchAndStoreHourlyDataForUser(req.user.id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const r = await axios.get(`${baseUrl}/api/myReport`, {
      headers:{ cookie: req.headers.cookie||'' }
    });
    res.json(r.data);
  } catch(e){
    console.error('[report-now error]', e);
    res.status(502).json({error:'Error: '+e});
  }
});

// logout
app.get('/logout', (req,res)=>{
  req.logout(()=>{
    res.redirect('/html/login.html');
  });
});

// forgot password
app.post('/api/forgot', async(req,res)=>{
  const {email} = req.body;
  if(!email) return res.status(400).send('No email');
  const {rows} = await query('SELECT id FROM users WHERE email=$1',[email]);
  if(!rows.length){
    return res.send('If found, a reset link is sent.');
  }
  const userId = rows[0].id;
  const token = crypto.randomBytes(20).toString('hex');
  const expires = new Date(Date.now()+3600000);
  await query(`
    INSERT INTO password_reset_tokens(user_id,token,expires_at)
    VALUES($1,$2,$3)
  `,[userId, token, expires]);
  const link = `${process.env.APP_URL||'http://localhost:3000'}/html/reset.html?token=${token}`;
  await sendEmail(email,'Password Reset', `Click here:\n${link}`);
  res.send('If found, a reset link is emailed.');
});

// reset password
app.post('/api/reset', async(req,res)=>{
  const {token,newPassword} = req.body;
  if(!token||!newPassword) return res.status(400).send('Missing token or newPassword');
  if(newPassword.length<8||!/[0-9]/.test(newPassword)||!/[A-Za-z]/.test(newPassword)||!/[^A-Za-z0-9]/.test(newPassword)){
    return res.status(400).send('New password not complex enough');
  }
  const now=new Date();
  const {rows} = await query(`
    SELECT user_id FROM password_reset_tokens
    WHERE token=$1 AND expires_at>$2
  `,[token, now]);
  if(!rows.length) return res.status(400).send('Invalid/expired token');
  const userId=rows[0].user_id;
  const hash=await bcrypt.hash(newPassword,10);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,userId]);
  await query('DELETE FROM password_reset_tokens WHERE token=$1',[token]);
  res.send('Password reset. <a href="login.html">Log in</a>');
});

// delete-account
app.post('/api/delete-account', ensureAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await query('SELECT email FROM users WHERE id=$1', [userId]);
    if (!rows.length) {
      return req.logout(() => res.redirect('/index.html'));
    }
    const userEmail = rows[0].email;
    await query('DELETE FROM address_hourly_data WHERE user_id=$1', [userId]);
    await query('DELETE FROM user_addresses WHERE user_id=$1', [userId]);
    await query('DELETE FROM users WHERE id=$1', [userId]);

    req.logout(() => {
      sendEmail(
        userEmail,
        'Account Deleted',
        `Your account is deleted.\nNo more emails.\nIf you want to sign up again, please do so from the main site.`
      ).catch(e => console.error('[delete-account email]', e));
      res.redirect('/index.html');
    });
  } catch (e) {
    console.error('[delete-account error]', e);
    return res.status(500).send('Error deleting account');
  }
}); 

// local login
app.post('/api/login',
  passport.authenticate('local', { failureRedirect: '/html/login.html' }),
  (req, res) => res.redirect('/html/dashboard.html')
);

// google oauth
app.get('/auth/google', passport.authenticate('google',{scope:['email','profile']}));
app.get('/auth/google/callback',
  passport.authenticate('google',{failureRedirect:'/html/login.html'}),
  (req,res)=> res.redirect('/html/dashboard.html')
);

// apple oauth
app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple',{failureRedirect:'/html/login.html'}),
  (req,res)=>res.redirect('/html/dashboard.html')
);

// start server
const port = process.env.PORT || 3000;
app.listen(port, async()=>{
  await initDB();
  console.log(`Server running on port ${port}`);
});
