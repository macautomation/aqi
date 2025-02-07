# Use the official Node.js 20 slim image (Debian‑based)
FROM node:20-slim

# Install required system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    libgstgl1.0-0 \
    libgstcodecparsers1.0-0 \
    libavif0 \
    libenchant-2-2 \
    libsecret-1-0 \
    libmanette-0.2-0 \
    libgles2-mesa \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if you have one) first for better caching
COPY package*.json ./

# Install app dependencies
RUN npm install

# Run Playwright's install command (this will install the browser binaries into node_modules/.local-browsers)
RUN npx playwright install

# Copy the rest of your application code into the container
COPY . .

# Expose the port your app listens on (adjust if different)
EXPOSE 10000

# Start your app
CMD ["npm", "run", "start"]
