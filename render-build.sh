#!/usr/bin/env bash
set -o errexit  # Exit on error

export PUPPETEER_DOWNLOAD_PATH=/opt/render/.cache/puppeteer

npm install

# Ensure Puppeteer cache directory exists before copying
if [[ -d "$PUPPETEER_CACHE_DIR" && "$(ls -A "$PUPPETEER_CACHE_DIR")" ]]; then
  echo "...Copying Puppeteer Cache from Build Cache"
  cp -R "$PUPPETEER_CACHE_DIR"/* "$XDG_CACHE_HOME/puppeteer/"
else
  echo "...Puppeteer Cache Not Found. Forcing Chromium Download..."
  mkdir -p "$PUPPETEER_CACHE_DIR"
  
  # Force Puppeteer to download Chromium
  PUPPETEER_SKIP_DOWNLOAD=false npm install puppeteer-core chrome-aws-lambda --force
  
  # Verify if Chromium was actually installed
  if [[ -d "$PUPPETEER_DOWNLOAD_PATH" && "$(ls -A "$PUPPETEER_DOWNLOAD_PATH")" ]]; then
    echo "...Storing Puppeteer Cache in Build Cache"
    cp -R "$PUPPETEER_DOWNLOAD_PATH"/* "$PUPPETEER_CACHE_DIR/"
  else
    echo "❌ Chromium installation failed!"
    exit 1
  fi
fi
