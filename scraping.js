// scraping.js
import { chromium } from 'playwright';

// Helper: Calculate Haversine distance (in miles) between two lat/lon points.
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (angle) => angle * (Math.PI / 180);
  const R = 3958.8; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Mapping of city names (as in the dropdown) to their approximate center coordinates.
// NOTE: Update these coordinates as needed for accurate distances.
const cityCenters = {
  "Anaheim": { lat: 33.8353, lon: -117.9145 },
  "Azusa": { lat: 34.1336, lon: -117.9073 },
  "Banning": { lat: 33.9195, lon: -116.8760 },
  "Central Los Angeles": { lat: 34.0522, lon: -118.2437 },
  "Central San Bernardino Mountains": { lat: 34.1, lon: -117.3 },
  "Compton": { lat: 33.8958, lon: -118.2201 },
  "Fontana": { lat: 34.0922, lon: -117.4350 },
  "Glendora": { lat: 34.1367, lon: -117.8653 },
  "Indio Amistad High School": { lat: 33.7206, lon: -116.2159 },
  "La Habra": { lat: 33.9319, lon: -117.9464 },
  "Lake Elsinore": { lat: 33.6685, lon: -117.3278 },
  "LAX Hastings": { lat: 33.9425, lon: -118.4081 },
  "Mecca": { lat: 33.737, lon: -116.293 },
  "Mira Loma": { lat: 33.722, lon: -117.680 },
  "Mission Viejo": { lat: 33.600, lon: -117.671 },
  "North Hollywood": { lat: 34.1870, lon: -118.3818 },
  "Palm Springs": { lat: 33.8303, lon: -116.5453 },
  "Pasadena": { lat: 34.1478, lon: -118.1445 },
  "Pico Rivera": { lat: 33.9836, lon: -118.0961 },
  "Pomona": { lat: 34.0551, lon: -117.7500 },
  "Redlands": { lat: 34.056, lon: -117.195 },
  "Reseda": { lat: 34.2011, lon: -118.5353 },
  "Rubidoux Riverside": { lat: 33.941, lon: -117.396 },
  "San Bernardino": { lat: 34.1083, lon: -117.2898 },
  "Santa Clarita": { lat: 34.3917, lon: -118.5426 },
  "Signal Hill": { lat: 33.8035, lon: -118.1630 },
  "Temecula": { lat: 33.4936, lon: -117.1484 },
  "West Los Angeles": { lat: 34.032, lon: -118.451 }
};

//
// (B) xappp - Updated to calculate the closest city (station) based on user location.
//
export async function scrapeXappp(userLat, userLon) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });

    // Wait for the dropdown using the correct selector (#SelectList)
    let dropdown;
    try {
      dropdown = await page.waitForSelector('#SelectList', { timeout: 10000 });
    } catch (e) {
      console.log('[scrapeXappp] Station dropdown not found within 10 seconds.');
    }
    if (!dropdown) {
      const html = await page.content();
      console.log('[scrapeXappp] Page HTML:', html);
      console.log('[scrapeXappp] no station dropdown found');
      return null;
    }

    // Extract the list of city names from the dropdown, excluding the default placeholder.
    const cityOptions = await page.$$eval('#SelectList option', options =>
      options
        .map(o => o.textContent.trim())
        .filter(text => text && text !== '-- Select a Station --')
    );
    console.log('[scrapeXappp] Found city options:', cityOptions);

    // Calculate distance from user's location to each city's center
    let closestCity = null;
    let minDistance = Infinity;
    for (const city of cityOptions) {
      const coords = cityCenters[city];
      if (coords) {
        const distance = haversineDistance(userLat, userLon, coords.lat, coords.lon);
        if (distance < minDistance) {
          minDistance = distance;
          closestCity = city;
        }
      } else {
        console.log(`[scrapeXappp] No coordinates found for city: ${city}`);
      }
    }

    console.log('[scrapeXappp] Closest city:', closestCity, 'Distance:', minDistance, 'miles');

    // If the closest city is within 20 miles, return it; otherwise, return no station.
    if (closestCity && minDistance <= 20) {
      // Replace the dummy AQI value "42" with actual scraping logic if available.
      return { station: closestCity, aqiText: '42' };
    } else {
      return { station: null, aqiText: null };
    }
  } catch (err) {
    console.error('[scrapeXappp] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
