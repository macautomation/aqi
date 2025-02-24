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
import './auth.js';  // your passport local, google, apple strategies
import {
  distanceMiles, colorCodeAQI, getAQIColorStyle,
  pm25toAQI, formatDayTimeForUser
} from './utils.js';

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

// Helper: ensureAuth
function ensureAuth(req,res,next){
  if(req.isAuthenticated()) return next();
  if(req.path.startsWith('/api/')){
    return res.status(401).json({error:'Not authenticated'});
  }
  return res.redirect('/html/login.html');
}

async function sendEmail(to, subject, text){
  const msg={to, from:'noreply@littlegiant.app', subject, text};
  await sgMail.send(msg);
}

// Helper: Convert wind deg => cardinal
function getCardinal(deg){
  if (deg == null) return 'Unknown';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(deg/45) % 8;
  return dirs[idx];
}

// ========== (A) PurpleAir sensor initialization logic ==========

/**
 * Once a user adds an address, we do this once:
 * 1) bounding-box call with location_type=0
 * 2) filter sensors that lastSeen <=1hr
 * 3) pick up to 10 that have high confidence, etc.
 * 4) if none in the user's radius, expand the radius until we find some
 * 5) store them in user_addresses.purpleair_sensor_ids so subsequent calls can do show_only=...
 */
