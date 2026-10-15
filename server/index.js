'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('./app');
const { startBot } = require('./discord');
const root = path.resolve(__dirname, '..');
async function main() {
  const publicUrl = new URL(process.env.PUBLIC_URL || 'https://localhost:6767');
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin');
  const config = {
    publicUrl: publicUrl.origin,
    cert: fs.readFileSync(path.resolve(root, process.env.TLS_CERT || 'certs/server-cert.pem')),
    key: fs.readFileSync(path.resolve(root, process.env.TLS_KEY || 'certs/server-key.pem')),
    deviceFile: path.join(root, 'data/devices.json'),
    loginFile: path.join(root, 'data/logins.json'),
    accountFile: path.join(root,'data/accounts.sqlite'),
    credentialKeyFile: process.env.UBUROOM_CREDENTIAL_KEY_FILE || path.join(process.env.LOCALAPPDATA||process.env.HOME||require('node:os').homedir(),'uburoom','credentials.key'),
    plexMachineIdentifier: process.env.PLEX_MACHINE_IDENTIFIER,
    botToken: process.env.DISCORD_BOT_TOKEN,
    plexUrl: process.env.PLEX_URL,
    plexToken: process.env.PLEX_TOKEN,
    ffmpegPath: process.env.FFMPEG_PATH,
    ffprobePath: process.env.FFPROBE_PATH,
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    ownerId: process.env.DISCORD_OWNER_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    channels: (process.env.DISCORD_COMMAND_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  };
  for (const value of [config.ownerId, config.guildId, config.clientId, ...config.channels].filter(Boolean)) if (!/^\d{17,20}$/.test(value)) throw new Error('Discord IDs must be numeric IDs copied with Developer Mode');
  const port = Number(process.env.PORT || 6767);
  const keyRelative=path.relative(root,path.resolve(config.credentialKeyFile));
  if(!keyRelative.startsWith('..'+path.sep)&&!path.isAbsolute(keyRelative))throw new Error('UBUROOM_CREDENTIAL_KEY_FILE must be outside the shared project folder');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const app = createApp(config);
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, process.env.HOST || '127.0.0.1', resolve); });
  console.log(`[uburoom] Setup / connected devices: ${config.publicUrl}`);
  console.log(`[uburoom] Private credential key: ${path.resolve(config.credentialKeyFile)} (preserve and back up separately)`);
  console.log('[uburoom] Remote off by default. On disconnect, re-enable in Firefox or the host website. Ctrl+C stops the server.');
  let bot;
  async function stop() { await bot?.destroy(); await app.close(); process.exit(0); }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { bot = await startBot(config, app.hub); } catch (e) { await app.close(); throw e; }
}
main().catch(error => {
  const missing = error.code === 'ENOENT';
  console.error(missing ? '[uburoom] Missing TLS files. Follow README.md to generate a local development certificate.' : '[uburoom] ' + error.message);
  process.exitCode = 1;
});
