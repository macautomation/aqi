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


// Added for test START
import authRoutes from "./auth.js"; // ✅ Import router from auth.js
// Added for test END

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});
const PgSession = pgSession(session);

const app = express();
app.use(bodyParser.urlencoded({ extended:true }));
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

// Added for test START
app.use("/auth", authRoutes); // ✅ Mount the auth routes

export default app;
// Added for test END

// Serve static
app.use(express.static(__dirname));

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

// Send email
async function sendEmail(to, subject, text){
  const msg={to, from:'noreply@littlegiant.app', subject, text};
  await sgMail.send(msg);
}

// Check password complexity
function isPasswordComplex(pass){
  if(pass.length<8)return false;
  if(!/[0-9]/.test(pass))return false;
  if(!/[A-Za-z]/.test(pass))return false;
  if(!/[^A-Za-z0-9]/.test(pass))return false;
  return true;
}

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
  if(!isPasswordComplex(password)){
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
        console.log('Geocoding address:', address);
        const geoURL='https://maps.googleapis.com/maps/api/geocode/json';
        const resp=await axios.get(geoURL,{params:{ address, key:process.env.GOOGLE_GEOCODE_KEY }});
        console.log('Geocode result:', JSON.stringify(resp.data));
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
  if(!isPasswordComplex(newPassword)) return res.status(400).send('New password not complex enough');
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

// GOOGLE
app.get('/auth/google', passport.authenticate('google',{scope:['email','profile']}));
app.get('/auth/google/callback',
  passport.authenticate('google',{failureRedirect:'/html/login.html'}),
  (req,res)=> res.redirect('/html/dashboard.html')
);

// APPLE
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

// GET REPORT
app.get('/api/myReport', ensureAuth, async(req,res)=>{
  const addrRes=await query('SELECT * FROM user_addresses WHERE user_id=$1',[req.user.id]);
  if(!addrRes.rows.length){
    return res.json({error:'No addresses. Please add an address.'});
  }
  let combined=[];
  for(const row of addrRes.rows){
    if(!row.lat||!row.lon){
      combined.push(`Address: ${row.address}\n(No lat/lon, cannot produce AQI)`);
      continue;
    }
    try {
      const aqi=await fetchAirNowAQI(row.lat,row.lon);
      const label=labelAirNowAQI(aqi);
      const ow=await fetchOpenWeather(row.lat,row.lon);

      const fireResult=await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
      const nearFire=fireResult?.nearFire||false;

      const xapppData=await scrapeXappp(row.lat,row.lon);
      const arcgisData=await scrapeArcgis(row.lat,row.lon);
      const windColor=getWindStatus(ow.windSpeed, ow.windDeg, nearFire);

      let lines=[];
      lines.push(`Address: ${row.address}`);
      lines.push(`**Average AQI**: ${aqi||0} (${label})`);
      lines.push(`**Wind**: Speed=${ow.windSpeed}, Deg=${ow.windDeg}, Indicator=${windColor}`);
      if(xapppData) lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText||'N/A'}`);
      if(arcgisData) lines.push(`ArcGIS: ${arcgisData.note}`);
      if(nearFire) lines.push(`Near fire boundary (<50 miles)`);
      combined.push(lines.join('\n'));
    } catch(e) {
      console.error('[myReport scraping error for address:', row.address, ']', e);
      combined.push(`Address: ${row.address}\nHourly Report Not Yet Built (Scraping failed).`);
    }
  }
  if(!combined.length){
    return res.json({report: 'Hourly Report Not Yet Built.'});
  }
  const finalReport=combined.join('\n\n');
  res.json({report: finalReport});
});

// MANUAL RECHECK
app.post('/api/report-now', ensureAuth, async(req,res)=>{
  const baseUrl=`${req.protocol}://${req.get('host')}`;
  try{
    const resp=await axios.get(`${baseUrl}/api/myReport`,{
      headers:{cookie:req.headers.cookie||''}
    });
    if(!resp.data.report && resp.data.error){
      // if error => pass it along
      return res.status(400).json({error: resp.data.error});
    }
    if(!resp.data.report){
      return res.json({report:'Hourly Report Not Yet Built.'});
    }
    res.json({report: resp.data.report});
  }catch(err){
    console.error('[report-now error]',err);
    res.status(502).json({error:'Error: HTTP 502 - '+err});
  }
});

// CRON daily
cron.schedule('0 8 * * *', async()=>{
  console.log('[CRON] daily triggered');
  try{
    const {rows:users}=await query('SELECT id,email FROM users');
    for(const user of users){
      const {rows:addresses}=await query('SELECT * FROM user_addresses WHERE user_id=$1',[user.id]);
      if(!addresses.length){
        console.log(`User ${user.email} no addresses, skip daily`);
        continue;
      }
      let combined=[];
      for(const row of addresses){
        if(!row.lat||!row.lon){
          combined.push(`Address: ${row.address}\n(No lat/lon)`);
          continue;
        }
        try {
          const aqi=await fetchAirNowAQI(row.lat,row.lon);
          const label=labelAirNowAQI(aqi);
          const ow=await fetchOpenWeather(row.lat,row.lon);
          const fireResult=await scrapeFireAirnow('https://fire.airnow.gov/#10/34.1124/-118.1932');
          const nearFire=fireResult?.nearFire||false;
          const xapppData=await scrapeXappp(row.lat,row.lon);
          const arcgisData=await scrapeArcgis(row.lat,row.lon);
          const windColor=getWindStatus(ow.windSpeed, ow.windDeg, nearFire);

          let lines=[];
          lines.push(`Address: ${row.address}`);
          lines.push(`**Average AQI**: ${aqi||0} (${label})`);
          lines.push(`**Wind**: Speed=${ow.windSpeed}, Deg=${ow.windDeg}, Indicator=${windColor}`);
          if(xapppData) lines.push(`Station: ${xapppData.station}, AQI=${xapppData.aqiText||'N/A'}`);
          if(arcgisData) lines.push(`ArcGIS: ${arcgisData.note}`);
          if(nearFire) lines.push(`Near fire boundary (<50 miles)`);
          combined.push(lines.join('\n'));
        } catch(e) {
          console.error('[Cron daily scrape error]', e);
          combined.push(`Address: ${row.address}\nHourly Report Not Yet Built (Scrape fail).`);
        }
      }
      if(!combined.length) continue;
      const final=combined.join('\n\n');
      await sendEmail(user.email,'Your Daily AQI Update',final);
      console.log(`Sent daily update to ${user.email}`);
    }
  }catch(e){
    console.error('[CRON daily]',e);
  }
});

// ensureAuth => If an /api route & not authed => 401 JSON
function ensureAuth(req,res,next){
  if(req.isAuthenticated()) return next();
  if(req.path.startsWith('/api/')){
    return res.status(401).json({error:'Not authenticated'});
  }
  return res.redirect('/html/login.html');
}

app.listen(process.env.PORT||3000, async()=>{
  await initDB();
  console.log(`Server running on port ${process.env.PORT||3000}`);
});
