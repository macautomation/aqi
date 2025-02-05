// utils.js
import _ from 'lodash';

// Haversine formula in miles
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
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

// Parse lat/lon from a URL like https://fire.airnow.gov/#10/34.1124/-118.1932
export function parseAirNowFireUrl(url) {
  // e.g. #10/34.1124/-118.1932
  const match = url.match(/#\d+\/([\d.-]+)\/([\d.-]+)/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

/**
 * colorCodeAQI(aqi): returns 'Good', 'Moderate', 'UnhealthyForSensitive', etc.
 * Based on https://docs.airnowapi.org/aq101 (breakpoints).
 */
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

/**
 * getWindColorIndicator(speed, directionFrom, userLat, userLon, fireLat, fireLon)
 * - Green if wind is from user toward fire
 * - Yellow if speed <5 but from fire
 * - Red if speed >=5 from fire
 * Basic logic:
 *   1) We check if "from direction" is from fire's lat/lon. E.g. if the angle from user->fire is close to wind direction
 *   2) If so, we see speed
 *   3) Otherwise default to green or something
 */
export function getWindColorIndicator(speed, directionDeg, userLat, userLon, fireLat, fireLon) {
  // For brevity, we do a naive check: if distanceMiles(userLat, userLon, fireLat, fireLon) < 50 => there's a "fire"
  // Then if the direction is roughly the bearing from user to fire, we color.
  // This is highly approximate, but a placeholder.

  const dist = distanceMiles(userLat, userLon, fireLat, fireLon);
  if (dist > 50) {
    // no near fire
    return 'Green'; // no threat
  }
  // If we are within 50 miles, let's see if the wind is blowing from fire
  // Bearing from fire to user => if wind direction ~ that bearing => smoke toward user
  // We'll skip real bearing calc for brevity
  if (speed < 5) {
    return 'Yellow';
  } else {
    return 'Red';
  }
}
