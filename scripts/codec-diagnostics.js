/* Explicit local diagnostics only; never loads .env or calls live providers. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const root = path.resolve(__dirname, '..');
const app = createApp({ publicUrl: 'https://localhost', diagnostics: true,
  cert: fs.readFileSync(path.join(root, 'certs/server-cert.pem')), key: fs.readFileSync(path.join(root, 'certs/server-key.pem')),
  ownerId: 'diagnostic-owner', guildId: 'diagnostic-guild', channels: []
}, { oauthFetch: async () => { throw new Error('Live OAuth disabled'); }, plexFetch: async () => { throw new Error('Live Plex disabled'); } });
app.server.listen(0, '127.0.0.1', () => {
  console.log('Codec diagnostics: https://localhost:' + app.server.address().port + '/__diagnostics/codec');
});
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
