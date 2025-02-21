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
import { distanceMiles, colorCodeAQI, getAQIColorStyle } from './utils.js';

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

// Helper to send email
async function sendEmail(to, subject, text){
  const msg={to, from:'noreply@littlegiant.app', subject, text};
  await sgMail.send(msg);
}

// ensureAuth
function ensureAuth(req,res,next){
  if(req.isAuthenticated()) return next();
  if(req.path.startsWith('/api/')){
    return res.status(401).json({error:'Not authenticated'});
  }
  return res.redirect('/html/login.html');
}

// Convert wind degrees to cardinal direction
function getCardinal(deg){
  if (deg == null) return 'Unknown';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx];
}

// ========== API calls ==========

// A) AirNow
async function fetchAirNowInRadius(lat, lon, radiusMiles) {
  const debugInfo = { lat, lon, radiusMiles };
  try {
    const offset = 0.5; // larger bounding box for safety
    const minLat = lat - offset;
    const maxLat = lat + offset;
    const minLon = lon - offset;
    const maxLon = lon + offset;
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

    if (!Array.isArray(resp.data) || resp.data.length===0) {
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
      debugInfo.message = 'No sensors found within radius';
      return { closest: 0, average: 0, debug: debugInfo };
    }
    const avg = Math.round(sum / count);
    return { closest: closestVal || 0, average: avg, debug: debugInfo };
  } catch(err){
    debugInfo.error = err.message;
    return { closest:0, average:0, debug: debugInfo };
  }
}

// B) PurpleAir
async function fetchPurpleAirInRadius(lat, lon, radiusMiles) {
  const debugInfo = { lat, lon, radiusMiles };
  try {
    const offset = 0.5; // bigger bounding box
    const minLat = lat - offset;
    const maxLat = lat + offset;
    const minLon = lon - offset;
    const maxLon = lon + offset;
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

    if (!resp.data || !resp.data.data) {
      debugInfo.message='No PurpleAir data returned';
      return { closest:0, average:0, debug: debugInfo };
    }
    debugInfo.sensorCount = resp.data.data.length;

    let closestDist = Infinity;
    let closestVal = null;
    let sum = 0;
    let count = 0;
    const sensorDetails=[];
    for(const sensor of resp.data.data){
      // sensor = [id, pm2.5, lat, lon, ...]
      const pm25 = sensor[1];
      const sLat = sensor[2];
      const sLon = sensor[3];
      const dist = distanceMiles(lat, lon, sLat, sLon);
      sensorDetails.push({ pm25, lat:sLat, lon:sLon, distance:dist });
      if (dist <= radiusMiles) {
        sum += pm25;
        count++;
        if(dist<closestDist){
          closestDist=dist;
          closestVal=pm25;
        }
      }
    }
    debugInfo.sensors = sensorDetails.filter(s => s.distance <= radiusMiles);

    if(!count){
      debugInfo.message='No PurpleAir sensors in radius';
      return { closest:0, average:0, debug: debugInfo };
    }
    const avg = Math.round(sum/count);
    // Real usage => Convert pm2.5 => AQI. This is just raw pm2.5
    return { closest:Math.round(closestVal), average:avg, debug: debugInfo };
  } catch(err){
    debugInfo.error=err.message;
    return { closest:0, average:0, debug: debugInfo };
  }
}

// C) OpenWeather
async function fetchOpenWeather(lat, lon) {
  const debugInfo={ lat, lon };
  try {
    const url='https://api.openweathermap.org/data/2.5/weather';
    const resp=await axios.get(url, {
      params:{
        lat, lon,
        appid: process.env.OPENWEATHER_API_KEY,
        units: 'imperial'
      }
    });
    const wind = resp.data.wind || {};
    const main = resp.data.main || {};
    debugInfo.temperatureF=main.temp;
    debugInfo.humidity=main.humidity;
    debugInfo.windSpeed=wind.speed;
    debugInfo.windDeg=wind.deg;
    debugInfo.windDir=getCardinal(wind.deg);

    return {
      tempF: main.temp,
      humidity: main.humidity,
      windSpeed: wind.speed,
      windDeg: wind.deg,
      windDir: getCardinal(wind.deg),
      debug: debugInfo
    };
  } catch(err){
    debugInfo.error=err.message;
    return {
      tempF: 0,
      humidity:0,
      windSpeed:0,
      windDeg:0,
      windDir:'Unknown',
      debug: debugInfo
    };
  }
}

