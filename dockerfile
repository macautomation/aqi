# Use the official Node.js 20 Bookworm-based slim image
FROM node:20-bookworm-slim

# Step 1: Update package lists
RUN apt-get update

# Step 2: (Optional) Inspect available packages
RUN apt-cache search libgstgl

# Step 3: Try installing the dependencies one by one
RUN apt-get install -y libgtk-4-1
RUN apt-get install -y libgraphene-1.0-0
RUN apt-get install -y gstreamer1.0-gl
RUN apt-get install -y gstreamer1.0-plugins-base
RUN apt-get install -y libavif10
RUN apt-get install -y libenchant-2-2
RUN apt-get install -y libsecret-1-0
RUN apt-get install -y libgles2-mesa

# Cleanup
RUN rm -rf /var/lib/apt/lists/*

# (The remainder of your Dockerfile follows here)
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
RUN npx playwright install
COPY . .
EXPOSE 10000
CMD ["npm", "run", "start"]
