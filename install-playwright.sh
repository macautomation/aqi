#!/usr/bin/env bash
set -e

# Install Chromium using Playwright
npx playwright install chromium

# Check if PLAYWRIGHT_BROWSERS_PATH is not set (or set to "0")
# When PLAYWRIGHT_BROWSERS_PATH=0, Playwright stores the browsers locally in node_modules/.local-browsers.
# We'll try to copy the cache only if the source directory exists.
if [[ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]]; then 
  echo "...Copying Playwright Cache from Build Cache"
  if [[ -d "$XDG_CACHE_HOME/playwright" ]]; then
    cp -R "$XDG_CACHE_HOME/playwright/" "$PLAYWRIGHT_BROWSERS_PATH"
  else
    echo "No Playwright cache found at $XDG_CACHE_HOME/playwright. Skipping cache copy."
  fi
else 
  echo "...Storing Playwright Cache in Build Cache"
  cp -R "$PLAYWRIGHT_BROWSERS_PATH" "$XDG_CACHE_HOME"
fi
