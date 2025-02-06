#!/usr/bin/env bash
set -o errexit  # Exit on error

npm install

# Ensure Puppeteer cache directory exists before copying
if [[ -d "$PUPPETEER_CACHE_DIR" && "$(ls -A "$PUPPETEER_CACHE_DIR")" ]]; then
  echo "...Copying Puppeteer Cache from Build Cache"
  cp -R "$PUPPETEER_CACHE_DIR"/* "$XDG_CACHE_HOME/puppeteer/"
else
  echo "...Puppeteer Cache Not Found. Forcing Chromium Download..."
  mkdir -p "$PUPPETEER_CACHE_DIR"
  
  # Force Puppeteer to download Chromium
  PUPPETEER_SKIP_DOWNLOAD=false npm rebuild puppeteer-core chrome-aws-lambda
  
  # Verify that Chromium was actually installed
  if [[ -d "$XDG_CACHE_HOME/puppeteer" && "$(ls -A "$XDG_CACHE_HOME/puppeteer")" ]]; then
    echo "...Storing Puppeteer Cache in Build Cache"
    cp -R "$XDG_CACHE_HOME/puppeteer"/* "$PUPPETEER_CACHE_DIR/"
  else
    echo "❌ Chromium installation failed!"
    exit 1
  fi
fi
