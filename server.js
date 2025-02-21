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
import { distanceMiles, colorCodeAQI, getAQIColorStyle, pm25toAQI } from './utils.js';

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

/** Convert wind deg & speed array to average deg & speed via vector sum. */
function avgWindDirection(winds) {
  // winds is an array of {speed, deg}
  // We'll convert each to x,y => sum => average => convert back
  if(!winds.length) return { avgSpeed: 0, avgDeg: 0 };
  let xSum=0, ySum=0, sSum=0;
  for(const w of winds){
    const sp = w.speed||0;
    const dg = w.deg||0;
    // deg -> radians
    const rad = dg*Math.PI/180;
    xSum += sp*Math.cos(rad);
    ySum += sp*Math.sin(rad);
    sSum++;
  }
  const avgX = xSum/sSum;
  const avgY = ySum/sSum;
  // average speed is magnitude
  const avgSpeed = Math.sqrt(avgX*avgX + avgY*avgY);
  // direction
  let avgDeg = Math.atan2(avgY, avgX)*(180/Math.PI);
  if(avgDeg<0) avgDeg+=360;
  return { avgSpeed, avgDeg };
}

function getCardinal(deg){
  if (deg == null) return 'Unknown';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(deg/45) % 8;
  return dirs[idx];
}

// ========== A) AirNow
async function fetchAirNowInRadius(lat, lon, radiusMiles) {
  const debugInfo = { lat, lon, radiusMiles };
  try {
    const offset=1.0; // bigger bounding box
    const minLat=lat-offset, maxLat=lat+offset;
    const minLon=lon-offset, maxLon=lon+offset;
    debugInfo.boundingBox={ minLon, minLat, maxLon, maxLat };

    const url='https://www.airnowapi.org/aq/data/';
    const hourStr = new Date().toISOString().slice(0,13);
    const resp=await axios.get(url, {
      params:{
        startDate: hourStr,
        endDate: hourStr,
        parameters: 'pm25',
        BBOX:`${minLon},${minLat},${maxLon},${maxLat}`,
        dataType:'A',
        format:'application/json',
        verbose:0,
        API_KEY: process.env.AIRNOW_API_KEY
      }
    });
    if(!Array.isArray(resp.data) || !resp.data.length){
      debugInfo.message='No AirNow sensors returned';
      return { closest:0, average:0, debug:debugInfo };
    }
    debugInfo.sensorCount = resp.data.length;

    let closestDist=Infinity, closestVal=null, sum=0, count=0;
    const sensorDetails=[];
    for(const sensor of resp.data){
      const sLat=sensor.Latitude, sLon=sensor.Longitude;
      const dist=distanceMiles(lat, lon, sLat, sLon);
      sensorDetails.push({
        lat:sLat, lon:sLon, aqi:sensor.AQI, dist
      });
      if(dist<=radiusMiles){
        sum+=sensor.AQI;
        count++;
        if(dist<closestDist){
          closestDist=dist;
          closestVal=sensor.AQI;
        }
      }
    }
    debugInfo.sensors = sensorDetails.filter(s => s.dist<=radiusMiles);
    if(!count){
      debugInfo.message='No AirNow sensors in radius';
      return { closest:0, average:0, debug:debugInfo };
    }
    const avg=Math.round(sum/count);
    return { closest:closestVal||0, average:avg, debug:debugInfo };
  } catch(err){
    debugInfo.error=err.message;
    return { closest:0, average:0, debug:debugInfo };
  }
}

