// scraping.js
import { chromium } from 'playwright';

/**
 * Helper: Calculate the Haversine distance (in miles) between two latitude/longitude pairs.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = angle => angle * (Math.PI / 180);
  const R = 3958.8; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Helper: Generic AQI calculation function based on EPA breakpoints.
 * Uses linear interpolation between breakpoints.
 */
function calculateAQI(conc, bp) {
  for (const range of bp) {
    if (conc >= range.concLow && conc <= range.concHigh) {
      const aqi = ((range.aqiHigh - range.aqiLow) / (range.concHigh - range.concLow)) *
                  (conc - range.concLow) + range.aqiLow;
      return Math.round(aqi);
    }
  }
  return null;
}

/**
 * Breakpoints for pollutant AQI calculations.
 * (These are sample breakpoints; adjust as needed.)
 */
const breakpoints = {
  "PM2.5": [
    { concLow: 0.0, concHigh: 12.0, aqiLow: 0, aqiHigh: 50 },
    { concLow: 12.1, concHigh: 35.4, aqiLow: 51, aqiHigh: 100 },
    { concLow: 35.5, concHigh: 55.4, aqiLow: 101, aqiHigh: 150 },
    { concLow: 55.5, concHigh: 150.4, aqiLow: 151, aqiHigh: 200 },
    { concLow: 150.5, concHigh: 250.4, aqiLow: 201, aqiHigh: 300 },
    { concLow: 250.5, concHigh: 500.4, aqiLow: 301, aqiHigh: 500 }
  ],
  "PM10": [
    { concLow: 0, concHigh: 54, aqiLow: 0, aqiHigh: 50 },
    { concLow: 55, concHigh: 154, aqiLow: 51, aqiHigh: 100 },
    { concLow: 155, concHigh: 254, aqiLow: 101, aqiHigh: 150 },
    { concLow: 255, concHigh: 354, aqiLow: 151, aqiHigh: 200 },
    { concLow: 355, concHigh: 424, aqiLow: 201, aqiHigh: 300 },
    { concLow: 425, concHigh: 604, aqiLow: 301, aqiHigh: 500 }
  ],
  "O3": [
    { concLow: 0.000, concHigh: 0.054, aqiLow: 0, aqiHigh: 50 },
    { concLow: 0.055, concHigh: 0.070, aqiLow: 51, aqiHigh: 100 },
    { concLow: 0.071, concHigh: 0.085, aqiLow: 101, aqiHigh: 150 },
    { concLow: 0.086, concHigh: 0.105, aqiLow: 151, aqiHigh: 200 },
    { concLow: 0.106, concHigh: 0.200, aqiLow: 201, aqiHigh: 300 }
  ],
  "NO2": [
    { concLow: 0, concHigh: 53, aqiLow: 0, aqiHigh: 50 },
    { concLow: 54, concHigh: 100, aqiLow: 51, aqiHigh: 100 },
    { concLow: 101, concHigh: 360, aqiLow: 101, aqiHigh: 150 },
    { concLow: 361, concHigh: 649, aqiLow: 151, aqiHigh: 200 },
    { concLow: 650, concHigh: 1249, aqiLow: 201, aqiHigh: 300 },
    { concLow: 1250, concHigh: 1649, aqiLow: 301, aqiHigh: 400 },
    { concLow: 1650, concHigh: 2049, aqiLow: 401, aqiHigh: 500 }
  ],
  "SO2": [
    { concLow: 0, concHigh: 35, aqiLow: 0, aqiHigh: 50 },
    { concLow: 36, concHigh: 75, aqiLow: 51, aqiHigh: 100 },
    { concLow: 76, concHigh: 185, aqiLow: 101, aqiHigh: 150 },
    { concLow: 186, concHigh: 304, aqiLow: 151, aqiHigh: 200 },
    { concLow: 305, concHigh: 604, aqiLow: 201, aqiHigh: 300 },
    { concLow: 605, concHigh: 1004, aqiLow: 301, aqiHigh: 500 }
  ],
  "CO": [
    { concLow: 0.0, concHigh: 4.4, aqiLow: 0, aqiHigh: 50 },
    { concLow: 4.5, concHigh: 9.4, aqiLow: 51, aqiHigh: 100 },
    { concLow: 9.5, concHigh: 12.4, aqiLow: 101, aqiHigh: 150 },
    { concLow: 12.5, concHigh: 15.4, aqiLow: 151, aqiHigh: 200 },
    { concLow: 15.5, concHigh: 30.4, aqiLow: 201, aqiHigh: 300 },
    { concLow: 30.5, concHigh: 40.4, aqiLow: 301, aqiHigh: 400 },
    { concLow: 40.5, concHigh: 50.4, aqiLow: 401, aqiHigh: 500 }
  ]
};

