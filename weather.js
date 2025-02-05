// weather.js
import axios from 'axios';
import { colorCodeAQI } from './utils.js';

/**
 * fetchOpenWeather(lat, lon)
 * returns { windSpeed, windDeg, weatherDesc }
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
    if (resp.data && resp.data.wind) {
      return {
        windSpeed: resp.data.wind.speed || 0,
        windDeg: resp.data.wind.deg || 0,
        weatherDesc: resp.data.weather && resp.data.weather.length ? resp.data.weather[0].description : 'unknown'
      };
    }
  } catch (err) {
    console.error('[fetchOpenWeather]', err.message);
  }
  return { windSpeed: 0, windDeg: 0, weatherDesc: 'N/A' };
}

/**
 * fetchAirNowAQI(lat, lon)
 * returns an integer AQI or null
 * Using https://docs.airnowapi.org/ for example
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
      // find PM2.5 or overall AQI
      const pm25 = resp.data.find(d => d.ParameterName === 'PM2.5');
      if (pm25) {
        return pm25.AQI;
      }
      // fallback
      return resp.data[0].AQI;
    }
  } catch (err) {
    console.error('[fetchAirNowAQI]', err.message);
  }
  return null;
}

/**
 * Return color-coded label from colorCodeAQI
 */
export function labelAirNowAQI(aqi) {
  if (!aqi) return 'Unknown';
  return colorCodeAQI(aqi);
}