async function initializePurpleAirSensorsForAddress(addressId, userRadiusMiles) {
  const addrRes = await query('SELECT * FROM user_addresses WHERE id=$1',[addressId]);
  if(!addrRes.rows.length) return;
  const row = addrRes.rows[0];
  if(!row.lat || !row.lon) return;
  let radiusMiles = userRadiusMiles||5;
  let attempts=0, chosenSensors=[];
  const maxAttempts=5; // expand up to 5 times

  while(!chosenSensors.length && attempts<maxAttempts) {
    attempts++;
    // approximate => 1 deg lat ~69 miles
    const latOffset = radiusMiles/69;
    const lonOffset = radiusMiles/69;
    const minLat = row.lat - latOffset;
    const maxLat = row.lat + latOffset;
    const minLon = row.lon - lonOffset;
    const maxLon = row.lon + lonOffset;

    const fields = 'sensor_index,last_seen,latitude,longitude,uptime,confidence,voc,pm1.0,pm2.5,pm2.5_60minute,pm2.5_alt,pm10.0,position_rating,ozone1';
    const resp = await axios.get('https://api.purpleair.com/v1/sensors', {
      headers:{ 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params:{
        location_type:0,
        nwlng: minLon,
        nwlat: maxLat,
        selng: maxLon,
        selat: minLat,
        fields
      }
    });
    const data = resp.data?.data||[];
    const nowSec = Math.floor(Date.now()/1000);

    // convert array => objects
    let sensorDetails = data.map(arr=>{
      return {
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
      };
    });

    // filter lastSeen <= 1 hour
    sensorDetails = sensorDetails.filter(s => (nowSec - s.lastSeen)<=3600);

    // compute distance
    sensorDetails.forEach(s=>{
      s.distMiles = distanceMiles(row.lat, row.lon, s.lat, s.lon);
    });
    sensorDetails = sensorDetails.filter(s => s.distMiles<=radiusMiles);

    if(sensorDetails.length){
      // sort by confidence desc, then uptime desc
      sensorDetails.sort((a,b)=>{
        if(b.confidence!==a.confidence) return b.confidence - a.confidence;
        return b.uptime - a.uptime;
      });
      chosenSensors = sensorDetails.slice(0,10); 
    } else {
      radiusMiles *=2;
    }
  }

  if(!chosenSensors.length){
    // No sensors found at all
    await query('UPDATE user_addresses SET purpleair_sensor_ids=$1 WHERE id=$2',['', addressId]);
    return;
  }
  const sensorIDs = chosenSensors.map(s=>s.sensorIndex).join(',');
  await query('UPDATE user_addresses SET purpleair_sensor_ids=$1 WHERE id=$2',[sensorIDs, addressId]);
}

/**
 * fetchPurpleAirForAddress => use show_only=..., parse data, compute closest + average.
 */
async function fetchPurpleAirForAddress(addressRow){
  if(!addressRow.purpleair_sensor_ids){
    // fallback => no sensor IDs => no data
    return { closest:0, average:0, debug:{ fallback:'No sensor IDs set' } };
  }
  const showOnly = addressRow.purpleair_sensor_ids;
  if(!showOnly) {
    return { closest:0, average:0, debug:{ fallback:'Blank sensor IDs' } };
  }

  const fields='sensor_index,last_seen,latitude,longitude,uptime,confidence,voc,pm1.0,pm2.5,pm2.5_60minute,pm2.5_alt,pm10.0,position_rating,ozone1';
  const resp=await axios.get('https://api.purpleair.com/v1/sensors',{
    headers:{ 'X-API-Key': process.env.PURPLEAIR_API_KEY },
    params:{
      location_type:0,
      show_only: showOnly,
      fields
    }
  });
  const data = resp.data?.data||[];
  if(!data.length){
    return { closest:0, average:0, debug:{ showOnly, message:'No sensors found from show_only' } };
  }
  let sensorDetails = data.map(arr=>{
    return {
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
    };
  });
  // compute distance + convert pm2.5 => aqi
  sensorDetails.forEach(s=>{
    s.distMiles = distanceMiles(addressRow.lat, addressRow.lon, s.lat, s.lon);
    s.aqi = pm25toAQI(s.pm2_5||0);
  });
  let closestDist=Infinity, closestVal=0, sum=0, count=0;
  const debugSensors=[];
  for(const s of sensorDetails){
    debugSensors.push({
      sensorIndex: s.sensorIndex,
      pm2_5: s.pm2_5,
      aqi: s.aqi,
      dist: s.distMiles,
      lastSeen: s.lastSeen,
      confidence: s.confidence,
      voc: s.voc,
      pm1_0: s.pm1_0,
      pm2_5_60m: s.pm2_5_60m,
      pm2_5_alt: s.pm2_5_alt,
      pm10_0: s.pm10_0,
      ozone1: s.ozone1
    });
    sum += s.aqi;
    count++;
    if(s.distMiles<closestDist){
      closestDist=s.distMiles;
      closestVal=s.aqi;
    }
  }
  if(!count) {
    return { closest:0, average:0, debug:{ showOnly, sensorCount:0, message:'All sensors filtered out' } };
  }
  const avg = Math.round(sum/count);
  return {
    closest: closestVal,
    average: avg,
    debug:{
      approach:'show_only',
      sensorCount: count,
      lat: addressRow.lat,
      lon: addressRow.lon,
      sensors: debugSensors,
      nearestDistance: closestDist
    }
  };
}

// ========== (B) AirNow + OpenWeather calls omitted for brevity => but included below ==========

async function fetchAirNowAQI(lat, lon, radiusMiles) {
  // bounding box logic
  const degOffset=1.0; // big enough
  const minLat=lat-degOffset, maxLat=lat+degOffset;
  const minLon=lon-degOffset, maxLon=lon+degOffset;
  const hourStr=new Date().toISOString().slice(0,13);

  const debugInfo={ lat, lon, boundingBox:{minLat,maxLat,minLon,maxLon}, radiusMiles };
  const url='https://www.airnowapi.org/aq/data/';
  try {
    const resp=await axios.get(url,{
      params:{
        startDate: hourStr,
        endDate: hourStr,
        parameters:'pm25',
        BBOX:`${minLon},${minLat},${maxLon},${maxLat}`,
        dataType:'A',
        format:'application/json',
        verbose:0,
        API_KEY: process.env.AIRNOW_API_KEY
      }
    });
    if(!Array.isArray(resp.data)||!resp.data.length){
      debugInfo.message='No AirNow sensors returned';
      return { closest:0, average:0, debug:debugInfo };
    }
    debugInfo.sensorCount=resp.data.length;
    let sum=0, count=0, closestDist=Infinity, closestVal=0;
    const sensorDetails=[];
    for(const s of resp.data){
      const dist=distanceMiles(lat,lon, s.Latitude, s.Longitude);
      sensorDetails.push({
        lat:s.Latitude, lon:s.Longitude, aqi:s.AQI, dist
      });
      if(dist<=radiusMiles){
        sum+=s.AQI;
        count++;
        if(dist<closestDist){
          closestDist=dist;
          closestVal=s.AQI;
        }
      }
    }
    debugInfo.sensors = sensorDetails.filter(x=>x.dist<=radiusMiles);
    if(!count){
      debugInfo.message='No sensors in user radius => maybe none close?';
      return {closest:0, average:0, debug:debugInfo};
    }
    const avg=Math.round(sum/count);
    return {closest:closestVal, average:avg, debug:debugInfo};
  } catch(err) {
    debugInfo.error=err.message;
    return {closest:0, average:0, debug:debugInfo};
  }
}

async function fetchOpenWeather(lat, lon){
  const debugInfo={ lat, lon };
  try{
    const resp=await axios.get('https://api.openweathermap.org/data/2.5/weather',{
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
      tempF: main.temp||0,
      humidity: main.humidity||0,
      windSpeed: wind.speed||0,
      windDeg: wind.deg||0,
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

// 24hr average helper => store in data_json. We show "Available at ..." if <24hr of data
async function updateTrailing24hAverages(userId, addressId, timestamp, source){
  const dayAgo=new Date(timestamp);
  dayAgo.setHours(dayAgo.getHours()-24);
  const rows=await query(`
    SELECT AVG(aqi_closest) as cAvg,
           AVG(aqi_average) as rAvg,
           COUNT(*) as cnt
    FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND source=$3
      AND timestamp>=$4
  `,[userId, addressId, source, dayAgo]);
  if(!rows.rows.length) return;

  const c24=Math.round(rows.rows[0].cavg||0);
  const r24=Math.round(rows.rows[0].ravg||0);
  const count=Number(rows.rows[0].cnt)||0;

  // load the row we just inserted
  const newRow=await query(`
    SELECT * FROM address_hourly_data
    WHERE user_id=$1
      AND address_id=$2
      AND source=$3
      AND timestamp=$4
  `,[userId, addressId, source, timestamp]);
  if(!newRow.rows.length) return;

  let dbRow=newRow.rows[0];
  let d=dbRow.data_json||{};
  // If count<24 => partial data => we store undefined, so we show "Available at..."
  if(count>=24){
    d.closest24hrAvg=c24;
    d.radius24hrAvg=r24;
  }
  await query(`
    UPDATE address_hourly_data
    SET data_json=$1
    WHERE id=$2
  `,[d, dbRow.id]);
}

/**
 * fetchAndStoreHourlyDataForUser => each hour or on-demand.
 */
async function fetchAndStoreHourlyDataForUser(userId){
  const userRows=await query('SELECT aqi_radius FROM users WHERE id=$1',[userId]);
  if(!userRows.rows.length) return;
  const radiusMiles = userRows.rows[0].aqi_radius||5;

  // addresses
  const addrRes=await query(`
    SELECT id, user_id, address, lat, lon, purpleair_sensor_ids
    FROM user_addresses
    WHERE user_id=$1
  `,[userId]);

  for(const adr of addrRes.rows){
    if(!adr.lat || !adr.lon) continue;

    // If PurpleAir sensors not set => initialize once
    if(!adr.purpleair_sensor_ids){
      await initializePurpleAirSensorsForAddress(adr.id, radiusMiles);
      const updated=await query('SELECT * FROM user_addresses WHERE id=$1',[adr.id]);
      if(updated.rows.length){
        adr.purpleair_sensor_ids=updated.rows[0].purpleair_sensor_ids;
      }
    }

    // (A) AirNow
    const airRes=await fetchAirNowAQI(adr.lat, adr.lon, radiusMiles);
    // (B) PurpleAir
    const purpleRes=await fetchPurpleAirForAddress(adr);
    // (C) OpenWeather
    const owRes=await fetchOpenWeather(adr.lat, adr.lon);

    const now=new Date();

    // Store AirNow
    let dataAir={
      type:'AirNow',
      fetchedAt:now.toISOString(),
      closestAQI: airRes.closest,
      radiusAQI: airRes.average,
      debug: airRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'AirNow',$4,$5,$6)
      ON CONFLICT DO NOTHING
    `,[ userId, adr.id, now, airRes.closest, airRes.average, dataAir ]);
    await updateTrailing24hAverages(userId, adr.id, now, 'AirNow');

    // Store PurpleAir
    let dataPA={
      type:'PurpleAir',
      fetchedAt:now.toISOString(),
      closestAQI: purpleRes.closest,
      radiusAQI: purpleRes.average,
      debug: purpleRes.debug
    };
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'PurpleAir',$4,$5,$6)
      ON CONFLICT DO NOTHING
    `,[ userId, adr.id, now, purpleRes.closest, purpleRes.average, dataPA ]);
    await updateTrailing24hAverages(userId, adr.id, now, 'PurpleAir');

    // Store OpenWeather
    let dataOW={
      type:'OpenWeather',
      fetchedAt:now.toISOString(),
      tempF: owRes.tempF,
      humidity: owRes.humidity,
      windSpeed: owRes.windSpeed,
      windDeg: owRes.windDeg,
      windDir: owRes.windDir,
      debug: owRes.debug
    };
    // not truly an AQI => store 0 in numeric columns
    await query(`
      INSERT INTO address_hourly_data
        (user_id,address_id,timestamp,source,aqi_closest,aqi_average,data_json)
      VALUES($1,$2,$3,'OpenWeather',0,0,$4)
      ON CONFLICT DO NOTHING
    `,[ userId, adr.id, now, dataOW ]);
    await updateTrailing24hAverages(userId, adr.id, now, 'OpenWeather');
  }
}

// We find earliest row in address_hourly_data to see if 24hr data is possible
async function earliestTimestampForAddress(addressId, source){
  const res=await query(`
    SELECT MIN(timestamp) as mint
    FROM address_hourly_data
    WHERE address_id=$1
      AND source=$2
  `,[addressId, source]);
  if(!res.rows.length || !res.rows[0].mint) return null;
  return new Date(res.rows[0].mint);
}

function format24hrAvailable(earliest){
  if(!earliest) return 'No data yet';
  // earliest +24 hours
  const d=new Date(earliest.getTime()+24*3600*1000);
  return formatDayTimeForUser(d);
}

// ========== CRON SCHEDULING ==========

// 1) Hourly
cron.schedule('0 * * * *', async()=>{
  console.log('[CRON] hourly triggered');
  try{
    const {rows:users}=await query('SELECT id FROM users');
    for(const u of users){
      await fetchAndStoreHourlyDataForUser(u.id);
    }
  } catch(e){
    console.error('[CRON hourly]', e);
  }
});

// 2) Daily every 15 min check
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
      WHERE daily_report_hour=$1
        AND daily_report_minute=$2
    `,[hour, block]);

    for(const du of dueUsers){
      await fetchAndStoreHourlyDataForUser(du.id);
      const final=await buildDailyEmail(du.id);
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
 * buildDailyEmail => plain text for all addresses
 */
async function buildDailyEmail(userId){
  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[userId]);
  if(!addrRes.rows.length) return null;
  let lines=[];
  for(const adr of addrRes.rows){
    if(!adr.lat||!adr.lon){
      lines.push(`Address: ${adr.address}\n(No lat/lon)`);
      continue;
    }
    lines.push(`Address: ${adr.address}`);

    // AirNow
    let an = await latestSourceRow(adr.id,'AirNow');
    if(an){
      let c=an.aqi_closest||0, r=an.aqi_average||0;
      let c24=an.data_json?.closest24hrAvg;
      let r24=an.data_json?.radius24hrAvg;
      if(c24===undefined){
        // show "Available at..."
        const earliest=await earliestTimestampForAddress(adr.id,'AirNow');
        c24=`Available at ${format24hrAvailable(earliest)}`;
      }
      if(r24===undefined){
        const earliest=await earliestTimestampForAddress(adr.id,'AirNow');
        r24=`Available at ${format24hrAvailable(earliest)}`;
      }
      lines.push(` AirNow => ClosestAQI=${c}, RadiusAvg=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(' AirNow => No data');
    }

    // PurpleAir
    let pa=await latestSourceRow(adr.id,'PurpleAir');
    if(pa){
      let c=pa.aqi_closest||0, r=pa.aqi_average||0;
      let c24=pa.data_json?.closest24hrAvg;
      let r24=pa.data_json?.radius24hrAvg;
      if(c24===undefined){
        const earliest=await earliestTimestampForAddress(adr.id,'PurpleAir');
        c24=`Available at ${format24hrAvailable(earliest)}`;
      }
      if(r24===undefined){
        const earliest=await earliestTimestampForAddress(adr.id,'PurpleAir');
        r24=`Available at ${format24hrAvailable(earliest)}`;
      }
      lines.push(` PurpleAir => ClosestAQI=${c}, RadiusAvg=${r}, 24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}`);
    } else {
      lines.push(' PurpleAir => No data');
    }

    // OpenWeather
    let ow=await latestSourceRow(adr.id,'OpenWeather');
    if(ow){
      let d=ow.data_json||{};
      let c24=d.ow24hrTemp;
      if(c24===undefined){
        const earliest=await earliestTimestampForAddress(adr.id,'OpenWeather');
        c24=`Available at ${format24hrAvailable(earliest)}`;
      }
      lines.push(` OpenWeather => current temp=${d.tempF||0}F wind=${d.windSpeed||0} mph, 24hrAvgTemp=${c24}`);
    } else {
      lines.push(' OpenWeather => No data');
    }
  }
  return lines.join('\n');
}

async function latestSourceRow(addressId, source){
  const rec=await query(`
    SELECT * FROM address_hourly_data
    WHERE address_id=$1 AND source=$2
    ORDER BY timestamp DESC
    LIMIT 1
  `,[addressId, source]);
  if(!rec.rows.length) return null;
  return rec.rows[0];
}

// ========== Express Routes ==========

app.use(express.static(__dirname));

app.get('/',(req,res)=>{
  if(req.isAuthenticated()) return res.redirect('/html/dashboard.html');
  res.sendFile(path.join(__dirname,'index.html'));
});

// Google places
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
  if(password.length<8||!/[0-9]/.test(password)||!/[A-Za-z]/.test(password)||!/[^A-Za-z0-9]/.test(password)){
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

// ADD ADDRESS => also triggers PurpleAir sensor init
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
  const insertRes=await query(`
    INSERT INTO user_addresses(user_id,address,lat,lon)
    VALUES($1,$2,$3,$4)
    RETURNING id
  `,[req.user.id, address.trim(), lat, lon]);

  // Optionally do sensor init right away
  // We'll do it in fetchAndStoreHourlyData if we want
  // but we can also do it here
  // for brevity, skip

  res.redirect('/html/dashboard.html');
});

