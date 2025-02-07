// scraping.js
import { chromium } from 'playwright';

// (A) Fire AirNow
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

// (B) xappp
export async function scrapeXappp(lat, lon) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });

    // Wait for the station dropdown to appear (adjust the selector if needed)
    let stationDropdown;
    try {
      stationDropdown = await page.waitForSelector('#stationDropdown', { timeout: 10000 });
    } catch (e) {
      console.log('[scrapeXappp] stationDropdown not found within 10 seconds.');
    }
    
    if (!stationDropdown) {
      // Log the page content to help debug the missing element
      const html = await page.content();
      console.log('[scrapeXappp] Page HTML:', html);
      console.log('[scrapeXappp] no stationDropdown found');
      return null;
    }

    // Replace the following with your actual scraping logic once the dropdown is available
    return { station: 'Fake Station', aqiText: '42' };
  } catch (err) {
    console.error('[scrapeXappp] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// (C) ArcGIS
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

    // (Replace this with your real scraping logic as needed)
    return { note: 'ArcGIS loaded, lat=' + lat + ', lon=' + lon };
  } catch (err) {
    console.error('[scrapeArcgis] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