/**
 * (A) scrapeFireAirnow
 * Launches a browser to scrape Fire AirNow data from a given URL.
 */
export async function scrapeFireAirnow(url) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const match = url.match(/#\d+\/([\d.-]+)\/([\d.-]+)/);
    if (!match) return { nearFire: false };
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const dist = Math.sqrt((lat - 34.05) ** 2 + (lon + 118.2) ** 2);
    const nearFire = dist < 0.7;
    return { nearFire };
  } catch (err) {
    console.error('[scrapeFireAirnow] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * (B) scrapeXappp
 * Navigates to the AQMD station page, extracts a list of cities from a dropdown,
 * calculates the distance from the user's location to each city's center, and:
 * - If the closest city is within 20 miles, simulates retrieving pollutant data,
 *   calculates the AQI for each pollutant using breakpoints, and returns the station data as a table.
 * - Otherwise, returns a fixed message indicating no station is available.
 */
export async function scrapeXappp(userLat, userLon) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });

    // Wait for the dropdown element with id "SelectList"
    let dropdown;
    try {
      dropdown = await page.waitForSelector('#SelectList', { timeout: 10000 });
    } catch (e) {
      console.log('[scrapeXappp] Station dropdown not found within 10 seconds.');
    }
    if (!dropdown) {
      const html = await page.content();
      console.log('[scrapeXappp] Page HTML:', html);
      console.log('[scrapeXappp] No station dropdown found');
      return null;
    }

    // Extract the list of city names from the dropdown, excluding the default placeholder.
    const cityOptions = await page.$$eval('#SelectList option', options =>
      options.map(o => o.textContent.trim()).filter(text => text && text !== '-- Select a Station --')
    );
    console.log('[scrapeXappp] Found city options:', cityOptions);

    // Mapping of city names to approximate center coordinates.
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

    // Determine the closest city from the user's location.
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

    // If the closest city is within 20 miles, then retrieve pollutant data.
    if (closestCity && minDistance <= 20) {
      // For demonstration, we simulate pollutant readings.
      // In a production system, replace this with actual scraped data.
      const pollutantData = [
        { parameter: "PM2.5", reading: 10.5, description: "Fine Particulate Matter (µg/m³)" },
        { parameter: "PM10", reading: 40, description: "Coarse Particulate Matter (µg/m³)" },
        { parameter: "O3", reading: 0.040, description: "Ozone (ppm)" },
        { parameter: "NO2", reading: 0.020, description: "Nitrogen Dioxide (ppm)" },
        { parameter: "SO2", reading: 0.005, description: "Sulfur Dioxide (ppm)" },
        { parameter: "CO", reading: 0.4, description: "Carbon Monoxide (ppm)" }
        // You can add more parameters here (e.g., WD for wind direction) if needed.
      ];

      // For each pollutant, compute the AQI using the embedded breakpoint logic.
      const tableData = pollutantData.map(item => {
        const bp = breakpoints[item.parameter];
        const aqi = bp ? calculateAQI(item.reading, bp) : null;
        return {
          Parameter: item.parameter,
          "Current Reading": item.reading,
          "Parameter Description": item.description,
          AQI: aqi
        };
      });

      return { station: closestCity, stationData: tableData };
    } else {
      // If no city is within 20 miles, return a fixed message.
      return { station: "South Coast AQMD: No station within 20 miles of this location.", stationData: null };
    }
  } catch (err) {
    console.error('[scrapeXappp] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * (C) scrapeArcgis
 * Loads the ArcGIS page and returns a note with the provided coordinates.
 */
export async function scrapeArcgis(lat, lon) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://experience.arcgis.com/experience/6a6a058a177440fdac6be881d41d4c2c/', {
      waitUntil: 'domcontentloaded'
    });
    return { note: 'ArcGIS loaded, lat=' + lat + ', lon=' + lon };
  } catch (err) {
    console.error('[scrapeArcgis] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
