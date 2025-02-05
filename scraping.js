// scraping.js
import puppeteer from 'puppeteer';
import axios from 'axios';
import { distanceMiles } from './utils.js'; // We'll create a utils file for distance
import nodemailer from 'nodemailer';
import _ from 'lodash';

// For urgent DOM changes
const ALERT_EMAIL = 'maciver@littlegiant.app'; // site structure changes => urgent alert
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

////////////////////////////////////////////////////////////////////////
// 1) PURPLEAIR PM2.5
////////////////////////////////////////////////////////////////////////
export async function getPurpleAirPM25(lat, lon) {
  try {
    const url = 'https://api.purpleair.com/v1/sensors';
    const resp = await axios.get(url, {
      headers: { 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params: {
        fields: 'pm2.5,latitude,longitude',
        location_type: '0',
        nwlng: lon - 0.05,
        nwlat: lat + 0.05,
        selng: lon + 0.05,
        selat: lat - 0.05
      }
    });
    if (resp.data?.data?.length) {
      let bestDist = Infinity;
      let bestVal = null;
      for (const sensor of resp.data.data) {
        const sLat = sensor[2];
        const sLon = sensor[3];
        const d = Math.sqrt((sLat - lat)**2 + (sLon - lon)**2);
        if (d < bestDist) {
          bestDist = d;
          bestVal = sensor[1];
        }
      }
      return bestVal;
    }
    return null;
  } catch (err) {
    console.error('[PurpleAir] error', err.message);
    return null;
  }
}

////////////////////////////////////////////////////////////////////////
// 2) aqrc.shinyapps.io/ascent_public_socal for lead, chlorine, bromine
//    if within 20 miles of LA (34.010278, -118.068611),
//    Riverside (33.99958, -117.41601),
//    Joshua Tree (34.06957, -116.38893)
////////////////////////////////////////////////////////////////////////
const AQRC_SITES = [
  { name: 'Los Angeles site', lat: 34.010278, lon: -118.068611 },
  { name: 'Riverside', lat: 33.99958, lon: -117.41601 },
  { name: 'Joshua Tree', lat: 34.06957, lon: -116.38893 }
];

export async function getAqrcData(lat, lon) {
  // Check site proximity
  const site = AQRC_SITES.find(s => distanceMiles(lat, lon, s.lat, s.lon) <= 20);
  if (!site) return null; // user not in range

  const browser = await puppeteer.launch({ headless: 'new' });
  let data = null;
  try {
    const page = await browser.newPage();
    await page.goto('https://aqrc.shinyapps.io/ascent_public_socal/', {
      waitUntil: 'domcontentloaded'
    });

    // We expect certain DOM elements. If they're missing, we send alert.
    const isStructureValid = await page.$('div.shiny-plot-output') !== null;
    if (!isStructureValid) {
      await sendDomChangeAlert('aqrc.shinyapps.io/ascent_public_socal');
      return null;
    }

    // We'll do a naive text extraction:
    const text = await page.evaluate(() => document.body.innerText);
    // Example: we assume text might contain "Lead: X, Chlorine: Y, Bromine: Z".
    const leadMatch = text.match(/Lead:\s*([\d.]+)/i);
    const chlorineMatch = text.match(/Chlorine:\s*([\d.]+)/i);
    const bromineMatch = text.match(/Bromine:\s*([\d.]+)/i);

    data = {
      site: site.name,
      lead: leadMatch ? leadMatch[1] : null,
      chlorine: chlorineMatch ? chlorineMatch[1] : null,
      bromine: bromineMatch ? bromineMatch[1] : null
    };
  } catch (err) {
    console.error('[AqrcData] error', err);
  } finally {
    await browser.close();
  }
  return data;
}

////////////////////////////////////////////////////////////////////////
// 3) xappp.aqmd.gov/aqdetail => if user is within 10 miles of a city center
////////////////////////////////////////////////////////////////////////
const STATIONS = [
  // Hypothetical list of station coords from "Select a Station" dropdown
  // e.g. { city: 'Anaheim', lat: 33.8353, lon: -117.9145, value: 'anaheimStation' },
  // ...
];

export async function getAqmdAqi(lat, lon) {
  // Find station within 10 miles
  const station = STATIONS.find(s => distanceMiles(lat, lon, s.lat, s.lon) <= 10);
  if (!station) return null;

  const browser = await puppeteer.launch({ headless: 'new' });
  let result = null;
  try {
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });

    // Check DOM
    const stationDropdown = await page.$('#stationDropdown');
    if (!stationDropdown) {
      await sendDomChangeAlert('xappp.aqmd.gov/aqdetail');
      return null;
    }

    // Set the dropdown
    await page.select('#stationDropdown', station.value);
    await page.waitForTimeout(2000); // wait for data to load
    // Suppose there's an element with ID #aqiEquivalent
    const aqiText = await page.$eval('#aqiEquivalent', el => el.innerText).catch(() => null);
    if (!aqiText) {
      await sendDomChangeAlert('xappp.aqmd.gov/aqdetail (no #aqiEquivalent)');
      return null;
    }
    result = { station: station.city, aqi: aqiText };
  } catch (err) {
    console.error('[getAqmdAqi] error', err);
  } finally {
    await browser.close();
  }
  return result;
}

////////////////////////////////////////////////////////////////////////
// 4) South Coast AQMD ArcGIS
//    https://experience.arcgis.com/experience/6a6a058a177440fdac6be881d41d4c2c/
//    We try to "search" user's address or lat/lon
////////////////////////////////////////////////////////////////////////
export async function getArcgisData(lat, lon) {
  const browser = await puppeteer.launch({ headless: 'new' });
  let data = null;
  try {
    const page = await browser.newPage();
    await page.goto('https://experience.arcgis.com/experience/6a6a058a177440fdac6be881d41d4c2c/', {
      waitUntil: 'domcontentloaded'
    });

    // Check structure
    const mainMap = await page.$('div.esri-view-root');
    if (!mainMap) {
      await sendDomChangeAlert('experience.arcgis.com/experience/6a6a058a177440fdac6be881d41d4c2c/');
      return null;
    }

    // Possibly there's a search bar or we do location-based approach. 
    // We'll do naive approach: we can't easily type lat/lon if no direct search box.
    // Could parse network calls or wait for text. This is a placeholder:
    data = { arcgisNote: 'Map found, but further logic not implemented' };
  } catch (err) {
    console.error('[getArcgisData] error', err);
  } finally {
    await browser.close();
  }
  return data;
}

////////////////////////////////////////////////////////////////////////
// DOM CHANGE ALERT
////////////////////////////////////////////////////////////////////////
async function sendDomChangeAlert(siteUrl) {
  console.log('[ALERT] DOM structure changed or missing selector for', siteUrl);
  try {
    await transporter.sendMail({
      from: `"DOM Alert" <${process.env.SMTP_USER}>`,
      to: ALERT_EMAIL,
      subject: `URGENT: DOM changed for ${siteUrl}`,
      text: `We could not locate expected elements on ${siteUrl}. The site structure may have changed.`
    });
  } catch (err) {
    console.error('[sendDomChangeAlert] error', err);
  }
}
