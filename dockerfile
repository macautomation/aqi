# Use the official Node.js 20 Bookworm-based slim image
FROM node:20-bookworm-slim

# Install required OS dependencies for Playwright.
# These packages are based on the missing libraries reported by Playwright.
RUN apt-get update && apt-get install -y \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    libgstgl-1.0-0 \
    libgstcodecparsers-1.0-0 \
    libavif7 \
    libenchant-2-2 \
    libsecret-1-0 \
    libgles2-mesa \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available) to leverage Docker caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Run Playwright's install command to download browser binaries locally
RUN npx playwright install

# Copy the rest of your application code
COPY . .

# Expose the port your app listens on (adjust if necessary)
EXPOSE 10000

# Start your application
CMD ["npm", "run", "start"]
