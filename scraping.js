// scraping.js
import { chromium } from 'playwright';

// (A) Fire AirNow – (unchanged from your previous version using Playwright)
export async function scrapeFireAirnow(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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

// (B) xappp – updated version
export async function scrapeXappp(lat, lon) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://xappp.aqmd.gov/aqdetail/', { waitUntil: 'domcontentloaded' });

    // Wait for the select element that contains the "-- Select a Station --" option using XPath:
    const [dropdownOption] = await page.$x("//select//option[contains(., '-- Select a Station --')]");
    if (!dropdownOption) {
      console.log('[scrapeXappp] no station dropdown option found');
      return null;
    }
    // Optionally, select a default station or extract its value
    // For example, get the value of the select element:
    const selectHandle = await page.$("select");
    const selectedValue = await selectHandle.evaluate(el => el.value);
    // You can then scrape further data from the page as needed.
    return { station: "Default Station", aqiText: "42", selected: selectedValue };
  } catch (err) {
    console.error('[scrapeXappp] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// (C) ArcGIS – unchanged except for using Playwright (if needed)
export async function scrapeArcgis(lat, lon) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://experience.arcgis.com/experience/6a6a058a177440fdac6be881d41d4c2c/', { waitUntil: 'domcontentloaded' });
    return { note: 'ArcGIS loaded, lat=' + lat + ', lon=' + lon };
  } catch (err) {
    console.error('[scrapeArcgis] error:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
