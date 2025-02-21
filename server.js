// server.js
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pkg from 'pg';
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
import './auth.js';
import { distanceMiles, colorCodeAQI } from './utils.js'; 
// colorCodeAQI returns a string like "Good", "Moderate", "Unhealthy", etc. 
// or you can have it return a CSS color code. We'll assume it returns the category name.

import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});
const PgSession = pgSession(session);

const app = express();
app.use(bodyParser.urlencoded({ extended:true }));
app.use(bodyParser.json());
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Serve static
app.use(express.static(__dirname));

// Helper to send email
async function sendEmail(to, subject, text){
  const msg={to, from:'noreply@littlegiant.app', subject, text};
  await sgMail.send(msg);
}

// Helper: ensureAuth
function ensureAuth(req,res,next){
  if(req.isAuthenticated()) return next();
  if(req.path.startsWith('/api/')){
    return res.status(401).json({error:'Not authenticated'});
  }
  return res.redirect('/html/login.html');
}

/**
 * A small helper to get cardinal direction from wind degrees.
 * E.g. 0 = N, 90 = E, 180 = S, 270 = W, etc.
 */
function getCardinal(deg){
  if (deg == null) return 'Unknown';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx];
}

// === (A) API calls: AirNow, PurpleAir, OpenWeather

async function fetchAirNowInRadius(lat, lon, radiusMiles) {
  const debugInfo = { lat, lon, radiusMiles };
  try {
    // bounding box
    const latOffset = 0.2;
    const lonOffset = 0.2;
    const minLat = lat - latOffset;
    const maxLat = lat + latOffset;
    const minLon = lon - lonOffset;
    const maxLon = lon + lonOffset;
    debugInfo.boundingBox = { minLon, minLat, maxLon, maxLat };

    const url = 'https://www.airnowapi.org/aq/data/';
    const hourStr = new Date().toISOString().slice(0,13);
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

    debugInfo.sensorCount = 0;
    if (!Array.isArray(resp.data) || resp.data.length === 0) {
      debugInfo.message = 'No AirNow sensors returned';
      return { closest: 0, average: 0, debug: debugInfo };
    }
    debugInfo.sensorCount = resp.data.length;

    let closestDist = Infinity;
    let closestVal = null;
    let sum = 0;
    let count = 0;
    const sensorDetails = [];
    for (const sensor of resp.data) {
      const sLat = sensor.Latitude;
      const sLon = sensor.Longitude;
      const dist = distanceMiles(lat, lon, sLat, sLon);
      sensorDetails.push({
        lat: sLat,
        lon: sLon,
        aqi: sensor.AQI,
        distance: dist
      });
      if (dist <= radiusMiles) {
        sum += sensor.AQI;
        count++;
        if (dist < closestDist) {
          closestDist = dist;
          closestVal = sensor.AQI;
        }
      }
    }
    debugInfo.sensors = sensorDetails.filter(s => s.distance <= radiusMiles);

    if (!count) {
      debugInfo.message = 'No AirNow sensors within radius';
      return { closest: 0, average: 0, debug: debugInfo };
    }
    const avg = Math.round(sum / count);
    return { closest: closestVal || 0, average: avg, debug: debugInfo };
  } catch (err) {
    debugInfo.error = err.message;
    return { closest: 0, average: 0, debug: debugInfo };
  }
}

