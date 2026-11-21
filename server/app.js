'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./core');
const { loginStore } = require('./storage');
const { MediaPipeline } = require('./media-pipeline');
const { MediaProviders } = require('./media-providers');
const { createSources } = require('./sources');
const { createRooms } = require('./watch');
const { watchHttp } = require('./watch-http');
const { watchSockets } = require('./watch-socket');
const { Accounts, credentialVault } = require('./accounts');
const { accountHttp } = require('./account-http');
const { operatorHttp } = require('./operator-http');
const { createConfigEditor } = require('./config-editor');
const { resilientFetch } = require('./resilience');
const { Admission } = require('./admission');
const { PlexTv, createDiscordSignIn } = require('./identity');
const { DiagnosticLog } = require('./diagnostic-log');
const { silentLogger } = require('./logger');
const { createAccess } = require('./access');
const { createGuests } = require('./guests');
const { createHubPorts } = require('./hub-ports');
const { createSessions } = require('./http/sessions');
const { createStaticFiles } = require('./http/static');
const { createHttpServer } = require('./http/server');
const { createUburoomAccounts } = require('./identity/accounts');
const { uburoomAccountRoutes } = require('./http/uburoom-accounts');
const { sourceSettings } = require('./source-settings');

const DEMO_MEDIA = path.join(__dirname, '../assets/demo/sync-test.mp4');

/** Opens the account database and its credential vault, refusing to start from a state that could lose accounts. */
function openAccounts(config) {
  if (config.accountFile && !config.credentialKeyFile)
    throw new Error('Configure a private uburoom credential key file outside the project');
  if (
    config.accountFile &&
    !fs.existsSync(config.accountFile) &&
    fs.existsSync(path.join(path.dirname(config.accountFile), 'logins.json'))
  )
    throw new Error(
      'Legacy private state found without a baseline database; review a backup and manual transfer or reset before starting',
    );
  if (config.accountFile && fs.existsSync(config.accountFile) && !fs.existsSync(config.credentialKeyFile))
    throw new Error('The uburoom credential key is missing; restore the original key before starting');
  const vault = credentialVault(config.credentialKeyFile);
  const registry = new Accounts(config.accountFile, vault);
  // Persist policy identity without leaving an offline verifier of the shared password in SQLite.
  // Password grants are process-local and reset on restart.
  // The entry rules hold no secret; the server password's own revision ends its sessions (server/admission/).
  const policy = config.accessPolicy ? [hash(JSON.stringify(config.accessPolicy))] : [];
  const identity = [config.publicUrl, config.ownerId, config.guildId, config.clientId, ...policy];
  try {
    return { registry, accounts: loginStore(JSON.stringify(identity), vault, registry) };
  } catch (error) {
    // The database is open but unusable (for example, a mismatched key): release it.
    Promise.resolve(registry.persistence.abort()).catch(() => {});
    throw error;
  }
}

const { createRoutes } = require('./http/routes');

/** The synchronization test video, when the installation includes it. */
const demoMedia = () =>
  fs.existsSync(DEMO_MEDIA)
    ? {
        kind: 'demo',
        title: 'uburoom synchronization test',
        duration: 60,
        format: 'file',
        quality: 'direct',
        file: DEMO_MEDIA,
      }
    : undefined;

/**
 * The composition root: builds every service, hands each the services it depends on, and starts none of them.
 * `config` is the validated configuration; the logger and TLS material arrive as options, never on `config`.
 * Services that need one another before either exists are given a function that finds it when called.
 */
