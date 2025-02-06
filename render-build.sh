#!/usr/bin/env bash
set -o errexit  # Exit on error

npm install

# Store/pull Puppeteer cache with build cache
if [[ -d $PUPPETEER_CACHE_DIR ]]; then
  echo "...Copying Puppeteer Cache from Build Cache"
  cp -R $PUPPETEER_CACHE_DIR/* $XDG_CACHE_HOME/puppeteer/
else
  echo "...Storing Puppeteer Cache in Build Cache"
  mkdir -p $PUPPETEER_CACHE_DIR
  cp -R $XDG_CACHE_HOME/puppeteer/* $PUPPETEER_CACHE_DIR/
fi
