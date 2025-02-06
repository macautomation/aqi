const { join } = require('path');

/** @type {import("puppeteer").Configuration} */
module.exports = {
  // Specify the directory where Puppeteer will store browser binaries.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
