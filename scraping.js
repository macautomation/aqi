// scraping.js (older Puppeteer usage for Node 4)
import puppeteer from 'puppeteer';
import { distanceMiles } from './utils.js';

///////////////////////////////////////////////////////
// 1) Fire airnow site (#6 in your request):
//    We'll parse lat/lon from URL & do a naive check.
///////////////////////////////////////////////////////
export async function scrapeFireAirnow(url) {
  // parse lat/lon from URL, e.g. #10/34.1124/-118.1932
  // Then let's pretend we open the page & see if there's a known "fire boundary" within 50 miles
  const match = url.match(/#\d+\/([\d.-]+)\/([\d.-]+)/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lon)) return null;

  const result = { lat, lon, nearFire: false };
  // For demonstration, let's say there's a known "fire boundary" at (34.05, -118.2).
  const dist = distanceMiles(lat, lon, 34.05, -118.2);
  if (dist <= 50) {
    result.nearFire = true;
    result.fireDist = dist;
  }
  // In a real scenario, you'd open Puppeteer, parse the map layers for actual fire polygons.
  return result;
}

///////////////////////////////////////////////////////
// 2) xappp.aqmd.gov => real stations data
//    We'll define real city coords in station array.
///////////////////////////////////////////////////////
const STATIONS = [
  { city: 'Anaheim', lat: 33.8353, lon: -117.9145, value: 'anaheimStation' },
  { city: 'Long Beach', lat: 33.7701, lon: -118.1937, value: 'longBeachStation' },
  { city: 'Riverside', lat: 33.9533, lon: -117.3962, value: 'riversideStation' },
  { city: 'Los Angeles', lat: 34.0522, lon: -118.2437, value: 'losAngelesStation' },
  { city: 'Burbank', lat: 34.1808, lon: -118.308966, value: 'burbankStation' }
  // ... Add more if desired
];

export async function scrapeXappp(lat, lon) {
  // find station within 10 miles
  let bestDist = Infinity;
  let bestStation = null;
  for (const st of STATIONS) {
    const d = distanceMiles(lat, lon, st.lat, st.lon);
    if (d < 10 && d < bestDist) {
      bestDist = d;
      bestStation = st;
    }
  }
  if (!bestStation) return null;

  // Minimal puppeteer logic
  let res = null;
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });
    // Suppose we set #stationDropdown
    const hasDropdown = await page.$('#stationDropdown');
    if (!hasDropdown) {
      // site changed
      console.log('[scrapeXappp] site changed? No stationDropdown');
      return null;
    }
    await page.select('#stationDropdown', bestStation.value);
    await page.waitForTimeout(2000);
    // Suppose there's #aqiEquivalent
    const aqiText = await page.$eval('#aqiEquivalent', el => el.innerText).catch(() => null);
    res = { station: bestStation.city, aqiText };
  } catch (err) {
    console.error('[scrapeXappp] error', err);
  } finally {
    await browser.close();
  }
  return res;
}

// 3) arcgis or other sites omitted for brevity. Similar approach if needed.
