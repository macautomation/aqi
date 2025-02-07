# Use the official Node.js 20 Bookworm-based slim image
FROM node:20-bookworm-slim

# Update and install OS dependencies required by Playwright.
# Note: Package names for GStreamer libraries are specified without a hyphen between "gstgl" (or "gstcodecparsers") and "1.0".
RUN apt-get update && apt-get install -y \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    libgstgl1.0-0 \
    libgstcodecparsers1.0-0 \
    libavif7 \
    libenchant-2-2 \
    libsecret-1-0 \
    libgles2-mesa \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package files first for Docker layer caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Run Playwright's install command to download browser binaries locally
RUN npx playwright install

# Copy the rest of your application code
COPY . .

# Expose the port your app listens on (adjust if needed)
EXPOSE 10000

# Start your application
CMD ["npm", "run", "start"]
