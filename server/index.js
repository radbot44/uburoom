'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { startBot } = require('./discord');
async function main() {
  const config = require('./config').loadConfig();
  config.cert = fs.readFileSync(config.tlsCert);
  config.key = fs.readFileSync(config.tlsKey);
  const app = createApp(config);
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(config.port, config.host, resolve); });
  } catch (error) {
    try { await app.close(); } catch (cleanupError) { console.error('[uburoom] Cleanup failed after listen error: ' + cleanupError.message); }
    throw error;
  }
  console.log(`[uburoom] Server address: ${config.publicUrl}`);
  if(config.plexFallback?.enabled&&config.plexUrl&&config.plexToken)console.warn('[uburoom] Shared Plex fallback is enabled: eligible viewers without personal server access can use the fallback account’s media permissions. Set plex.fallback_token for a dedicated account, or disable fallback.');
  console.log(`[uburoom] Private credential key: ${path.resolve(config.credentialKeyFile)} (preserve and back up separately)`);
  console.log('[uburoom] Watch rooms are available in the browser. Ctrl+C stops the server.');
  let bot, retry, stopped=false;
  async function stop() { stopped=true;clearTimeout(retry);await bot?.destroy(); await app.close(); process.exit(0); }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  async function connect() {
    try { const connected=await startBot(config, app.hub); if(stopped)await connected?.destroy();else bot=connected; }
    catch(error) {
      console.error('[Discord] '+error.message+' Web playback remains available; retrying in 30 seconds.');
      if(!stopped){retry=setTimeout(()=>{void connect();},30000);retry.unref();}
    }
  }
  void connect();
}
main().catch(error => {
  const missing = error.code === 'ENOENT';
  console.error(missing ? '[uburoom] Missing TLS files. Follow README.md to generate a local development certificate.' : '[uburoom] ' + error.message);
  process.exitCode = 1;
});
