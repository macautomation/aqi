# Use the official Node.js 20 Bookworm-based slim image
FROM node:20-bookworm-slim

# Install required OS dependencies for Playwright.
# We use the following packages:
#   - libgtk-4-1 and libgraphene-1.0-0 for UI support
#   - gstreamer1.0-gl and gstreamer1.0-plugins-base for GStreamer functionality
#   - libavif10 (replacing libavif7) for AVIF image support
#   - libenchant-2-2, libsecret-1-0, and libgles2-mesa as additional dependencies
RUN apt-get update && apt-get install -y \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    gstreamer1.0-gl \
    gstreamer1.0-plugins-base \
    libavif10 \
    libenchant-2-2 \
    libsecret-1-0 \
    libgles2-mesa \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available) for dependency caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Run Playwright's install command (this downloads browser binaries into node_modules/.local-browsers)
RUN npx playwright install

# Copy the rest of your application code
COPY . .

# Expose the port your app listens on (adjust if necessary)
EXPOSE 10000

# Start the application
CMD ["npm", "run", "start"]
