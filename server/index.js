'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { startBot } = require('./discord');
const { Logger } = require('./logger');

async function main() {
  const config = require('./config').loadConfig();
  const logger = new Logger(config.logging);
  // Behind a trusted proxy (server.listen: 'http-proxy') uburoom speaks plain HTTP and needs no certificate.
  const tls =
    config.listen === 'http-proxy'
      ? undefined
      : { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) };
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
  // Two sources reporting one server is a configuration mistake; their media stays unavailable until fixed.
  void app.watch.providers.verify().catch(error => logger.error('Sources', error.message));
  logger.info(
    'Server',
    `Private credential key: ${path.resolve(config.credentialKeyFile)} (preserve and back up separately)`,
  );
  logger.info('Server', 'Watch rooms are available in the browser. Ctrl+C stops the server.');
  let bot,
    retry,
    stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    // Hard-exit beyond Watch.close()'s 35s mediaDrainMs so a stuck dependency cannot wedge shutdown forever.
    const forceExit = setTimeout(() => {
      process.exit(1);
    }, 40000);
    forceExit.unref();
    let exitCode = 0;
    try {
      try {
        await bot?.destroy();
      } catch (error) {
        exitCode = 1;
        logger.error('Discord', 'Bot shutdown failed: ' + (error?.message || error));
      }
      await app.close();
    } catch (error) {
      exitCode = 1;
      logger.error('Server', 'Shutdown failed: ' + (error?.message || error));
    } finally {
      try {
        await logger.close();
      } catch {
        exitCode = 1;
      }
      clearTimeout(forceExit);
      process.exit(exitCode);
    }
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