// DELETE ADDRESS
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
  try {
    const {rows}=await query('SELECT id,address,lat,lon FROM user_addresses WHERE user_id=$1 ORDER BY id',[req.user.id]);
    res.json(rows);
  } catch(e){
    console.error('/api/list-addresses error', e);
    res.status(500).json({error:'Internal error'});
  }
});

// /api/myReport => returns HTML snippet for the dashboard
app.get('/api/myReport', ensureAuth, async(req,res)=>{
  try{
    const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[req.user.id]);
    if(!addrRes.rows.length){
      return res.json({ error:'No addresses. Please add an address.' });
    }
    let html='';
    for(const adr of addrRes.rows){
      html+=`<h4>Address: ${adr.address}</h4>`;
      if(!adr.lat||!adr.lon){
        html+=`<p>(No lat/lon, cannot produce AQI)</p>`;
        continue;
      }
      // We'll fetch the newest row for AirNow, PurpleAir, OpenWeather
      let an=await latestSourceRow(adr.id,'AirNow');
      let pa=await latestSourceRow(adr.id,'PurpleAir');
      let ow=await latestSourceRow(adr.id,'OpenWeather');

      // AIRNOW
      if(an){
        const c=an.aqi_closest||0, r=an.aqi_average||0;
        const cat=colorCodeAQI(c);
        const cStyle=getAQIColorStyle(c);
        const rStyle=getAQIColorStyle(r);
        // 24hr
        let c24=an.data_json?.closest24hrAvg;
        let r24=an.data_json?.radius24hrAvg;
        if(c24===undefined){
          const earliest=await earliestTimestampForAddress(adr.id,'AirNow');
          c24=`Available at ${format24hrAvailable(earliest)}`;
        }
        if(r24===undefined){
          const earliest=await earliestTimestampForAddress(adr.id,'AirNow');
          r24=`Available at ${format24hrAvailable(earliest)}`;
        }
        // small debug
        const debugLink=buildDebugPopupLink(an.data_json?.debug||{}, 'AirNow Debug');
        html+=`
          <p>AirNow => 
            Closest <span style="${cStyle}">${c} (${cat})</span> 
            <a href="#" onclick="showDetailPopup(\`${debugLink}\`, event);return false;">[more detail]</a>,
            Radius <span style="${rStyle}">${r}</span>,
            24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}
          </p>
        `;
      } else {
        html+=`<p>AirNow => No data</p>`;
      }

      // PURPLEAIR
      if(pa){
        const c=pa.aqi_closest||0, r=pa.aqi_average||0;
        const cat=colorCodeAQI(c);
        const cStyle=getAQIColorStyle(c);
        const rStyle=getAQIColorStyle(r);
        let c24=pa.data_json?.closest24hrAvg;
        let r24=pa.data_json?.radius24hrAvg;
        if(c24===undefined){
          const earliest=await earliestTimestampForAddress(adr.id,'PurpleAir');
          c24=`Available at ${format24hrAvailable(earliest)}`;
        }
        if(r24===undefined){
          const earliest=await earliestTimestampForAddress(adr.id,'PurpleAir');
          r24=`Available at ${format24hrAvailable(earliest)}`;
        }
        // possibly show nearest sensor distance
        let nearestDist='';
        if(pa.data_json?.debug?.nearestDistance!==undefined){
          nearestDist=`Nearest sensor is ${pa.data_json.debug.nearestDistance.toFixed(1)} miles away. `;
        }
        // build debug link
        const debugLink=buildDebugPopupLink(pa.data_json?.debug||{}, 'PurpleAir Debug');

        html+=`
          <p>PurpleAir => 
            Closest <span style="${cStyle}">${c} (${cat})</span>
            <a href="#" onclick="showDetailPopup(\`${debugLink}\`, event);return false;">[more detail]</a>,
            Radius <span style="${rStyle}">${r}</span>,
            24hrClosestAvg=${c24}, 24hrRadiusAvg=${r24}
            <br>${nearestDist}
          </p>
        `;
      } else {
        html+=`<p>PurpleAir => No data</p>`;
      }

      // OPENWEATHER
      if(ow){
        let d=ow.data_json||{};
        let c24=d.closest24hrAvg; // if we did that logic
        let r24=d.radius24hrAvg;  // might not exist
        // if we want to store 24hr average of temp => we might do that
        if(c24===undefined){
          const earliest=await earliestTimestampForAddress(adr.id,'OpenWeather');
          c24=`Available at ${format24hrAvailable(earliest)}`;
        }
        // debug link
        const debugLink=buildDebugPopupLink(d.debug||{}, 'OpenWeather Debug');

        html+=`
          <p>OpenWeather => 
            Temp=${d.tempF||0}F, Wind=${d.windSpeed||0} mph from ${d.windDir||'??'} (${d.windDeg||0}°),
            <a href="#" onclick="showDetailPopup(\`${debugLink}\`, event);return false;">[more detail]</a>
            <br>24hrAvgTemp=${c24}
          </p>
        `;
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

// A small helper to build a JSON-like string for popup
function buildDebugPopupLink(debugObj, title){
  const raw = JSON.stringify(debugObj,null,2);
  // Escape backticks
  const safe=raw.replace(/`/g,'\\`');
  const safeTitle=title.replace(/`/g,'\\`');
  return `<h3>${safeTitle}</h3><pre>${safe}</pre>`;
}

// manual re-check
app.post('/api/report-now', ensureAuth, async(req,res)=>{
  try {
    await fetchAndStoreHourlyDataForUser(req.user.id);
    const baseUrl=`${req.protocol}://${req.get('host')}`;
    const r=await axios.get(`${baseUrl}/api/myReport`,{
      headers:{cookie:req.headers.cookie||''}
    });
    res.json(r.data);
  } catch(err){
    console.error('[report-now error]', err);
    res.status(502).json({ error:'Error: HTTP 502 - '+err });
  }
});

// FORGOT, RESET, OAUTH, etc. omitted for brevity (include your existing code for those)

app.listen(process.env.PORT||3000, async()=>{
  await initDB();
  console.log(`Server running on port ${process.env.PORT||3000}`);
});
