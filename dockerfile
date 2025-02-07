# Use the official Node.js 20 Bookworm-based slim image
FROM node:20-bookworm-slim

# Install required OS dependencies for Playwright.
# Adjusted package names:
#   - GStreamer libraries: libgstgl-1.0-0 and libgstcodecparsers-1.0-0 (with hyphens)
#   - Use libavif0 instead of libavif7
RUN apt-get update && apt-get install -y \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    libgstgl-1.0-0 \
    libgstcodecparsers-1.0-0 \
    libavif0 \
    libenchant-2-2 \
    libsecret-1-0 \
    libgles2-mesa \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package files for dependency caching
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
