// utils.js
import _ from 'lodash';

export function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI/180) *
    Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Color code based on https://docs.airnowapi.org/aq101
export function colorCodeAQI(aqi) {
  if (!aqi || isNaN(aqi)) return 'Unknown';
  const val = parseInt(aqi, 10);
  if (val <= 50) return 'Good';
  if (val <= 100) return 'Moderate';
  if (val <= 150) return 'Unhealthy for Sensitive Groups';
  if (val <= 200) return 'Unhealthy';
  if (val <= 300) return 'Very Unhealthy';
  return 'Hazardous';
}
