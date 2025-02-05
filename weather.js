// weather.js
import axios from 'axios';
import { colorCodeAQI } from './utils.js';

/**
 * fetchOpenWeather => { windSpeed, windDeg, weatherDesc }
 */
export async function fetchOpenWeather(lat, lon) {
  try {
    const url = 'https://api.openweathermap.org/data/2.5/weather';
    const resp = await axios.get(url, {
      params: {
        lat,
        lon,
        appid: process.env.OPENWEATHER_API_KEY
      }
    });
    const wind = resp.data?.wind || {};
    return {
      windSpeed: wind.speed || 0,
      windDeg: wind.deg || 0,
      weatherDesc: resp.data?.weather?.[0]?.description || 'N/A'
    };
  } catch (err) {
    console.error('[fetchOpenWeather]', err.message);
    return { windSpeed: 0, windDeg: 0, weatherDesc: 'N/A' };
  }
}

/**
 * fetchAirNowAQI => integer AQI or null
 */
export async function fetchAirNowAQI(lat, lon) {
  try {
    const url = 'https://www.airnowapi.org/aq/observation/latLong/current/';
    const resp = await axios.get(url, {
      params: {
        format: 'application/json',
        latitude: lat,
        longitude: lon,
        distance: 25,
        API_KEY: process.env.AIRNOW_API_KEY
      }
    });
    if (Array.isArray(resp.data) && resp.data.length) {
      const pm25 = resp.data.find(d => d.ParameterName === 'PM2.5');
      if (pm25) return pm25.AQI;
      return resp.data[0].AQI || null;
    }
  } catch (err) {
    console.error('[fetchAirNowAQI]', err.message);
  }
  return null;
}

export function labelAirNowAQI(aqi) {
  if (!aqi) return 'Unknown';
  return colorCodeAQI(aqi);
}

/**
 * getWindStatus: determines "Green"/"Yellow"/"Red" based on direction & speed
 * For demonstration, we do a simple check: if speed > 5 => Red
 * if speed <5 => Yellow, else Green. Real logic may require bearing checks.
 */
export function getWindStatus(speed, deg, nearFire) {
  if (!nearFire) return 'Green'; // if not near fire
  if (speed < 5) return 'Yellow';
  return 'Red';
}
