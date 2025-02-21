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
import { fetchOpenWeather, fetchAirNowAQI, labelAirNowAQI, getWindStatus } from './weather.js';
import { scrapeFireAirnow, scrapeXappp, scrapeArcgis } from './scraping.js';
import { distanceMiles } from './utils.js';

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
app.use(bodyParser.json()); // so we can handle JSON POST
app.use(session({
  store: new PgSession({
    pool,
    createTableIfMissing: true
  }),
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
  const { email, password, password2, address, agreePolicy, agreeTerms }=req.body;
  if(!email||!password||!password2){
    return res.status(400).send('All fields required');
  }
  if(!agreePolicy||!agreeTerms){
    return res.status(400).send('Must accept policy/terms');
  }
  if(password!==password2){
    return res.status(400).send('Passwords do not match');
  }
  // Simple check for complexity
  if(password.length<8 || !/[0-9]/.test(password) || !/[A-Za-z]/.test(password) || !/[^A-Za-z0-9]/.test(password)){
    return res.status(400).send('Password not complex enough');
  }
  try {
    const hash=await bcrypt.hash(password,10);
    const userRes=await query(`
      INSERT INTO users(email,password_hash,latest_report)
      VALUES($1,$2,$3)
      RETURNING id
    `,[email,hash, JSON.stringify({})]);
    const newUserId=userRes.rows[0].id;

    if(address && address.trim()){
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
      `,[newUserId, address.trim(), lat, lon]);
    }
    const dashLink = `${process.env.APP_URL||'http://localhost:3000'}/html/dashboard.html`;
    await sendEmail(email,'Welcome to AQI Updates',`Thanks for signing up!\n${dashLink}\nEnjoy!`);
    res.redirect('/html/login.html');
  } catch(err){
    console.error('[signup error]',err);
    res.status(500).send('Error signing up');
  }
});

// ADD ADDRESS
app.post('/api/add-address', ensureAuth, async(req,res)=>{
  const { address }=req.body;
  if(!address) return res.status(400).send('No address provided');
  const cnt=await query('SELECT COUNT(*) FROM user_addresses WHERE user_id=$1',[req.user.id]);
  const c=parseInt(cnt.rows[0].count,10);
  if(c>=3){
    return res.status(400).send('Max 3 addresses allowed');
  }
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

// DELETE ADDRESS
app.post('/api/delete-address', ensureAuth, async(req,res)=>{
  const{ addressId }=req.body;
  if(!addressId) return res.status(400).send('No addressId');
  await query('DELETE FROM user_addresses WHERE id=$1 AND user_id=$2',[addressId, req.user.id]);
  res.redirect('/html/dashboard.html');
});

// set-aqi-radius
app.post('/api/set-aqi-radius', ensureAuth, async(req,res)=>{
  const { radius } = req.body;
  if(!radius) return res.status(400).json({error:'No radius'});
  await query('UPDATE users SET aqi_radius=$1 WHERE id=$2',[parseInt(radius), req.user.id]);
  res.json({ success:true });
});

// set-daily-time
app.post('/api/set-daily-time', ensureAuth, async(req,res)=>{
  const { hour, minute }=req.body;
  if(hour===undefined || minute===undefined){
    return res.status(400).json({error:'Missing hour/minute'});
  }
  await query('UPDATE users SET daily_report_hour=$1, daily_report_minute=$2 WHERE id=$3',[
    parseInt(hour), parseInt(minute), req.user.id
  ]);
  res.json({ success:true });
});

// LOGIN local
app.post('/api/login',
  passport.authenticate('local',{failureRedirect:'/html/login.html'}),
  (req,res)=> res.redirect('/html/dashboard.html')
);

// FORGOT
app.post('/api/forgot', async(req,res)=>{
  const{ email }=req.body;
  if(!email) return res.status(400).send('No email');
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
  await sendEmail(email,'Password Reset', `Click here:\n${link}`);
  res.send('If found, a reset link is emailed.');
});

// RESET
app.post('/api/reset', async(req,res)=>{
  const{token,newPassword}=req.body;
  if(!token||!newPassword) return res.status(400).send('Missing token or newPassword');
  // check complexity
  if(newPassword.length<8 || !/[0-9]/.test(newPassword) || !/[A-Za-z]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)){
    return res.status(400).send('New password not complex enough');
  }
  const now=new Date();
  const {rows}=await query(`
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

// LOGOUT
app.get('/logout',(req,res)=>{
  req.logout(()=> res.redirect('/index.html'));
});

// DELETE ACCOUNT
app.post('/api/delete-account', ensureAuth, async(req,res)=>{
  const userId=req.user.id;
  const {rows}=await query('SELECT email FROM users WHERE id=$1',[userId]);
  if(!rows.length){
    req.logout(()=> res.redirect('/index.html'));
    return;
  }
  const userEmail=rows[0].email;

  await query('DELETE FROM user_addresses WHERE user_id=$1',[userId]);
  await query('DELETE FROM users WHERE id=$1',[userId]);

  req.logout(()=>{
    sendEmail(userEmail,'Account Deleted',
      `Your account at aqi-k3ki.onrender.com is deleted.\nNo more emails.\nIf you want to sign up again:\nhttps://aqi-k3ki.onrender.com/html/signup.html`
    ).catch(e=>console.error('[DELETE ACCOUNT email]',e));
    res.redirect('/index.html');
  });
});

// OAUTH
app.get('/auth/google', passport.authenticate('google',{scope:['email','profile']}));
app.get('/auth/google/callback',
  passport.authenticate('google',{failureRedirect:'/html/login.html'}),
  (req,res)=> res.redirect('/html/dashboard.html')
);

app.get('/auth/apple', passport.authenticate('apple'));
app.post('/auth/apple/callback',
  passport.authenticate('apple',{failureRedirect:'/html/login.html'}),
  (req,res)=> res.redirect('/html/dashboard.html')
);

// LIST ADDRESSES
app.get('/api/list-addresses', ensureAuth, async(req,res)=>{
  const {rows}=await query('SELECT id,address,lat,lon FROM user_addresses WHERE user_id=$1 ORDER BY id',[req.user.id]);
  res.json(rows);
});

// GET REPORT => Return HTML that shows each address's “most recent” vs. “24-hour average” from DB
app.get('/api/myReport', ensureAuth, async(req,res)=>{
  try {
    const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[req.user.id]);
    if(!addrRes.rows.length){
      return res.json({error:'No addresses. Please add an address.'});
    }

    let html = '';
    for(const row of addrRes.rows){
      if(!row.lat || !row.lon){
        html += `<h4>Address: ${row.address}</h4><p>(No lat/lon, cannot produce AQI)</p>`;
        continue;
      }
      // Get the 10 most recent rows (some might be from different times or different sources)
      const recentRows = await query(`
        SELECT * FROM address_hourly_data
        WHERE address_id=$1
        ORDER BY timestamp DESC
        LIMIT 10
      `,[row.id]);

      let airNowClosest = 'N/A';
      let airNowAverage = 'N/A';
      let purpleClosest = 'N/A';
      let purpleAverage = 'N/A';
      let timeStampStr = '';
      if(recentRows.rows.length){
        const airNowRow = recentRows.rows.find(r => r.source==='AirNow');
        const purpleRow = recentRows.rows.find(r => r.source==='PurpleAir');
        if(airNowRow){
          airNowClosest = airNowRow.aqi_closest;
          airNowAverage = airNowRow.aqi_average;
          timeStampStr = airNowRow.timestamp;
        }
        if(purpleRow){
          purpleClosest = purpleRow.aqi_closest;
          purpleAverage = purpleRow.aqi_average;
          if(!timeStampStr) timeStampStr = purpleRow.timestamp;
        }
      }

      // Compute last 24 hour average of “closest” for each source
      const dayAgo = new Date();
      dayAgo.setHours(dayAgo.getHours() - 24);
      const dayRows = await query(`
        SELECT source,
               AVG(aqi_closest) as closest_avg
        FROM address_hourly_data
        WHERE address_id=$1
          AND timestamp>$2
        GROUP BY source
      `,[row.id, dayAgo]);
      let airNow24 = 'N/A';
      let purple24 = 'N/A';
      for(const d of dayRows.rows){
        if(d.source==='AirNow'){
          airNow24 = Math.round(d.closest_avg || 0);
        } else if(d.source==='PurpleAir'){
          purple24 = Math.round(d.closest_avg || 0);
        }
      }

      html += `<h4>Address: ${row.address}</h4>`;
      html += `<p><em>Most recent data (timestamp: ${timeStampStr})</em></p>`;
      html += `<ul>
        <li>AirNow: Closest AQI=${airNowClosest}, Average in Radius=${airNowAverage}</li>
        <li>PurpleAir: Closest AQI=${purpleClosest}, Average in Radius=${purpleAverage}</li>
      </ul>`;
      html += `<p><strong>24-hour average:</strong> AirNow=${airNow24}, PurpleAir=${purple24}</p>`;
    }

    res.json({ html });
  } catch(e){
    console.error('[myReport error]', e);
    res.status(500).json({ error:'Internal server error' });
  }
});

// MANUAL RECHECK => store fresh data in DB, then respond with updated report
app.post('/api/report-now', ensureAuth, async(req,res)=>{
  try {
    await fetchAndStoreHourlyDataForUser(req.user.id);
    // then respond with /api/myReport info
    const baseUrl=`${req.protocol}://${req.get('host')}`;
    const resp=await axios.get(`${baseUrl}/api/myReport`,{
      headers:{cookie:req.headers.cookie||''}
    });
    if(!resp.data.html && resp.data.error){
      return res.status(400).json({error: resp.data.error});
    }
    if(!resp.data.html){
      return res.json({report:'Hourly Report Not Yet Built.'});
    }
    res.json(resp.data);
  } catch(err){
    console.error('[report-now error]',err);
    res.status(502).json({error:'Error: HTTP 502 - '+err});
  }
});

// Helper to fetch AirNow/PurpleAir data for a user’s addresses, storing in DB
/**
 * fetchAndStoreHourlyDataForUser
 * 
 * For each address that has lat/lon, we:
 * 1) Query AirNow for all PM2.5 sensors in a bounding box, filter by distance <= radius
 * 2) Query PurpleAir for all PM2.5 sensors in a bounding box, filter by distance <= radius
 * 3) Determine the single “closest” sensor’s AQI
 * 4) Determine the average AQI among all sensors in range
 * 5) Insert both results into address_hourly_data
 */
async function fetchAndStoreHourlyDataForUser(userId) {
  // 1) Get user’s chosen radius (in miles)
  const userRows = await query('SELECT aqi_radius FROM users WHERE id=$1', [userId]);
  if (!userRows.rows.length) return;
  const radiusMiles = userRows.rows[0].aqi_radius || 5;

  // 2) Fetch addresses
  const addrRes = await query('SELECT * FROM user_addresses WHERE user_id=$1', [userId]);
  for (const row of addrRes.rows) {
    if (!row.lat || !row.lon) continue;

    // === A) AIRNOW data ===
    const { closest: airNowClosest, average: airNowAvg } =
      await fetchAirNowSensorsInRadius(row.lat, row.lon, radiusMiles);

    // === B) PURPLEAIR data ===
    const { closest: purpleClosest, average: purpleAvg } =
      await fetchPurpleAirSensorsInRadius(row.lat, row.lon, radiusMiles);

    // === C) Insert results into DB ===
    const now = new Date();
    await query(`
      INSERT INTO address_hourly_data
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average)
      VALUES ($1, $2, $3, 'AirNow', $4, $5)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `,[ userId, row.id, now, airNowClosest, airNowAvg ]);

    await query(`
      INSERT INTO address_hourly_data
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average)
      VALUES ($1, $2, $3, 'PurpleAir', $4, $5)
      ON CONFLICT (user_id, address_id, timestamp, source) DO NOTHING
    `,[ userId, row.id, now, purpleClosest, purpleAvg ]);
  }
}

/**
 * fetchAirNowSensorsInRadius
 * Example: uses the AirNow “AQIData” endpoint to request all PM2.5 sensors
 * in a bounding box around (lat, lon), then filters them by actual distance.
 *
 * Return { closest: <int or 0 if none>, average: <int or 0 if none> }
 */
async function fetchAirNowSensorsInRadius(lat, lon, radiusMiles) {
  try {
    // Construct a bounding box big enough for the largest radius
    // ~0.15 degrees lat ~ 10 miles, but let's go a bit bigger to be safe
    const latOffset = 0.2;
    const lonOffset = 0.2;
    const minLat = lat - latOffset;
    const maxLat = lat + latOffset;
    const minLon = lon - lonOffset;
    const maxLon = lon + lonOffset;

    // We’ll use the “/aq/data/” endpoint from AirNow
    const url = 'https://www.airnowapi.org/aq/data/';
    const hourStr = new Date().toISOString().slice(0,13); // e.g., 2025-02-20T16
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

    if (!Array.isArray(resp.data) || resp.data.length === 0) {
      return { closest: 0, average: 0 };
    }

    // Filter the returned sensors by actual distance
    let closestDist = Infinity;
    let closestVal = null;
    let sum = 0;
    let count = 0;

    for (const sensor of resp.data) {
      // Each sensor object should contain .Latitude, .Longitude, .AQI
      const sLat = sensor.Latitude;
      const sLon = sensor.Longitude;
      if (sLat == null || sLon == null) continue;
      // distanceMiles is your helper function from utils.js
      const dist = distanceMiles(lat, lon, sLat, sLon);

      if (dist <= radiusMiles) {
        // Contribute to average
        sum += sensor.AQI;
        count++;
        // Check if it’s the closest
        if (dist < closestDist) {
          closestDist = dist;
          closestVal = sensor.AQI;
        }
      }
    }

    if (!count) {
      // No sensors within radius
      return { closest: 0, average: 0 };
    }
    const avg = Math.round(sum / count);
    return {
      closest: closestVal || 0,
      average: avg
    };
  } catch (err) {
    console.error('[fetchAirNowSensorsInRadius] error:', err.message);
    return { closest: 0, average: 0 };
  }
}

/**
 * fetchPurpleAirSensorsInRadius
 * Example: uses the PurpleAir API (v1/sensors) to request PM2.5 data
 * in a bounding box around (lat, lon). Then we filter by distance <= radiusMiles,
 * find the closest sensor, compute the average.
 *
 * Return { closest: <int>, average: <int> } (0 if none)
 */
async function fetchPurpleAirSensorsInRadius(lat, lon, radiusMiles) {
  try {
    const latOffset = 0.2;
    const lonOffset = 0.2;
    const minLat = lat - latOffset;
    const maxLat = lat + latOffset;
    const minLon = lon - lonOffset;
    const maxLon = lon + lonOffset;

    // PurpleAir API
    // We’ll request pm2.5, lat, lon
    const url = 'https://api.purpleair.com/v1/sensors';
    const resp = await axios.get(url, {
      headers: { 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params: {
        fields: 'pm2.5,latitude,longitude',
        // bounding box
        nwlng: minLon,
        nwlat: maxLat,
        selng: maxLon,
        selat: minLat
      }
    });

    if (!resp.data || !resp.data.data) {
      return { closest: 0, average: 0 };
    }

    let closestDist = Infinity;
    let closestVal = null;
    let sum = 0;
    let count = 0;

    // resp.data.data is an array of sensor arrays, e.g. [id, pm25, lat, lon]
    for (const sensor of resp.data.data) {
      // sensor could be [<id>, <pm25>, <lat>, <lon>, ...]
      const pm25 = sensor[1];
      const sLat = sensor[2];
      const sLon = sensor[3];

      // distance check
      const dist = distanceMiles(lat, lon, sLat, sLon);
      if (dist <= radiusMiles) {
        sum += pm25;
        count++;
        if (dist < closestDist) {
          closestDist = dist;
          closestVal = pm25;
        }
      }
    }

    if (!count) {
      return { closest: 0, average: 0 };
    }
    const avg = Math.round(sum / count);
    return {
      closest: Math.round(closestVal || 0),
      average: avg
    };
  } catch (err) {
    console.error('[fetchPurpleAirSensorsInRadius] error:', err.message);
    return { closest: 0, average: 0 };
  }
}

// CRON SCHEDULING
// 1) Hourly job: fetch new data for each user
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

// 2) Every 15 min, check which users are due for their daily
cron.schedule('*/15 * * * *', async()=>{
  console.log('[CRON] 15-min daily check');
  try {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    // Round the minute down to the nearest 15
    const block = Math.floor(minute/15)*15;

    // See which users have daily_report_hour == hour and daily_report_minute == block
    const {rows:dueUsers} = await query(`
      SELECT id, email
      FROM users
      WHERE daily_report_hour=$1
        AND daily_report_minute=$2
    `,[hour, block]);

    for(const u of dueUsers){
      // Pull fresh data
      await fetchAndStoreHourlyDataForUser(u.id);
      // Build the daily email
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

// buildDailyEmail => returns plain text
async function buildDailyEmail(userId){
  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  if(!addrRes.rows.length) return null;

  let lines = [];
  for(const row of addrRes.rows){
    if(!row.lat || !row.lon){
      lines.push(`Address: ${row.address}\n(No lat/lon)`);
      continue;
    }
    // get most recent
    const recentRows = await query(`
      SELECT * FROM address_hourly_data
      WHERE address_id=$1
      ORDER BY timestamp DESC
      LIMIT 10
    `,[row.id]);
    let airNowClosest='N/A', airNowAverage='N/A';
    let purpleClosest='N/A', purpleAverage='N/A';
    let ts='(none)';
    if(recentRows.rows.length){
      const an = recentRows.rows.find(r => r.source==='AirNow');
      const pa = recentRows.rows.find(r => r.source==='PurpleAir');
      if(an){
        airNowClosest=an.aqi_closest;
        airNowAverage=an.aqi_average;
        ts=an.timestamp;
      }
      if(pa){
        purpleClosest=pa.aqi_closest;
        purpleAverage=pa.aqi_average;
        if(!ts) ts=pa.timestamp;
      }
    }
    // last 24 hr avg
    const dayAgo = new Date();
    dayAgo.setHours(dayAgo.getHours()-24);
    const dayRows = await query(`
      SELECT source,
             AVG(aqi_closest) as closest_avg
      FROM address_hourly_data
      WHERE address_id=$1
        AND timestamp>$2
      GROUP BY source
    `,[row.id, dayAgo]);
    let an24='N/A';
    let pa24='N/A';
    for(const d of dayRows.rows){
      if(d.source==='AirNow') an24 = Math.round(d.closest_avg || 0);
      if(d.source==='PurpleAir') pa24 = Math.round(d.closest_avg || 0);
    }

    lines.push(`Address: ${row.address}\nMost recent (ts=${ts}):\n - AirNow => closest=${airNowClosest}, avgInRadius=${airNowAverage}\n - PurpleAir => closest=${purpleClosest}, avgInRadius=${purpleAverage}\n24hrAvg => AirNow=${an24}, PurpleAir=${pa24}\n`);
  }
  return lines.join('\n\n');
}

app.listen(process.env.PORT||3000, async()=>{
  await initDB();
  console.log(`Server running on port ${process.env.PORT||3000}`);
});
