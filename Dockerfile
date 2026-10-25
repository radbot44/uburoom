FROM node:22-bookworm-slim

# Install ffmpeg and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code, shared libraries, static web assets, and public reference files
COPY server/ ./server/
COPY shared/ ./shared/
COPY web/ ./web/
COPY config.example.yaml LICENSE ./

EXPOSE 5756

CMD ["node", "server/index.js"]
