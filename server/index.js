'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { startBot } = require('./discord');
const { Logger } = require('./logger');

async function main() {
  const config = require('./config').loadConfig();
  const logger = new Logger(config.logging);
  const tls = { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) };
  const app = createApp(config, { logger, tls });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    try {
      await app.close();
    } catch (cleanupError) {
      logger.error('Server', 'Cleanup failed after listen error: ' + cleanupError.message);
    }
    throw error;
  }
  logger.info('Server', `Server address: ${config.publicUrl}`);
  // Warn only when sharing would use the owner's own account.
  if (
    config.plexFallback?.enabled &&
    config.plexUrl &&
    config.plexToken &&
    (!config.plexFallback.token || config.plexFallback.token === config.plexToken)
  )
    logger.warn(
      'Plex',
      'Shared Plex fallback is enabled: eligible viewers without personal server access can use the fallback account’s media permissions. Set plex.fallback_token for a dedicated account, or disable fallback.',
    );
  logger.info(
    'Server',
    `Private credential key: ${path.resolve(config.credentialKeyFile)} (preserve and back up separately)`,
  );
  logger.info('Server', 'Watch rooms are available in the browser. Ctrl+C stops the server.');
  let bot,
    retry,
    stopped = false;
  async function stop() {
    stopped = true;
    clearTimeout(retry);
    await bot?.destroy();
    await app.close();
    await logger.close();
    process.exit(0);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  async function connect() {
    try {
      const connected = await startBot(config, {
        access: app.access,
        discord: app.hub.discord,
        setOwnerName: app.setOwnerName,
        logger,
      });
      if (stopped) await connected?.destroy();
      else bot = connected;
    } catch (error) {
      logger.error('Discord', error.message + ' Web playback remains available; retrying in 30 seconds.');
      if (!stopped) {
        retry = setTimeout(() => {
          void connect();
        }, 30000);
        retry.unref();
      }
    }
  }
  void connect();
}
main().catch(error => {
  const missing = error.code === 'ENOENT';
  const msg = missing
    ? 'Missing TLS files. Follow README.md to generate a local development certificate.'
    : error.message;
  process.stderr.write(`[uburoom] ${msg}\n`);
  process.exitCode = 1;
});
