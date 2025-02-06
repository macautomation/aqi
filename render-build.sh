#!/usr/bin/env bash
set -o errexit  # Exit on error

npm install

# Ensure Puppeteer cache directory exists before copying
if [[ -d $PUPPETEER_CACHE_DIR && "$(ls -A $PUPPETEER_CACHE_DIR)" ]]; then
  echo "...Copying Puppeteer Cache from Build Cache"
  cp -R $PUPPETEER_CACHE_DIR/* $XDG_CACHE_HOME/puppeteer/
else
  echo "...Puppeteer Cache Not Found. Running Install..."
  mkdir -p $PUPPETEER_CACHE_DIR
  npm rebuild puppeteer-core chrome-aws-lambda
  cp -R $XDG_CACHE_HOME/puppeteer/* $PUPPETEER_CACHE_DIR/
fi
