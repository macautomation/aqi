# Use the official Node.js 20 Bookworm-based slim image
FROM node:20-bookworm-slim

# Install required OS dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    libgstgl-1.0-0 \
    libgstcodecparsers-1.0-0 \
    libavif0 \
    libenchant-2-2 \
    libsecret-1-0 \
    libmanette-0.2-0 \
    libgles2-mesa \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if present) for caching
COPY package*.json ./

# Install app dependencies
RUN npm install

# Run Playwright's install command to download browser binaries locally
RUN npx playwright install

# Copy the rest of your application code
COPY . .

# Expose the port your app listens on (adjust if needed)
EXPOSE 10000

# Start your app using your start script
CMD ["npm", "run", "start"]