async function fetchPurpleAirInRadius(lat, lon, radiusMiles) {
  const debugInfo = { lat, lon, radiusMiles };
  try {
    const latOffset = 0.2;
    const lonOffset = 0.2;
    const minLat = lat - latOffset;
    const maxLat = lat + latOffset;
    const minLon = lon - lonOffset;
    const maxLon = lon + lonOffset;
    debugInfo.boundingBox = { minLon, minLat, maxLon, maxLat };

    const url = 'https://api.purpleair.com/v1/sensors';
    const resp = await axios.get(url, {
      headers: { 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params: {
        fields: 'pm2.5,latitude,longitude',
        nwlng: minLon,
        nwlat: maxLat,
        selng: maxLon,
        selat: minLat
      }
    });

    debugInfo.sensorCount = 0;
    if (!resp.data || !resp.data.data) {
      debugInfo.message = 'No PurpleAir data returned';
      return { closest: 0, average: 0, debug: debugInfo };
    }
    debugInfo.sensorCount = resp.data.data.length;

    let closestDist = Infinity;
    let closestVal = null;
    let sum = 0;
    let count = 0;
    const sensorDetails = [];
    for (const sensor of resp.data.data) {
      // sensor = [id, pm2.5, lat, lon, ...]
      const pm25 = sensor[1];
      const sLat = sensor[2];
      const sLon = sensor[3];
      const dist = distanceMiles(lat, lon, sLat, sLon);
      sensorDetails.push({
        pm25,
        lat: sLat,
        lon: sLon,
        distance: dist
      });
      if (dist <= radiusMiles) {
        sum += pm25;
        count++;
        if (dist < closestDist) {
          closestDist = dist;
          closestVal = pm25;
        }
      }
    }
    debugInfo.sensors = sensorDetails.filter(s => s.distance <= radiusMiles);

    if (!count) {
      debugInfo.message = 'No PurpleAir sensors within radius';
      return { closest: 0, average: 0, debug: debugInfo };
    }
    const avg = Math.round(sum / count);
    // You may want to convert pm2.5 to AQI. For simplicity, let's just treat pm2.5 as an “AQI-ish” measure.
    // In real usage, you might use an EPA formula to convert pm2.5 to AQI.
    return { closest: Math.round(closestVal || 0), average: avg, debug: debugInfo };
  } catch (err) {
    debugInfo.error = err.message;
    return { closest: 0, average: 0, debug: debugInfo };
  }
}

/**
 * fetchOpenWeather => returns temperature, wind speed (mph), wind direction (deg + cardinal).
 */
async function fetchOpenWeather(lat, lon) {
  const debugInfo = { lat, lon };
  try {
    const url = 'https://api.openweathermap.org/data/2.5/weather';
    const resp = await axios.get(url, {
      params: {
        lat,
        lon,
        appid: process.env.OPENWEATHER_API_KEY,
        units: 'imperial' // so speed is mph, temp is F
      }
    });

    const wind = resp.data.wind || {};
    const main = resp.data.main || {};
    const deg = wind.deg || 0;
    debugInfo.temperatureF = main.temp;
    debugInfo.windSpeedMph = wind.speed;
    debugInfo.windDeg = deg;
    debugInfo.cardinal = getCardinal(deg);

    return {
      tempF: main.temp,           // Fahrenheit
      humidity: main.humidity,
      windSpeed: wind.speed,      // mph
      windDeg: deg,
      windDir: getCardinal(deg),
      debug: debugInfo
    };
  } catch (err) {
    debugInfo.error = err.message;
    return {
      tempF: 0,
      humidity: 0,
      windSpeed: 0,
      windDeg: 0,
      windDir: 'Unknown',
      debug: debugInfo
    };
  }
}

// ================== End of API calls

/**
 * This function is called once an hour (via cron) or on-demand.
 * We fetch from AirNow, PurpleAir, and OpenWeather for each address, storing:
 *   - aqi_closest and aqi_average (AirNow)
 *   - aqi_closest and aqi_average (PurpleAir) [though strictly it's pm2.5 -> AQI if you do the calc]
 *   - temperature, wind, etc. from OpenWeather
 *   - debug logs
 * Then we also compute the last 24-hour average of the "closest" AQI from each source,
 * and store that inside data_json for convenience. 
 */
async function fetchAndStoreHourlyDataForUser(userId){
  // 1) Get user’s chosen radius
  const userRows = await query('SELECT aqi_radius FROM users WHERE id=$1',[userId]);
  if(!userRows.rows.length) return;
  const radiusMiles = userRows.rows[0].aqi_radius || 5;

  // 2) get addresses
  const addrRes = await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  for(const addressRow of addrRes.rows) {
    if(!addressRow.lat || !addressRow.lon) continue;

    // (A) AirNow
    const airNowRes = await fetchAirNowInRadius(addressRow.lat, addressRow.lon, radiusMiles);
    const airNowClosest = airNowRes.closest;
    const airNowAvg = airNowRes.average;

    // (B) PurpleAir
    const purpleRes = await fetchPurpleAirInRadius(addressRow.lat, addressRow.lon, radiusMiles);
    const purpleClosest = purpleRes.closest;
    const purpleAvg = purpleRes.average;

    // (C) OpenWeather
    const owRes = await fetchOpenWeather(addressRow.lat, addressRow.lon);

    // (D) Compute 24hr average of “closest” for each source 
    // by looking at address_hourly_data from the past 24 hours
    // + including the current hour once we store it. So we can compute after we insert.
    // We'll do that with a separate helper:
    const now = new Date();

    // We can store one row for each source: 'AirNow', 'PurpleAir', 'OpenWeather'
    // plus a data_json that includes debug info
    // For AirNow:
    let dataJsonAirNow = {
      type: 'AirNow',
      fetchedAt: now.toISOString(),
      closestAQI: airNowClosest,
      averageAQI: airNowAvg,
      debug: airNowRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `, [
      userId,
      addressRow.id,
      now,
      'AirNow',
      airNowClosest,
      airNowAvg,
      dataJsonAirNow
    ]);

    // For PurpleAir:
    let dataJsonPurple = {
      type: 'PurpleAir',
      fetchedAt: now.toISOString(),
      closestValue: purpleClosest,
      averageValue: purpleAvg,
      debug: purpleRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `, [
      userId,
      addressRow.id,
      now,
      'PurpleAir',
      purpleClosest,
      purpleAvg,
      dataJsonPurple
    ]);

    // For OpenWeather:
    let dataJsonOW = {
      type: 'OpenWeather',
      fetchedAt: now.toISOString(),
      temperatureF: owRes.tempF,
      humidity: owRes.humidity,
      windSpeedMph: owRes.windSpeed,
      windDeg: owRes.windDeg,
      windDir: owRes.windDir,
      debug: owRes.debug
    };
    // We'll store wind info in aqi_closest/aqi_average columns as 0 or null 
    // since it's not truly an AQI. We just want it in data_json.
    await query(`
      INSERT INTO address_hourly_data
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `, [
      userId,
      addressRow.id,
      now,
      'OpenWeather',
      0,
      0,
      dataJsonOW
    ]);

    // Now we can do a quick pass to compute the new 24hr average for each source “closest”
    // And store it inside data_json as well if we like. We'll do that in a helper:
    await updateTrailing24hAverages(userId, addressRow.id, now);
  }
}

/**
 * Re-compute trailing 24hr “closest” average for each source, store it in the data_json
 * for the current row. We find the row we just inserted for that address/timestamp/source,
 * update it with .data_json.24hrClosest
 */
async function updateTrailing24hAverages(userId, addressId, timestamp) {
  const dayAgo = new Date(timestamp);
  dayAgo.setHours(dayAgo.getHours() - 24);

  // We'll gather from the last 24 hours + the current hour row
  // group by source
  const dayRows = await query(`
    SELECT source, AVG(aqi_closest) as closest_avg
    FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND timestamp >= $3
    GROUP BY source
  `, [userId, addressId, dayAgo]);

  // We'll have 1 row for AirNow, 1 row for PurpleAir, 1 row for OpenWeather if relevant
  for (const row of dayRows.rows) {
    const src = row.source;  // e.g. 'AirNow'
    const avgClosest = Math.round(row.closest_avg || 0);

    // Now fetch the row we inserted for [userId, addressId, timestamp, src]
    // update data_json with the trailing 24hr average
    const fetchRes = await query(`
      SELECT * FROM address_hourly_data
      WHERE user_id=$1 AND address_id=$2 AND timestamp=$3 AND source=$4
    `, [userId, addressId, timestamp, src]);
    if (!fetchRes.rows.length) continue;
    const dbRow = fetchRes.rows[0];
    let dataObj = dbRow.data_json || {};
    dataObj['24hrClosest'] = avgClosest;

    // store it back
    await query(`
      UPDATE address_hourly_data
      SET data_json=$1
      WHERE id=$2
    `, [dataObj, dbRow.id]);
  }
}

// =========================== CRON SCHEDULES ============================

// Hourly
cron.schedule('0 * * * *', async()=>{
  console.log('[CRON] hourly triggered');
  try{
    const {rows:users} = await query('SELECT id FROM users');
    for(const user of users){
      await fetchAndStoreHourlyDataForUser(user.id);
    }
  }catch(e){
    console.error('[CRON hourly]',e);
  }
});

// Daily (every 15 min check who is due)
cron.schedule('*/15 * * * *', async()=>{
  console.log('[CRON] 15-min daily check');
  try {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const block = Math.floor(minute/15)*15;

    const {rows:dueUsers} = await query(`
      SELECT id, email
      FROM users
      WHERE daily_report_hour=$1
        AND daily_report_minute=$2
    `,[hour, block]);

    for(const u of dueUsers){
      // pull fresh data
      await fetchAndStoreHourlyDataForUser(u.id);
      // build daily
      const final = await buildDailyEmail(u.id);
      if(final){
        await sendEmail(u.email, 'Your Daily AQI Update', final);
        console.log(`Sent daily update to ${u.email}`);
      }
    }
  } catch(e){
    console.error('[CRON daily check]', e);
  }
});

/**
 * buildDailyEmail => returns text summary for all addresses
 * We’ll incorporate the “24hrClosest” from data_json for each source,
 * plus the debug or current readings, as you wish.
 */
async function buildDailyEmail(userId){
  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  if(!addrRes.rows.length) return null;

  let lines = [];
  for(const aRow of addrRes.rows){
    if(!aRow.lat || !aRow.lon){
      lines.push(`Address: ${aRow.address}\n(No lat/lon)`);
      continue;
    }
    // We'll gather the most recent row for each source
    const recent = await query(`
      SELECT *
      FROM address_hourly_data
      WHERE address_id=$1
      ORDER BY timestamp DESC
      LIMIT 50
    `,[ aRow.id ]);

    // A quick find for each source:
    const airNow = recent.rows.find(r => r.source==='AirNow');
    const purple = recent.rows.find(r => r.source==='PurpleAir');
    const ow = recent.rows.find(r => r.source==='OpenWeather');

    lines.push(`Address: ${aRow.address}`);
    if(airNow){
      const c = airNow.aqi_closest || 0;
      const avg = airNow.aqi_average || 0;
      const cat = colorCodeAQI(c); // e.g. 'Good', 'Moderate'
      const dayAvg = (airNow.data_json?.['24hrClosest']) || 0;
      lines.push(` AirNow => closestAQI=${c} (${cat}), radiusAvg=${avg}, 24hrClosestAvg=${dayAvg}`);
    } else {
      lines.push(` AirNow => No recent data`);
    }
    if(purple){
      const c = purple.aqi_closest || 0;
      const avg = purple.aqi_average || 0;
      // in real usage, you'd convert pm2.5 -> AQI
      const cat = colorCodeAQI(c);
      const dayAvg = (purple.data_json?.['24hrClosest']) || 0;
      lines.push(` PurpleAir => closest=${c} (${cat}), radiusAvg=${avg}, 24hrClosestAvg=${dayAvg}`);
    } else {
      lines.push(` PurpleAir => No recent data`);
    }
    if(ow){
      const j = ow.data_json || {};
      lines.push(` Weather => ${j.temperatureF||0}F, wind=${j.windSpeedMph||0} mph from ${j.windDir} (${j.windDeg}°)`);
    } else {
      lines.push(` Weather => No recent data`);
    }
  }
  return lines.join('\n');
}

// ============== EXPRESS ROUTES ==============

app.get('/', (req,res)=>{
  if (req.isAuthenticated()) return res.redirect('/html/dashboard.html');
  res.sendFile(path.join(__dirname,'index.html'));
});

// Hide Google places key
app.get('/js/autocomplete.js',(req,res)=>{
  const key=process.env.GOOGLE_GEOCODE_KEY||'';
  const content=`
    function loadGooglePlaces() {
      var script=document.createElement('script');
      script.src="https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=initAutocomplete";
      document.head.appendChild(script);
    }
    function initAutocomplete(){
      var input=document.getElementById('addressInput');
      if(!input)return;
      new google.maps.places.Autocomplete(input);
    }
    window.onload=loadGooglePlaces;
  `;
  res.setHeader('Content-Type','application/javascript');
  res.send(content);
});

// SIGNUP
app.post('/api/signup', async(req,res)=>{
  // same code as before
  // ...
  // just keep your existing signup logic
  // ...
});

// ADD ADDRESS
app.post('/api/add-address', ensureAuth, async(req,res)=>{
  // same code as before
});

// DELETE ADDRESS
app.post('/api/delete-address', ensureAuth, async(req,res)=>{
  // same code as before
});

// set-aqi-radius
app.post('/api/set-aqi-radius', ensureAuth, async(req,res)=>{
  // ...
});

// set-daily-time
app.post('/api/set-daily-time', ensureAuth, async(req,res)=>{
  // ...
});

// /api/list-addresses
app.get('/api/list-addresses', ensureAuth, async(req,res)=>{
  // ...
});

// /api/myReport
/**
 * Returns a big HTML snippet that includes:
 * - Each address
 * - The most recent reading from each source
 * - The last 24hr average
 * - The debug logs if the user wants them visible
 */
app.get('/api/myReport', ensureAuth, async(req,res)=>{
  try {
    const addrRes = await query('SELECT * FROM user_addresses WHERE user_id=$1', [req.user.id]);
    if(!addrRes.rows.length){
      return res.json({ error: 'No addresses. Please add an address.' });
    }

    let html = '';
    for(const adr of addrRes.rows){
      if(!adr.lat || !adr.lon){
        html += `<h4>Address: ${adr.address}</h4><p>(No lat/lon, cannot produce AQI)</p>`;
        continue;
      }
      // Grab the 3 most recent rows for each source
      const rec = await query(`
        SELECT *
        FROM address_hourly_data
        WHERE address_id=$1
        ORDER BY timestamp DESC
        LIMIT 30
      `,[adr.id]);

      const airNow = rec.rows.find(r => r.source==='AirNow');
      const purple = rec.rows.find(r => r.source==='PurpleAir');
      const ow = rec.rows.find(r => r.source==='OpenWeather');

      html += `<h4>Address: ${adr.address}</h4>`;
      if(airNow){
        const c = airNow.aqi_closest || 0;
        const avg = airNow.aqi_average || 0;
        const dayAvg = airNow.data_json?.['24hrClosest'] || 0;
        const cat = colorCodeAQI(c);
        const colorStyle = getAQIColorStyle(c); // a function returning a color or background style
        // debug logs
        const debug = airNow.data_json?.debug || {};

        html += `<p>AirNow => 
          <span style="${colorStyle}">closest=${c} (${cat})</span>, 
          radiusAvg=${avg}, 
          24hrClosestAvg=${dayAvg}</p>`;

        // If you want to show bounding box + sensors used
        if(debug.boundingBox){
          html += `<details><summary>AirNow Debug</summary>
            <div>Bounding box: ${JSON.stringify(debug.boundingBox)}</div>
            <div>Sensors in radius:</div>
            <ul>
              ${(debug.sensors||[]).map(s=>`<li>AQI=${s.aqi}, dist=${s.distance.toFixed(1)}, lat=${s.lat}, lon=${s.lon}</li>`).join('')}
            </ul>
          </details>`;
        }
      } else {
        html += `<p>AirNow => No recent data</p>`;
      }

      if(purple){
        const c = purple.aqi_closest || 0;
        const avg = purple.aqi_average || 0;
        const dayAvg = purple.data_json?.['24hrClosest'] || 0;
        // real usage: convert pm2.5 to AQI
        const cat = colorCodeAQI(c);
        const colorStyle = getAQIColorStyle(c);
        const debug = purple.data_json?.debug || {};

        html += `<p>PurpleAir => 
          <span style="${colorStyle}">closest=${c} (${cat})</span>, 
          radiusAvg=${avg}, 
          24hrClosestAvg=${dayAvg}</p>`;

        if(debug.boundingBox){
          html += `<details><summary>PurpleAir Debug</summary>
            <div>Bounding box: ${JSON.stringify(debug.boundingBox)}</div>
            <div>Sensors in radius:</div>
            <ul>
              ${(debug.sensors||[]).map(s=>`<li>pm25=${s.pm25}, dist=${s.distance.toFixed(1)}, lat=${s.lat}, lon=${s.lon}</li>`).join('')}
            </ul>
          </details>`;
        }
      } else {
        html += `<p>PurpleAir => No recent data</p>`;
      }

      if(ow){
        const j = ow.data_json || {};
        const wdeg = j.windDeg || 0;
        html += `<p>OpenWeather => 
          Temp=${j.temperatureF||0}F, 
          Wind=${j.windSpeedMph||0} mph from ${j.windDir} (${wdeg}°), 
          Humidity=${j.humidity||0}%</p>`;

        if(j.debug){
          html += `<details><summary>OpenWeather Debug</summary>
            <pre>${JSON.stringify(j.debug, null, 2)}</pre>
          </details>`;
        }
      } else {
        html += `<p>OpenWeather => No recent data</p>`;
      }
    }

    res.json({ html });
  } catch(e){
    console.error('[myReport error]', e);
    res.status(500).json({ error:'Internal server error' });
  }
});

// /api/report-now => do a fetch for user, then return the new data
app.post('/api/report-now', ensureAuth, async(req,res)=>{
  try {
    await fetchAndStoreHourlyDataForUser(req.user.id);
    const baseUrl=`${req.protocol}://${req.get('host')}`;
    const r=await axios.get(`${baseUrl}/api/myReport`, { headers:{cookie:req.headers.cookie||''} });
    res.json(r.data);
  } catch(err){
    console.error('[report-now error]', err);
    res.status(502).json({ error:'Error: HTTP 502 - '+err });
  }
});

// Additional routes for login, logout, forgot, reset, etc. remain unchanged
// ......................

app.listen(process.env.PORT||3000, async()=>{
  await initDB();
  console.log(`Server running on port ${process.env.PORT||3000}`);
});

// Helper to pick a CSS style for the numeric AQI
function getAQIColorStyle(aqi){
  // If you prefer direct color codes:
  // Good(0-50) => green, etc.
  let color = '#000';
  if(aqi<=50) color='#009966';        // Good (green)
  else if(aqi<=100) color='#ffde33';  // Moderate (yellow)
  else if(aqi<=150) color='#ff9933';  // USG (orange)
  else if(aqi<=200) color='#cc0033';  // Unhealthy (red)
  else if(aqi<=300) color='#660099';  // Very Unhealthy (purple)
  else color='#7e0023';               // Hazardous (maroon)

  return `color:${color}; font-weight:bold;`;
}
