// scraping.js
import puppeteer from 'puppeteer';

// (A) Fire AirNow
export async function scrapeFireAirnow(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-web-security'
      ]
      // Some platforms need extra flags:
      // args: ['--no-sandbox','--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // minimal example
    // we pretend there's a known fire near (34.05, -118.2) within 50 miles
    // so parse lat/lon from #?? or do actual DOM parse
    const match = url.match(/#\d+\/([\d.-]+)\/([\d.-]+)/);
    if (!match) return { nearFire: false };
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const dist = Math.sqrt((lat - 34.05)**2 + (lon + 118.2)**2);
    const nearFire = dist < 0.7; 
    // a fake check, just for demonstration
    return { nearFire };
  } catch (err) {
    console.error('[scrapeFireAirnow] Puppeteer error:', err);
    return null; // or { nearFire:false }
  } finally {
    if (browser) await browser.close();
  }
}

// (B) xappp
export async function scrapeXappp(lat, lon) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-web-security'
      ]
    });
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil:'domcontentloaded' });
    // minimal check
    const stationDropdown = await page.$('#stationDropdown');
    if (!stationDropdown) {
      console.log('[scrapeXappp] no stationDropdown found');
      return null;
    }
    // pick a station, wait, parse text
    // skipping real logic
    return { station:'Fake Station', aqiText:'42' };
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
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-web-security'
      ] 
    });
    const page = await browser.newPage();
    await page.goto('https://experience.arcgis.com/experience/6a6a058a177440fdac6be881d41d4c2c/', {
      waitUntil:'domcontentloaded'
    });
    // minimal example
    return { note:'ArcGIS loaded, lat='+lat+', lon='+lon };
  } catch(err) {
    console.error('[scrapeArcgis] Puppeteer error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