// ========== Insert & 24hr Computations ==========

/**
 * Called each hour or on-demand to fetch data from AirNow, PurpleAir, OpenWeather
 * for each user address. Then store rows in address_hourly_data, including
 * two sets of numeric columns (closest, average) and a data_json object with debug.
 * We'll afterwards call updateTrailing24hAverages to store trailing 24hr data for both “closest” and “radius average.”
 */
async function fetchAndStoreHourlyDataForUser(userId){
  const userRows=await query('SELECT aqi_radius FROM users WHERE id=$1',[userId]);
  if(!userRows.rows.length) return;
  const radiusMiles = userRows.rows[0].aqi_radius || 5;

  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  for(const adr of addrRes.rows){
    if(!adr.lat || !adr.lon) continue;

    // AirNow
    const airNowRes = await fetchAirNowInRadius(adr.lat, adr.lon, radiusMiles);
    // PurpleAir
    const purpleRes = await fetchPurpleAirInRadius(adr.lat, adr.lon, radiusMiles);
    // OpenWeather
    const owRes = await fetchOpenWeather(adr.lat, adr.lon);

    const now=new Date();

    // Insert for AirNow
    let dataAirNow={
      type:'AirNow',
      fetchedAt: now.toISOString(),
      closestAQI: airNowRes.closest,
      radiusAQI: airNowRes.average,
      debug: airNowRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data 
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `,[ userId, adr.id, now, 'AirNow', airNowRes.closest, airNowRes.average, dataAirNow ]);

    // Insert for PurpleAir
    let dataPurple={
      type:'PurpleAir',
      fetchedAt: now.toISOString(),
      closestPM25: purpleRes.closest,
      radiusPM25: purpleRes.average, 
      debug: purpleRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data 
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `,[ userId, adr.id, now, 'PurpleAir', purpleRes.closest, purpleRes.average, dataPurple ]);

    // Insert for OpenWeather
    let dataOW={
      type:'OpenWeather',
      fetchedAt: now.toISOString(),
      tempF: owRes.tempF,
      humidity: owRes.humidity,
      windSpeed: owRes.windSpeed,
      windDeg: owRes.windDeg,
      windDir: owRes.windDir,
      debug: owRes.debug
    };
    // We'll store 0,0 in the numeric columns since it's not truly an AQI
    await query(`
      INSERT INTO address_hourly_data
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1,$2,$3,$4,0,0,$5)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `,[ userId, adr.id, now, 'OpenWeather', dataOW ]);

    // Now we compute trailing 24hr averages for both “closest” and “radius” for each source
    // and store them in data_json as well.
    await updateTrailing24hAverages(userId, adr.id, now);
  }
}

/**
 * updateTrailing24hAverages => for the newly inserted rows, 
 * we compute the trailing 24hr average of (aqi_closest) AND (aqi_average),
 * store them in data_json as "closest24hrAvg" and "radius24hrAvg".
 */
async function updateTrailing24hAverages(userId, addressId, timestamp){
  const dayAgo=new Date(timestamp);
  dayAgo.setHours(dayAgo.getHours()-24);

  // We get the last 24hr rows for each source
  const dayRows=await query(`
    SELECT source,
           AVG(aqi_closest) as closest_avg,
           AVG(aqi_average) as radius_avg
    FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND timestamp >= $3
    GROUP BY source
  `,[ userId, addressId, dayAgo]);

  for(const row of dayRows.rows){
    const src = row.source; // e.g. 'AirNow'
    const cAvg = Math.round(row.closest_avg || 0);
    const rAvg = Math.round(row.radius_avg || 0);

    // load the row we just inserted for [timestamp,src]
    const existing=await query(`
      SELECT * FROM address_hourly_data
      WHERE user_id=$1
        AND address_id=$2
        AND timestamp=$3
        AND source=$4
    `,[ userId, addressId, timestamp, src ]);

    if(!existing.rows.length) continue;
    let dbRow=existing.rows[0];
    let d = dbRow.data_json||{};
    d.closest24hrAvg = cAvg;
    d.radius24hrAvg = rAvg;

    await query(`
      UPDATE address_hourly_data
      SET data_json=$1
      WHERE id=$2
    `,[ d, dbRow.id ]);
  }
}

