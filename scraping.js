// scraping.js
import puppeteer from 'puppeteer';

export async function scrapeFireAirnow(url) {
  let browser;
  try {
    // Launch with 'puppeteer' in a normal container
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // ... rest of logic ...
    return { nearFire: true };  // example
  } catch (err) {
    console.error('[scrapeFireAirnow] Puppeteer error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

export async function scrapeXappp(lat, lon) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });
    // ...
    return { station: 'Fake Station', aqiText: '42' };
  } catch (err) {
    console.error('[scrapeXappp] Puppeteer error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

export async function scrapeArcgis(lat, lon) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://experience.arcgis.com/...', { waitUntil: 'domcontentloaded' });
    // ...
    return { note: `ArcGIS loaded, lat=${lat}, lon=${lon}` };
  } catch (err) {
    console.error('[scrapeArcgis] Puppeteer error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