// ========== B) PurpleAir
async function fetchPurpleAirInRadius(lat, lon, radiusMiles) {
  const debugInfo={ lat, lon, radiusMiles };
  try {
    const offset=1.0; // bigger bounding box
    const minLat=lat-offset, maxLat=lat+offset;
    const minLon=lon-offset, maxLon=lon+offset;
    debugInfo.boundingBox={ minLon, minLat, maxLon, maxLat };

    // single call
    const url='https://api.purpleair.com/v1/sensors';
    const resp=await axios.get(url, {
      headers:{ 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params:{
        fields:'pm2.5,latitude,longitude',
        nwlng: minLon,
        nwlat: maxLat,
        selng: maxLon,
        selat: minLat
      }
    });
    if(!resp.data || !resp.data.data){
      debugInfo.message='No PurpleAir data returned';
      return { closest:0, average:0, debug:debugInfo };
    }
    debugInfo.sensorCount=resp.data.data.length;

    let closestDist=Infinity, sum=0, count=0, closestVal=null;
    const sensorDetails=[];
    for(const sensor of resp.data.data){
      // sensor => [id, pm25, lat, lon]
      // Indices can vary by docs. But presumably:
      // sensor[1] => pm2.5
      // sensor[2] => lat
      // sensor[3] => lon
      const pm25 = sensor[1]||0;
      // Convert pm25 => actual AQI
      const aqi = pm25toAQI(pm25);
      const sLat=sensor[2], sLon=sensor[3];
      const dist=distanceMiles(lat, lon, sLat, sLon);

      sensorDetails.push({
        pm25, aqi, lat:sLat, lon:sLon, dist
      });
      if(dist<=radiusMiles){
        sum+=aqi;
        count++;
        if(dist<closestDist){
          closestDist=dist;
          closestVal=aqi;
        }
      }
    }
    debugInfo.sensors=sensorDetails.filter(s => s.dist<=radiusMiles);

    if(!count){
      debugInfo.message='No PurpleAir sensors in radius';
      return { closest:0, average:0, debug:debugInfo };
    }
    const avg=Math.round(sum/count);
    return { closest:closestVal||0, average:avg, debug:debugInfo };
  } catch(err){
    debugInfo.error=err.message;
    return { closest:0, average:0, debug:debugInfo };
  }
}

// ========== C) OpenWeather
async function fetchOpenWeather(lat, lon){
  const debugInfo={ lat, lon };
  try{
    const url='https://api.openweathermap.org/data/2.5/weather';
    const resp=await axios.get(url,{
      params:{
        lat, lon,
        appid: process.env.OPENWEATHER_API_KEY,
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
      tempF:0,
      humidity:0,
      windSpeed:0,
      windDeg:0,
      windDir:'Unknown',
      debug:debugInfo
    };
  }
}

// ========== Insert data & 24hr logic ==========
async function fetchAndStoreHourlyDataForUser(userId){
  const userRows=await query('SELECT aqi_radius FROM users WHERE id=$1',[userId]);
  if(!userRows.rows.length) return;
  const radiusMiles=userRows.rows[0].aqi_radius||5;

  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  for(const adr of addrRes.rows){
    if(!adr.lat||!adr.lon) continue;

    const [airNowRes, purpleRes, owRes] = await Promise.all([
      fetchAirNowInRadius(adr.lat, adr.lon, radiusMiles),
      fetchPurpleAirInRadius(adr.lat, adr.lon, radiusMiles),
      fetchOpenWeather(adr.lat, adr.lon)
    ]);

    const now=new Date();

    // Insert AirNow
    const dataAirNow={
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
      ON CONFLICT DO NOTHING
    `,[ userId, adr.id, now, 'AirNow', airNowRes.closest, airNowRes.average, dataAirNow ]);

    // Insert PurpleAir
    const dataPurple={
      type:'PurpleAir',
      fetchedAt: now.toISOString(),
      // storing the raw pm2.5 => AQI in aqi_closest/aqi_average
      // debug in data_json
      closestAQI: purpleRes.closest,
      radiusAQI: purpleRes.average,
      debug: purpleRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING
    `,[ userId, adr.id, now, 'PurpleAir', purpleRes.closest, purpleRes.average, dataPurple ]);

    // Insert OpenWeather
    const dataOW={
      type:'OpenWeather',
      fetchedAt: now.toISOString(),
      tempF: owRes.tempF,
      humidity: owRes.humidity,
      windSpeed: owRes.windSpeed,
      windDeg: owRes.windDeg,
      windDir: owRes.windDir,
      debug: owRes.debug
    };
    // store 0 in numeric aqi fields
    await query(`
      INSERT INTO address_hourly_data 
        (user_id, address_id, timestamp, source, aqi_closest, aqi_average, data_json)
      VALUES ($1,$2,$3,$4,0,0,$5)
      ON CONFLICT DO NOTHING
    `,[ userId, adr.id, now, 'OpenWeather', dataOW ]);

    // Now we compute trailing 24hr average 
    await updateTrailing24hAverages(userId, adr.id, now);
  }
}

/**
 * For each source in the last 24 hours, compute:
 * - closest24hrAvg => average of (aqi_closest)
 * - radius24hrAvg => average of (aqi_average)
 *
 * For OpenWeather: we want average temp, average wind speed, and a vector average for direction.
 * We'll store them in data_json as ow24hrTemp, ow24hrWindSpeed, ow24hrWindDeg, ow24hrWindDir, etc.
 */
async function updateTrailing24hAverages(userId, addressId, timestamp){
  const dayAgo=new Date(timestamp);
  dayAgo.setHours(dayAgo.getHours()-24);

  // 1) For AirNow & PurpleAir: we can do an aggregated approach
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
    const src=row.source; // 'AirNow' or 'PurpleAir' or 'OpenWeather'
    const c24 = Math.round(row.closest_avg||0);
    const r24 = Math.round(row.radius_avg||0);

    // load the row we just inserted
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

    if(src==='AirNow' || src==='PurpleAir'){
      d.closest24hrAvg=c24;
      d.radius24hrAvg=r24;
    }
    // We'll handle OpenWeather separately if we want to do a real average:
  }

  // 2) For OpenWeather, we gather all the data points from the last 24 hours + this hour
  const owRows=await query(`
    SELECT id, data_json, timestamp
    FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND timestamp >= $3
      AND source='OpenWeather'
    ORDER BY timestamp
  `,[ userId, addressId, dayAgo ]);

  if(owRows.rows.length){
    let tempSum=0, wArr=[];
    let count=0;
    for(const row of owRows.rows){
      const j=row.data_json||{};
      const t=j.tempF||0;
      const sp=j.windSpeed||0;
      const dg=j.windDeg||0;
      tempSum+=t;
      wArr.push({ speed: sp, deg: dg });
      count++;
    }
    let avgTemp=0, avgSpeed=0, avgDeg=0, avgDir='Unknown';
    if(count>0){
      avgTemp=tempSum/count;
      const wRes=avgWindDirection(wArr);
      avgSpeed=wRes.avgSpeed;
      avgDeg=wRes.avgDeg;
      avgDir=getCardinal(avgDeg);
    }
    // store in the row we just inserted for [timestamp,'OpenWeather']
    const fetchCur=await query(`
      SELECT * FROM address_hourly_data
      WHERE user_id=$1
        AND address_id=$2
        AND timestamp=$3
        AND source='OpenWeather'
    `,[ userId, addressId, timestamp ]);
    if(fetchCur.rows.length){
      let dbRow=fetchCur.rows[0];
      let d=dbRow.data_json||{};
      d.ow24hrTemp = Math.round(avgTemp);
      d.ow24hrWindSpeed = Math.round(avgSpeed*10)/10; // 1 decimal
      d.ow24hrWindDeg = Math.round(avgDeg);
      d.ow24hrWindDir = avgDir;
      await query(`
        UPDATE address_hourly_data
        SET data_json=$1
        WHERE id=$2
      `,[d, dbRow.id]);
    }
  }
}

// ========== Cron Schedules ==========

cron.schedule('0 * * * *', async()=>{
  console.log('[CRON] hourly triggered');
  try{
    const {rows:users}=await query('SELECT id FROM users');
    for(const u of users){
      await fetchAndStoreHourlyDataForUser(u.id);
    }
  } catch(e){ console.error('[CRON hourly]', e); }
});

// daily check
cron.schedule('*/15 * * * *', async()=>{
  console.log('[CRON] daily 15-min check');
  try{
    const now=new Date();
    const hour=now.getHours();
    const minute=now.getMinutes();
    const block=Math.floor(minute/15)*15;
    const {rows:dueUsers}=await query(`
      SELECT id,email 
      FROM users
      WHERE daily_report_hour=$1 AND daily_report_minute=$2
    `,[hour, block]);
    for(const du of dueUsers){
      await fetchAndStoreHourlyDataForUser(du.id);
      const final=await buildDailyEmail(du.id);
      if(final){
        await sendEmail(du.email, 'Your Daily AQI Update', final);
        console.log(`Sent daily to ${du.email}`);
      }
    }
  } catch(e){ console.error('[CRON daily check]', e); }
});

// ========== Daily Email
async function buildDailyEmail(userId){
  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  if(!addrRes.rows.length) return null;
  let lines=[];
  for(const adr of addrRes.rows){
    if(!adr.lat||!adr.lon){
      lines.push(`Address: ${adr.address}\n(No lat/lon)`);
      continue;
    }
    const rec=await query(`
      SELECT *
      FROM address_hourly_data
      WHERE address_id=$1
      ORDER BY timestamp DESC
      LIMIT 50
    `,[adr.id]);
    const an=rec.rows.find(r=>r.source==='AirNow');
    const pa=rec.rows.find(r=>r.source==='PurpleAir');
    const ow=rec.rows.find(r=>r.source==='OpenWeather');

    lines.push(`Address: ${adr.address}`);
    if(an){
      const c=an.aqi_closest||0;
      const r=an.aqi_average||0;
      const c24=an.data_json?.closest24hrAvg||0;
      const r24=an.data_json?.radius24hrAvg||0;
      lines.push(` AirNow => ClosestAQI=${c}, RadiusAvg=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(' AirNow => No data');
    }
    if(pa){
      const c=pa.aqi_closest||0;
      const r=pa.aqi_average||0;
      const c24=pa.data_json?.closest24hrAvg||0;
      const r24=pa.data_json?.radius24hrAvg||0;
      lines.push(` PurpleAir => ClosestAQI=${c}, RadiusAvg=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(' PurpleAir => No data');
    }
    if(ow){
      const d=ow.data_json||{};
      lines.push(` OpenWeather => Now: Temp=${d.tempF||0}F, Wind=${d.windSpeed||0} mph (${d.windDir||'?'} ${d.windDeg||0}°).
                  24hr Avg: Temp=${d.ow24hrTemp||0}F, Wind=${d.ow24hrWindSpeed||0} mph (${d.ow24hrWindDir||'?'} ${d.ow24hrWindDeg||0}°).`);
    } else {
      lines.push(' OpenWeather => No data');
    }
  }
  return lines.join('\n');
}

// ========== Express Routes ==========

app.use(express.static(path.join(__dirname)));

app.get('/',(req,res)=>{
  if(req.isAuthenticated()) return res.redirect('/html/dashboard.html');
  res.sendFile(path.join(__dirname,'index.html'));
});

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

// SIGNUP / FORGOT / RESET etc. omitted for brevity

// ADD / DELETE address
app.post('/api/add-address', ensureAuth, async(req,res)=>{
  const { address }=req.body;
  if(!address) return res.status(400).send('No address provided');
  const cnt=await query('SELECT COUNT(*) FROM user_addresses WHERE user_id=$1',[req.user.id]);
  const c=parseInt(cnt.rows[0].count,10);
  if(c>=3) return res.status(400).send('Max 3 addresses');
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
  `,[req.user.id, address.trim(), lat, lon]);
  res.redirect('/html/dashboard.html');
});
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
    [parseInt(hour,10), parseInt(minute,10), req.user.id]);
  res.json({ success:true });
});

// list addresses
app.get('/api/list-addresses', ensureAuth, async(req,res)=>{
  try{
    const {rows}=await query('SELECT id,address,lat,lon FROM user_addresses WHERE user_id=$1 ORDER BY id',[req.user.id]);
    res.json(rows);
  } catch(e){
    console.error('/api/list-addresses error', e);
    res.status(500).json({error:'Internal error'});
  }
});

// myReport => show two rows for each source: current vs. 24hr
app.get('/api/myReport', ensureAuth, async(req,res)=>{
  try{
    const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[req.user.id]);
    if(!addrRes.rows.length){
      return res.json({ error:'No addresses. Please add an address.' });
    }
    let html='';
    for(const adr of addrRes.rows){
      if(!adr.lat||!adr.lon){
        html+=`<h4>Address: ${adr.address}</h4><p>(No lat/lon)</p>`;
        continue;
      }
      // gather newest row for each source
      const rec=await query(`
        SELECT *
        FROM address_hourly_data
        WHERE address_id=$1
        ORDER BY timestamp DESC
        LIMIT 50
      `,[adr.id]);
      const an=rec.rows.find(r=>r.source==='AirNow');
      const pa=rec.rows.find(r=>r.source==='PurpleAir');
      const ow=rec.rows.find(r=>r.source==='OpenWeather');

      html+=`<h4>Address: ${adr.address}</h4>`;

      // AIRNOW
      if(an){
        const c=an.aqi_closest||0, r=an.aqi_average||0;
        const c24=an.data_json?.closest24hrAvg||0;
        const r24=an.data_json?.radius24hrAvg||0;
        // color code
        const cStyle = getAQIColorStyle(c);
        const rStyle = getAQIColorStyle(r);
        const c24Style=getAQIColorStyle(c24);
        const r24Style=getAQIColorStyle(r24);
        const cat=colorCodeAQI(c);

        html+=`
          <table>
            <thead><tr><th colspan="2">AirNow</th></tr></thead>
            <tbody>
              <tr><td>Current Closest AQI</td>
                  <td style="${cStyle}">${c} (${cat})</td></tr>
              <tr><td>Current Radius Average</td>
                  <td style="${rStyle}">${r}</td></tr>
              <tr><td>Closest 24hr Average</td>
                  <td style="${c24Style}">${c24}</td></tr>
              <tr><td>Radius 24hr Average</td>
                  <td style="${r24Style}">${r24}</td></tr>
            </tbody>
          </table>
        `;
        // debug
        const dbg=an.data_json?.debug;
        if(dbg){
          html+=`<details><summary>AirNow Debug</summary>
            <pre>${JSON.stringify(dbg,null,2)}</pre>
          </details>`;
        }
      } else {
        html+=`<p>AirNow => No data</p>`;
      }

      // PurpleAir
      if(pa){
        const c=pa.aqi_closest||0, r=pa.aqi_average||0;
        const c24=pa.data_json?.closest24hrAvg||0;
        const r24=pa.data_json?.radius24hrAvg||0;
        const cStyle=getAQIColorStyle(c);
        const rStyle=getAQIColorStyle(r);
        const c24Style=getAQIColorStyle(c24);
        const r24Style=getAQIColorStyle(r24);
        const cat=colorCodeAQI(c);

        html+=`
          <table>
            <thead><tr><th colspan="2">PurpleAir (Converted pm2.5 => AQI)</th></tr></thead>
            <tbody>
              <tr><td>Current Closest AQI</td>
                  <td style="${cStyle}">${c} (${cat})</td></tr>
              <tr><td>Current Radius Average</td>
                  <td style="${rStyle}">${r}</td></tr>
              <tr><td>Closest 24hr Average</td>
                  <td style="${c24Style}">${c24}</td></tr>
              <tr><td>Radius 24hr Average</td>
                  <td style="${r24Style}">${r24}</td></tr>
            </tbody>
          </table>
        `;
        const dbg=pa.data_json?.debug;
        if(dbg){
          html+=`<details><summary>PurpleAir Debug</summary>
            <pre>${JSON.stringify(dbg,null,2)}</pre>
          </details>`;
        }
      } else {
        html+=`<p>PurpleAir => No data</p>`;
      }

      // OpenWeather
      if(ow){
        const d=ow.data_json||{};
        const curTemp=d.tempF||0;
        const curWS=d.windSpeed||0;
        const curWD=d.windDeg||0;
        const curDir=d.windDir||'Unknown';

        const avgTemp=d.ow24hrTemp||0;
        const avgWS=d.ow24hrWindSpeed||0;
        const avgWDdeg=d.ow24hrWindDeg||0;
        const avgWDdir=d.ow24hrWindDir||'Unknown';

        html+=`
          <table>
            <thead><tr><th colspan="2">OpenWeather</th></tr></thead>
            <tbody>
              <tr><td>Current Hourly</td>
                  <td>Temp=${curTemp}F, Wind=${curWS} mph from ${curDir} (${curWD}°)</td></tr>
              <tr><td>24hr Average</td>
                  <td>Temp=${avgTemp}F, Wind=${avgWS} mph from ${avgWDdir} (${avgWDdeg}°)</td></tr>
            </tbody>
          </table>
        `;
        if(d.debug){
          html+=`<details><summary>OpenWeather Debug</summary>
            <pre>${JSON.stringify(d.debug,null,2)}</pre>
          </details>`;
        }
      } else {
        html+=`<p>OpenWeather => No data</p>`;
      }
    }

    res.json({ html });
  }catch(e){
    console.error('[myReport error]', e);
    res.status(500).json({error:'Internal server error'});
  }
});

// Manual update
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
    res.status(502).json({ error:'Error: HTTP 502 - '+err});
  }
});

// Other routes for login, forgot, reset, etc. omitted for brevity

app.listen(process.env.PORT||3000, async()=>{
  await initDB();
  console.log(`Server running on port ${process.env.PORT||3000}`);
});
