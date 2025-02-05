#!/usr/bin/env node

import axios from 'axios';
import { GoogleSpreadsheet } from 'google-spreadsheet';

// Pull secrets from environment variables
const LAT = 34.1175895;
const LON = -118.188329;

// We'll read your keys from environment variables
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const AIRNOW_API_KEY = process.env.AIRNOW_API_KEY;
const PURPLEAIR_API_KEY = process.env.PURPLEAIR_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;  // Must be the multiline key
const HOURLY_LOGS_SHEET_TITLE = 'HourlyLogs'; // or your sheet tab name

function cardinalDirection(deg) {
  if (deg == null || isNaN(deg)) return 'Unknown';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx];
}

async function getAirNowAqi() {
  try {
    const nowUtc = new Date().toISOString();
    const hourStr = nowUtc.slice(0, 13);
    const url = 'https://www.airnowapi.org/aq/data/';
    const resp = await axios.get(url, {
      params: {
        startDate: hourStr,
        endDate: hourStr,
        parameters: 'pm25',
        BBOX: `${LON},${LAT},${LON},${LAT}`,
        dataType: 'A',
        format: 'application/json',
        verbose: 0,
        API_KEY: AIRNOW_API_KEY
      }
    });
    if (Array.isArray(resp.data) && resp.data.length > 0) {
      return resp.data[0].AQI || 'N/A';
    }
    return 'N/A';
  } catch (err) {
    console.error('[AirNow] Error:', err.message);
    return 'Err';
  }
}

async function getPurpleAirAqi() {
  try {
    const url = 'https://api.purpleair.com/v1/sensors';
    const resp = await axios.get(url, {
      headers: { 'X-API-Key': PURPLEAIR_API_KEY },
      params: {
        fields: 'pm2.5,latitude,longitude',
        location_type: '0',
        nwlng: LON - 0.05,
        nwlat: LAT + 0.05,
        selng: LON + 0.05,
        selat: LAT - 0.05
      }
    });
    const data = resp.data;
    if (data?.data?.length) {
      let bestDist = Infinity;
      let bestVal = 'N/A';
      for (const sensor of data.data) {
        const sensorLat = sensor[2];
        const sensorLon = sensor[3];
        const dist = Math.sqrt((sensorLat - LAT)**2 + (sensorLon - LON)**2);
        if (dist < bestDist) {
          bestDist = dist;
          bestVal = sensor[1];
        }
      }
      return bestVal;
    }
    return 'N/A';
  } catch (err) {
    console.error('[PurpleAir] Error:', err.message);
    return 'Err';
  }
}

async function getWindData() {
  try {
    const resp = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
      params: {
        lat: LAT,
        lon: LON,
        appid: OPENWEATHER_API_KEY
      }
    });
    const deg = resp.data?.wind?.deg;
    const speed = resp.data?.wind?.speed;
    return {
      deg,
      speed,
      dir: cardinalDirection(deg)
    };
  } catch (err) {
    console.error('[OpenWeatherMap] Error:', err.message);
    return { deg: null, speed: null, dir: 'Unknown' };
  }
}

async function logDataToSheets(airnowAqi, purpleAirAqi, wind) {
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: SERVICE_ACCOUNT_EMAIL,
    private_key: SERVICE_ACCOUNT_PRIVATE_KEY
  });
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[HOURLY_LOGS_SHEET_TITLE];
  if (!sheet) throw new Error(`Sheet "${HOURLY_LOGS_SHEET_TITLE}" not found!`);

  await sheet.addRow({
    timestamp: new Date().toISOString(),
    airnowAqi,
    purpleAirAqi,
    windDeg: wind.deg,
    windCardinal: wind.dir,
    windSpeed: wind.speed
  });
}

async function main() {
  console.log('[Hourly] Starting...');
  const [aqiAirNow, aqiPurple] = await Promise.all([
    getAirNowAqi(),
    getPurpleAirAqi()
  ]);
  const wind = await getWindData();

  console.log(`[Hourly] AirNow: ${aqiAirNow}, PurpleAir: ${aqiPurple}, Wind: ${wind.dir} ${wind.deg}° speed=${wind.speed}`);
  await logDataToSheets(aqiAirNow, aqiPurple, wind);
  console.log('[Hourly] Logged to Google Sheets successfully.');
}

main().catch(err => {
  console.error('[Hourly script error]', err);
  process.exit(1);
});
