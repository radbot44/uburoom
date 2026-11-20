FROM node:22-bookworm-slim

ARG GPU_DRIVERS=none

# Install ffmpeg, ca-certificates, and optional GPU drivers (none | vulkan | all)
RUN set -eu; \
    extra_pkgs=""; \
    case "$GPU_DRIVERS" in \
        none) ;; \
        vulkan) extra_pkgs="mesa-vulkan-drivers" ;; \
        all) \
            extra_pkgs="mesa-vulkan-drivers mesa-va-drivers"; \
            if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
                extra_pkgs="$extra_pkgs intel-media-va-driver"; \
            fi \
            ;; \
        *) echo "Unsupported GPU_DRIVERS='$GPU_DRIVERS' (expected none, vulkan, or all)" >&2; exit 1 ;; \
    esac; \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        $extra_pkgs && \
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
# /config holds config.yaml, certs/ and data/. Mount it as a writable folder:
# Server settings saves write a new config.yaml beside the old one and swap it in.
RUN mkdir -p /var/lib/uburoom /config && \
    chown -R node:node /var/lib/uburoom /config && \
    chmod 700 /var/lib/uburoom /config

USER node

EXPOSE 5756

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const https = require('node:https'); let port = 5756; try { port = require('./server/config').loadConfig('/config/config.yaml', []).port; } catch {} const req = https.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', rejectUnauthorized: false }, res => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1)); req.end();"

CMD ["node", "server/index.js", "--config", "/config/config.yaml"]
