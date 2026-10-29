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
COPY scripts/doctor.js ./scripts/doctor.js
COPY config.example.yaml LICENSE ./

ENV XDG_DATA_HOME=/var/lib/uburoom
RUN mkdir -p /var/lib/uburoom && chmod 700 /var/lib/uburoom

EXPOSE 5756

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const https = require('node:https'); const req = https.request({ host: '127.0.0.1', port: process.env.PORT || 5756, path: '/health', method: 'GET', rejectUnauthorized: false }, res => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1)); req.end();"

CMD ["node", "server/index.js"]
