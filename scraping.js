// scraping.js
import puppeteer from 'puppeteer';

// (A) Fire AirNow
export async function scrapeFireAirnow(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 800 },
      userDataDir: "/tmp/chrome-user-data",
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const match = url.match(/#\d+\/([\d.-]+)\/([\d.-]+)/);
    if (!match) return { nearFire: false };
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const dist = Math.sqrt((lat - 34.05)**2 + (lon + 118.2)**2);
    const nearFire = dist < 0.7; 

    return { nearFire };
  } catch (err) {
    console.error('[scrapeFireAirnow] Puppeteer error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// (B) xappp
export async function scrapeXappp(lat, lon) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 800 },
      userDataDir: "/tmp/chrome-user-data",
    });

    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });

    const stationDropdown = await page.$('#stationDropdown');
    if (!stationDropdown) {
      console.log('[scrapeXappp] no stationDropdown found');
      return null;
    }

    // (Replace this with real scraping logic as needed)
    return { station: 'Fake Station', aqiText: '42' };
  } catch (err) {
    console.error('[scrapeXappp] Puppeteer error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// (C) ArcGIS
export async function scrapeArcgis(lat, lon) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 800 },
      userDataDir: "/tmp/chrome-user-data",
    });

    const page = await browser.newPage();
    await page.goto('https://experience.arcgis.com/experience/6a6a058a177440fdac6be881d41d4c2c/', {
      waitUntil: 'domcontentloaded'
    });

    // (Replace this with real scraping logic as needed)
    return { note: 'ArcGIS loaded, lat=' + lat + ', lon=' + lon };
  } catch (err) {
    console.error('[scrapeArcgis] Puppeteer error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