function createApp(config, options = {}) {
  const {
    authorizeUrl = 'https://discord.com/oauth2/authorize',
    plexFetch = fetch,
    jellyfinFetch = fetch,
    plexDemo,
  } = options;
  const logger = options.logger || silentLogger;
  const oauthFetch = resilientFetch(options.oauthFetch || fetch, { timeoutMs: 10000 });
  const tls = options.tls || { cert: config.cert, key: config.key };
  let registry;
  try {
    // Storage and providers.
    const opened = openAccounts(config);
    const { accounts } = opened;
    registry = opened.registry;
    const pipeline = new MediaPipeline(config, { logger });
    // Plex sign-in proves who someone is through plex.tv; Plex sources reach plex.tv through it too.
    const plexIdentity = new PlexTv(plexFetch);
    if (config.demo) plexIdentity.demo = plexDemo;
    // Every configured source, through its type's module; no source is named here.
    const sources = createSources(config.sources || [], {
      ...{ config, registry, pipeline, logger, plexFetch, jellyfinFetch, plexTv: plexIdentity },
    });
    const plexAuth = sources.signIn.plex;
    const providers = new MediaProviders(sources.providers, pipeline);
    // uburoom accounts: operator-made username/password identities (provider 'uburoom').
    const uburoomAccounts = createUburoomAccounts({ registry });
    // Who may enter. The rooms and routes are built last, so earlier services find them when called.
    let hub, watch, watchRoutes, accountRoutes;
    const rooms = () => watch;
    const guests = createGuests({
      config,
      logger,
      registry,
      accounts,
      logins: accounts.logins,
      rooms,
      endedFor: ids => watchRoutes.invalidate(ids),
    });
    const entryPolicy = new Admission(config, registry, providers, () => access.raw(), {
      logger,
      guests,
      accounts: uburoomAccounts,
    });
    const access = createAccess({ registry, config, plexAuth, entryPolicy });
    const sessions = createSessions({ config, logger, registry, accounts, access, oauthFetch });
    // Rooms, and the hub that authorizes work in them.
    const { ports, setOwnerName } = createHubPorts({
      ...{ config, logger, registry, accounts, access, plexAuth, providers, guests, sessions },
      ...{ discord: { client: undefined }, hub: () => hub, rooms },
    });
    ({ hub, watch } = createRooms({
      config,
      ports,
      pipeline,
      providers,
      demoMedia: demoMedia(),
      registry,
      plexAuth,
    }));
    // Kept diagnostics: server log lines and viewer uploads share one daily timeline.
    const diagnosticLog = config.diagnostics?.enabled
      ? new DiagnosticLog({ ...config.diagnostics, logger })
      : undefined;
    const untapLogger = diagnosticLog && logger.tap((level, tag, message) => diagnosticLog.server(level, tag, message));
    // HTTP and sockets.
    const web = { config, registry, plexAuth, plexIdentity, uburoomAccounts, hub, watch, ...sessions };
    watchRoutes = watchHttp({ ...web, oauthFetch, entryPolicy, diagnosticLog, accounts });
    const signIn = createDiscordSignIn({ config, demo: () => plexIdentity.demo, sessions, authorizeUrl });
    accountRoutes = accountHttp({ ...web, entryPolicy, watchRoutes, loginStore: accounts, discordStart: signIn.start });
    const editor = config.configFile ? createConfigEditor(config.configFile) : undefined;
    const files = createStaticFiles({ config });
    const uburoomAccountsHttp = uburoomAccountRoutes({
      ...{ config, registry, uburoomAccounts, sessions, loginStore: accounts, hub, files },
      watchRoutes: () => watchRoutes,
    });
    // Server settings → Sources: saved to config.yaml, applied after a restart.
    const sourceSettingsHttp = sourceSettings({
      ...{ config, registry, editor, sessions, plexFetch, jellyfinFetch, plexTv: plexIdentity },
    });
    const route = createRoutes({
      ...{ config, registry, accounts, sessions, access, hub, rooms, files, signIn, setOwnerName },
      ...{ watchRoutes, accountRoutes, operatorRoutes: operatorHttp({ config, registry, editor, ...sessions }) },
      uburoomAccountRoutes: uburoomAccountsHttp.routes,
      sourceSettingsRoutes: sourceSettingsHttp.routes,
    });
    const server = createHttpServer({ config, logger, tls, json: sessions.json, route });
    const sockets = watchSockets({
      ...{ server, config, routes: watchRoutes, watch, hub, throttle: sessions.throttle },
      // Tests shorten the socket deadlines; production keeps the defaults.
      idleMs: options.socketTiming?.idleMs,
      livenessMs: options.socketTiming?.livenessMs,
    });
    const sweep = setInterval(() => {
      watch.maintainProviderSessions();
      for (const service of [watchRoutes, accountRoutes, signIn, sessions, uburoomAccountsHttp, sourceSettingsHttp])
        service.sweep();
      void guests.sweep();
    }, 1000);
    sweep.unref();
    let closing;
    function close() {
      if (closing) return closing;
      clearInterval(sweep);
      sockets.close();
      const mediaClosed = watch.close();
      watchRoutes.close();
      accountRoutes.close();
      hub.close();
      sourceSettingsHttp.close();
      files.close();
      untapLogger?.();
      const serverClosed = server.listening
        ? new Promise(resolve => {
            const nudge = () => server.closeIdleConnections?.();
            // Re-nudge briefly while draining so keep-alive sockets finishing in-flight work cannot stall WAL checkpoint.
            const timer = setInterval(nudge, 100);
            timer.unref();
            server.close(() => {
              clearInterval(timer);
              resolve();
            });
            nudge();
          })
        : Promise.resolve();
      closing = Promise.allSettled([mediaClosed, diagnosticLog?.close(), serverClosed]).then(async results => {
        try {
          await registry.close();
        } catch (error) {
          results.push({ status: 'rejected', reason: error });
        }
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      });
      return closing;
    }
    return { server, hub, watch, access, close, registry, plexAuth, setOwnerName, uburoomAccounts };
  } catch (error) {
    // Construction may fail before the registry exists.
    Promise.resolve(registry?.persistence.abort()).catch(() => {});
    throw error;
  }
}
module.exports = { createApp };
