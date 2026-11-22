'use strict';
/**
 * Starting uburoom: setup mode when the config file does not exist (server/setup/), otherwise the
 * normal app. Setup hands over to the normal app in this same process once it has written the
 * config (docs/first-run-setup.md D1, D6), so nothing depends on a supervisor restarting it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { startBot } = require('./discord');
const { Logger } = require('./logger');
const { configPath, loadConfig } = require('./config');
const { startSetup, setupOptions, needsSetup } = require('./setup');

/** Listens, retrying briefly while the port is still being released (setup's listener just closed). */
async function listen(server, port, host, retries) {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(undefined);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt >= retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/**
 * The normal app, listening, with the Discord bot connecting in the background.
 * @param {any} config - validated
 * @param {{logger: any, setupHandoff?: any, botStarter?: typeof startBot, signals?: boolean, appOptions?: any}} options -
 *   `appOptions` passes services to the app (tests)
 */
async function startServer(config, { logger, setupHandoff, botStarter = startBot, signals = true, appOptions = {} }) {
  // Behind a trusted proxy (server.listen: 'http-proxy') uburoom speaks plain HTTP and needs no certificate.
  const readTls = (file, kind) => {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      throw Object.assign(
        new Error(
          `Missing or unreadable TLS ${kind} file (${file}): ${error.code || error.message}. Generate a local certificate or update server.tls_cert and server.tls_key.`,
        ),
        { cause: error },
      );
    }
  };
  const tls =
    config.listen === 'http-proxy'
      ? undefined
      : { cert: readTls(config.tlsCert, 'certificate'), key: readTls(config.tlsKey, 'private key') };
  const app = createApp(config, { ...appOptions, logger, tls, setupHandoff });
  try {
    await app.completeSetup();
    await listen(app.server, config.port, config.host, setupHandoff ? 30 : 0);
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
      clearTimeout(forceExit);
      if (signals) {
        try {
          await logger.close();
        } catch {
          exitCode = 1;
        }
        process.exit(exitCode);
      }
    }
  }
  if (signals) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  async function connect() {
    try {
      const connected = await botStarter(config, {
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
  return { app, stop };
}

/**
 * Setup mode until the config is written, then the normal app.
 * @param {{configFile: string, args?: string[], logger?: any, setup?: any, signals?: boolean,
 *   botStarter?: typeof startBot, appOptions?: any}} options - `setup` passes services (fetchers) to
 *   setup mode, for tests
 * @returns {Promise<{setup: any, started: Promise<any>}>} `started` resolves with the normal app
 */
async function startWithSetup({ configFile, args = [], logger, setup = {}, signals = true, botStarter, appOptions }) {
  const setupLogger = logger || new Logger({ level: 'info', requests: false, file: '' });
  let resolveStarted, rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  started.catch(() => {});
  const stopSetup = async () => {
    await running?.close();
    process.exit(0);
  };
  let running;
  running = await startSetup({
    configFile,
    ...setupOptions(args),
    ...setup,
    logger: setupLogger,
    async handOff(handoff) {
      if (signals) {
        process.off('SIGINT', stopSetup);
        process.off('SIGTERM', stopSetup);
      }
      try {
        running = undefined;
        const config = loadConfig(configFile, args);
        const normal = await startServer(config, {
          logger: logger || new Logger(config.logging),
          setupHandoff: handoff,
          signals,
          botStarter,
          appOptions,
        });
        resolveStarted(normal);
        return normal;
      } catch (error) {
        rejectStarted(error);
        throw error;
      }
    },
  });
  if (signals) {
    process.once('SIGINT', stopSetup);
    process.once('SIGTERM', stopSetup);
  }
  return { setup: running, started };
}

async function run(args = process.argv.slice(2)) {
  const configFile = configPath(args);
  // D1: setup only when the file is missing. A config that exists but is invalid fails as before.
  if (needsSetup(configFile)) {
    const { started } = await startWithSetup({ configFile, args });
    // A failed hand-off leaves nothing running: say why and stop.
    started.catch(error => {
      process.stderr.write(`[uburoom] ${error.message}\n`);
      // After the setup page has been told.
      setTimeout(() => process.exit(1), 1000);
    });
    return;
  }
  const config = loadConfig(configFile, args);
  await startServer(config, { logger: new Logger(config.logging) });
}

module.exports = { run, startServer, startWithSetup };
