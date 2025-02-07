# Use the official Node.js 20 Bookworm-based slim image
FROM node:20-bookworm-slim

# Install required OS dependencies for Playwright.
# This includes both our initial set and the additional dependencies recommended by Playwright.
RUN apt-get update && apt-get install -y \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    gstreamer1.0-gl \
    gstreamer1.0-plugins-base \
    libavif-dev \
    libenchant-2-2 \
    libsecret-1-0 \
    libgles2-mesa \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libxcomposite1 \
    libasound2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package files for caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Run Playwright's install command (downloads browser binaries locally)
RUN npx playwright install

# Copy the rest of your application code
COPY . .

# Expose the port your app listens on (adjust if necessary)
EXPOSE 10000

# Start your application
CMD ["npm", "run", "start"]
