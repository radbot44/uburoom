FROM node:22-bookworm-slim

# Install ffmpeg and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code, shared libraries, static web assets, diagnostics, demo media, and public reference files
COPY --chown=node:node server/ ./server/
COPY --chown=node:node shared/ ./shared/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node diagnostics/ ./diagnostics/
COPY --chown=node:node assets/demo/ ./assets/demo/
COPY --chown=node:node scripts/doctor.js ./scripts/doctor.js
COPY --chown=node:node config.example.yaml LICENSE ./

ENV XDG_DATA_HOME=/var/lib/uburoom
RUN mkdir -p /var/lib/uburoom /app/data && \
    chown -R node:node /var/lib/uburoom /app/data && \
    chmod 700 /var/lib/uburoom

USER node

EXPOSE 5756

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const https = require('node:https'); let port = 5756; try { port = require('./server/config').loadConfig().port; } catch {} const req = https.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', rejectUnauthorized: false }, res => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1)); req.end();"

CMD ["node", "server/index.js"]