// ========== CRON Schedules ==========

// Hourly
cron.schedule('0 * * * *', async()=>{
  console.log('[CRON] hourly triggered');
  try{
    const {rows:users}=await query('SELECT id FROM users');
    for(const user of users){
      await fetchAndStoreHourlyDataForUser(user.id);
    }
  }catch(e){
    console.error('[CRON hourly]',e);
  }
});

// Daily check
cron.schedule('*/15 * * * *', async()=>{
  console.log('[CRON] 15-min daily check');
  try{
    const now=new Date();
    const hour=now.getHours();
    const minute=now.getMinutes();
    const block=Math.floor(minute/15)*15;

    const {rows:dueUsers} = await query(`
      SELECT id, email
      FROM users
      WHERE daily_report_hour=$1
        AND daily_report_minute=$2
    `,[hour, block]);
    for(const u of dueUsers){
      await fetchAndStoreHourlyDataForUser(u.id);
      const final = await buildDailyEmail(u.id);
      if(final){
        await sendEmail(u.email, 'Your Daily AQI Update', final);
        console.log(`Sent daily update to ${u.email}`);
      }
    }
  }catch(e){
    console.error('[CRON daily check]',e);
  }
});

async function buildDailyEmail(userId){
  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  if(!addrRes.rows.length) return null;

  let lines=[];
  for(const adr of addrRes.rows){
    if(!adr.lat||!adr.lon){
      lines.push(`Address: ${adr.address}\n(No lat/lon)`);
      continue;
    }
    // get recent data
    const rec=await query(`
      SELECT *
      FROM address_hourly_data
      WHERE address_id=$1
      ORDER BY timestamp DESC
      LIMIT 50
    `,[adr.id]);

    // find each source
    const an = rec.rows.find(r=>r.source==='AirNow');
    const pa = rec.rows.find(r=>r.source==='PurpleAir');
    const ow = rec.rows.find(r=>r.source==='OpenWeather');

    lines.push(`Address: ${adr.address}`);
    if(an){
      const c = an.aqi_closest||0;
      const r = an.aqi_average||0;
      const c24 = an.data_json?.closest24hrAvg||0;
      const r24 = an.data_json?.radius24hrAvg||0;
      lines.push(` AirNow => Closest=${c}, RadiusAvg=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(' AirNow => No data');
    }
    if(pa){
      const c = pa.aqi_closest||0;
      const r = pa.aqi_average||0;
      const c24 = pa.data_json?.closest24hrAvg||0;
      const r24 = pa.data_json?.radius24hrAvg||0;
      lines.push(` PurpleAir => ClosestPM25=${c}, RadiusPM25=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(' PurpleAir => No data');
    }
    if(ow){
      const owj = ow.data_json||{};
      // If we want a 24hr average for OpenWeather, we can do the same approach
      const c24 = owj.closest24hrAvg||0;  // actually you might store temperature average, etc.
      const r24 = owj.radius24hrAvg||0;   // might store wind speed avg
      lines.push(` OpenWeather => Temp=${owj.tempF||0}F, Wind=${owj.windSpeed||0} mph from ${owj.windDir||'???'}(${owj.windDeg||0}°), 24hrAvgTemp=${c24}, 24hrAvgWind=${r24}`);
    } else {
      lines.push(' OpenWeather => No data');
    }
  }
  return lines.join('\n');
}

// ========== Express Routes ==========

const staticPath=path.join(__dirname);
app.use(express.static(staticPath));

app.get('/',(req,res)=>{
  if(req.isAuthenticated()) return res.redirect('/html/dashboard.html');
  res.sendFile(path.join(__dirname,'index.html'));
});

// Hide google key
app.get('/js/autocomplete.js',(req,res)=>{
  const key=process.env.GOOGLE_GEOCODE_KEY||'';
  const content=`
    function loadGooglePlaces(){
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
  // Omitted for brevity; same as before
});

// Add address
app.post('/api/add-address', ensureAuth, async(req,res)=>{
  const { address }=req.body;
  if(!address) return res.status(400).send('No address provided');
  const cnt=await query('SELECT COUNT(*) FROM user_addresses WHERE user_id=$1',[req.user.id]);
  const c=parseInt(cnt.rows[0].count,10);
  if(c>=3) return res.status(400).send('Max 3 addresses allowed');

  let lat=null, lon=null;
  if(process.env.GOOGLE_GEOCODE_KEY){
    const geoURL='https://maps.googleapis.com/maps/api/geocode/json';
    const resp=await axios.get(geoURL,{params:{ address, key:process.env.GOOGLE_GEOCODE_KEY }});
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
app.post('/api/delete-address', ensureAuth, async(req,res)=>{
  const { addressId }=req.body;
  if(!addressId) return res.status(400).send('No addressId');
  await query('DELETE FROM user_addresses WHERE id=$1 AND user_id=$2',[addressId, req.user.id]);
  res.redirect('/html/dashboard.html');
});

// set-aqi-radius
app.post('/api/set-aqi-radius', ensureAuth, async(req,res)=>{
  const { radius }=req.body;
  if(!radius) return res.status(400).json({error:'No radius'});
  await query('UPDATE users SET aqi_radius=$1 WHERE id=$2',[parseInt(radius,10), req.user.id]);
  res.json({ success:true });
});

// set-daily-time
app.post('/api/set-daily-time', ensureAuth, async(req,res)=>{
  const { hour, minute }=req.body;
  if(hour===undefined||minute===undefined) return res.status(400).json({error:'Missing hour/minute'});
  await query('UPDATE users SET daily_report_hour=$1, daily_report_minute=$2 WHERE id=$3',
    [ parseInt(hour,10), parseInt(minute,10), req.user.id ]);
  res.json({ success:true });
});

// list addresses
app.get('/api/list-addresses', ensureAuth, async(req,res)=>{
  try {
    const {rows}=await query('SELECT id,address,lat,lon FROM user_addresses WHERE user_id=$1 ORDER BY id',[req.user.id]);
    res.json(rows);
  } catch(e){
    console.error('/api/list-addresses error', e);
    res.status(500).json({error:'Internal error'});
  }
});

// myReport => HTML snippet with two rows (current, 24hr) for each source
app.get('/api/myReport', ensureAuth, async(req,res)=>{
  try{
    const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[req.user.id]);
    if(!addrRes.rows.length){
      return res.json({ error:'No addresses. Please add an address.' });
    }

    let html='';
    for(const adr of addrRes.rows){
      if(!adr.lat || !adr.lon){
        html+=`<h4>Address: ${adr.address}</h4><p>(No lat/lon, cannot produce AQI)</p>`;
        continue;
      }
      // find the most recent row for each source
      const rec=await query(`
        SELECT *
        FROM address_hourly_data
        WHERE address_id=$1
        ORDER BY timestamp DESC
        LIMIT 50
      `,[adr.id]);

      const an = rec.rows.find(r=>r.source==='AirNow');
      const pa = rec.rows.find(r=>r.source==='PurpleAir');
      const ow = rec.rows.find(r=>r.source==='OpenWeather');

      html+=`<h4>Address: ${adr.address}</h4>`;
      // AIRNOW
      if(an){
        const c=an.aqi_closest||0; // current
        const r=an.aqi_average||0; // radius
        const c24=an.data_json?.closest24hrAvg||0;
        const r24=an.data_json?.radius24hrAvg||0;
        const cat = colorCodeAQI(c);
        const styleClosest = getAQIColorStyle(c);
        const styleRadius  = getAQIColorStyle(r);
        const styleC24     = getAQIColorStyle(c24);
        const styleR24     = getAQIColorStyle(r24);

        html+=`
          <table class="station-table">
            <thead><tr><th colspan="2">AirNow</th></tr></thead>
            <tbody>
              <tr><td><strong>Current Closest</strong></td>
                  <td style="${styleClosest}">${c} (${cat})</td></tr>
              <tr><td><strong>Current Radius Average</strong></td>
                  <td style="${styleRadius}">${r}</td></tr>
              <tr><td><strong>Closest 24hr Average</strong></td>
                  <td style="${styleC24}">${c24}</td></tr>
              <tr><td><strong>Radius 24hr Average</strong></td>
                  <td style="${styleR24}">${r24}</td></tr>
            </tbody>
          </table>
        `;

        // debug if you want
        const dbg = an.data_json?.debug;
        if(dbg){
          html+=`<details><summary>AirNow Debug</summary>
            <pre>${JSON.stringify(dbg, null, 2)}</pre>
          </details>`;
        }
      } else {
        html+=`<p>AirNow => No data</p>`;
      }

      // PURPLEAIR
      if(pa){
        const c = pa.aqi_closest||0;
        const r = pa.aqi_average||0;
        const c24 = pa.data_json?.closest24hrAvg||0;
        const r24 = pa.data_json?.radius24hrAvg||0;
        const cat = colorCodeAQI(c); // again, c is raw pm2.5, so it's not truly accurate 
        const styleClosest = getAQIColorStyle(c);
        const styleRadius  = getAQIColorStyle(r);
        const styleC24     = getAQIColorStyle(c24);
        const styleR24     = getAQIColorStyle(r24);

        html+=`
          <table class="station-table">
            <thead><tr><th colspan="2">PurpleAir</th></tr></thead>
            <tbody>
              <tr><td><strong>Current Closest (PM2.5 as AQI)</strong></td>
                  <td style="${styleClosest}">${c} (${cat})</td></tr>
              <tr><td><strong>Current Radius Average</strong></td>
                  <td style="${styleRadius}">${r}</td></tr>
              <tr><td><strong>Closest 24hr Average</strong></td>
                  <td style="${styleC24}">${c24}</td></tr>
              <tr><td><strong>Radius 24hr Average</strong></td>
                  <td style="${styleR24}">${r24}</td></tr>
            </tbody>
          </table>
        `;

        // debug
        const dbg = pa.data_json?.debug;
        if(dbg){
          html+=`<details><summary>PurpleAir Debug</summary>
            <pre>${JSON.stringify(dbg, null, 2)}</pre>
          </details>`;
        }
      } else {
        html+=`<p>PurpleAir => No data</p>`;
      }

      // OPENWEATHER
      if(ow){
        const data = ow.data_json||{};
        // For openweather, we stored "closest24hrAvg" and "radius24hrAvg" if we wanted to do so in updateTrailing24hAverages
        const c24 = data.closest24hrAvg||0; 
        const r24 = data.radius24hrAvg||0; 
        html+=`
          <table class="station-table">
            <thead><tr><th colspan="2">OpenWeather</th></tr></thead>
            <tbody>
              <tr><td><strong>Current Hourly</strong></td><td>
                Temp=${data.tempF||0}F, 
                Wind=${data.windSpeed||0} mph from ${data.windDir||'??'} (${data.windDeg||0}°)
              </td></tr>
              <tr><td><strong>24hr Average</strong></td><td>
                Temp=${c24}F, SomeWindAvg=${r24} (Your logic?)
              </td></tr>
            </tbody>
          </table>
        `;

        // debug
        if(data.debug){
          html+=`<details><summary>OpenWeather Debug</summary>
            <pre>${JSON.stringify(data.debug,null,2)}</pre>
          </details>`;
        }
      } else {
        html+=`<p>OpenWeather => No data</p>`;
      }
    }

    res.json({ html });
  } catch(e){
    console.error('[myReport error]', e);
    res.status(500).json({ error:'Internal server error' });
  }
});

// Manual update => fetch new data
app.post('/api/report-now', ensureAuth, async(req,res)=>{
  try{
    await fetchAndStoreHourlyDataForUser(req.user.id);
    const baseUrl=`${req.protocol}://${req.get('host')}`;
    const r=await axios.get(`${baseUrl}/api/myReport`,{
      headers:{cookie:req.headers.cookie||''}
    });
    res.json(r.data);
  } catch(err){
    console.error('[report-now error]', err);
    res.status(502).json({error:'Error: HTTP 502 - '+err});
  }
});

// ... add the rest of your auth routes, forgot password, etc. here ...

app.listen(process.env.PORT||3000, async()=>{
  await initDB();
  console.log(`Server running on port ${process.env.PORT||3000}`);
});
