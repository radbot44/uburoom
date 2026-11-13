'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./core');
const { loginStore } = require('./storage');
const { Plex } = require('./plex');
const { createRooms } = require('./watch');
const { watchHttp } = require('./watch-http');
const { watchSockets } = require('./watch-socket');
const { Accounts, credentialVault } = require('./accounts');
const { PlexAuth } = require('./plex-auth');
const { accountHttp } = require('./account-http');
const { operatorHttp } = require('./operator-http');
const { createConfigEditor } = require('./config-editor');
const { resilientFetch } = require('./resilience');
const { AccessPolicy } = require('./access-policy');
const { DiagnosticLog } = require('./diagnostic-log');
const { silentLogger } = require('./logger');
const { clientAddress } = require('./plex-delivery');
const { createAccess } = require('./access');
const { createGuests } = require('./guests');
const { createHubPorts } = require('./hub-ports');
const { createSessions } = require('./http/sessions');
const { createStaticFiles } = require('./http/static');
const { createDiscordSignIn, authRoutes } = require('./http/auth');
const { pageRoutes } = require('./http/pages');
const { mediaRoutes } = require('./http/media');
const { createRouter } = require('./http/router');
const { createHttpServer } = require('./http/server');
const version = require('../package.json').version;

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
  const policy = config.accessPolicy
    ? [hash(JSON.stringify({ ...config.accessPolicy, password: !!config.accessPolicy.password }))]
    : [];
  const identity = [config.publicUrl, config.ownerId, config.guildId, config.clientId, ...policy];
  try {
    return { registry, accounts: loginStore(JSON.stringify(identity), vault, registry) };
  } catch (error) {
    // The database is open but unusable (for example, a mismatched key): release it.
    Promise.resolve(registry.persistence.abort()).catch(() => {});
    throw error;
  }
}

/**
 * The composition root: builds every service, hands each the services it depends on, and starts none of them.
 * `config` is the validated configuration; the logger and TLS material arrive as options, never on `config`.
 * Services that need one another before either exists are given a function that finds it when called.
 */
function createApp(config, options = {}) {
  const {
    authorizeUrl = 'https://discord.com/oauth2/authorize',
    plexFetch = fetch,
    plexDemo,
    logger = silentLogger,
  } = options;
  const oauthFetch = resilientFetch(options.oauthFetch || fetch, { timeoutMs: 10000 });
  const tls = options.tls || { cert: config.cert, key: config.key };
  let registry;
  try {
    let accounts;
    ({ registry, accounts } = openAccounts(config));
    const plex = new Plex(config, plexFetch, { logger });
    const plexAuth = new PlexAuth(config, registry, plex, plexFetch);
    if (config.demo) plexAuth.demo = plexDemo;
    let hub, watch, watchRoutes, accountRoutes;
    const guests = createGuests({
      config,
      logger,
      registry,
      accounts,
      logins: accounts.logins,
      rooms: () => watch,
      endedFor: ids => watchRoutes.invalidate(ids),
    });
    const entryPolicy = new AccessPolicy(config, registry, plexAuth, () => access.raw(), { logger, guests });
    const access = createAccess({ registry, config, plexAuth, entryPolicy });
    const sessions = createSessions({ config, logger, registry, accounts, access, oauthFetch });
    const discord = { client: undefined };
    const { ports, setOwnerName } = createHubPorts({
      config,
      logger,
      registry,
      accounts,
      access,
      plexAuth,
      entryPolicy,
      guests,
      sessions,
      discord,
      hub: () => hub,
      rooms: () => watch,
    });
    const demoMedia = fs.existsSync(DEMO_MEDIA)
      ? {
          kind: 'demo',
          title: 'uburoom synchronization test',
          duration: 60,
          format: 'file',
          quality: 'direct',
          file: DEMO_MEDIA,
        }
      : undefined;
    ({ hub, watch } = createRooms({ config, ports, plex, demoMedia, registry, plexAuth }));
    // Kept diagnostics: server log lines and viewer uploads share one daily timeline.
    const diagnosticLog = config.diagnostics?.enabled
      ? new DiagnosticLog({ ...config.diagnostics, logger })
      : undefined;
    const untapLogger = diagnosticLog && logger.tap((level, tag, message) => diagnosticLog.server(level, tag, message));
    const { json, throttle } = sessions;
    watchRoutes = watchHttp({
      config,
      watch,
      hub,
      ...sessions,
      oauthFetch,
      registry,
      entryPolicy,
      diagnosticLog,
      accounts,
      plexAuth,
    });
    const signIn = createDiscordSignIn({ config, plexAuth, sessions, authorizeUrl });
    accountRoutes = accountHttp({
      config,
      registry,
      plexAuth,
      hub,
      watch,
      watchRoutes,
      ...sessions,
      loginStore: accounts,
      discordStart: signIn.start,
    });
    const operatorRoutes = operatorHttp({
      config,
      registry,
      editor: config.configFile ? createConfigEditor(config.configFile) : undefined,
      ...sessions,
    });
    const files = createStaticFiles({ config });
    const pages = pageRoutes({ config, rooms: () => watch, watchRoutes: () => watchRoutes, sessions, files });
    const route = createRouter(
      pages.redirects,
      [
        { name: 'watch API', handle: ({ req, res, url }) => watchRoutes.route(req, res, url) },
        { name: 'account API', handle: ({ req, res, url }) => accountRoutes.route(req, res, url) },
        {
          // Everything but static files shares one request budget per client.
          name: 'rate limit',
          async handle(ctx) {
            const read = ['GET', 'HEAD'].includes(ctx.req.method);
            if (read) ctx.asset = await files.lookup(ctx.route);
            if (read && files.isStatic(ctx)) return false;
            if (!throttle(clientAddress(ctx.req) || 'local', 180))
              return json(ctx.res, 429, { error: 'Too many requests; try again shortly' });
            return false;
          },
        },
        {
          name: 'operator settings',
          handle: ({ req, res, url, flushed }) => operatorRoutes.route(req, res, url, flushed),
        },
      ],
      pages.documents,
      files.routes(),
      mediaRoutes({ config, hub, watchRoutes: () => watchRoutes }),
      [
        {
          name: 'health',
          methods: ['GET'],
          path: '/health',
          handle: ({ res }) =>
            json(res, registry.persistence.error ? 503 : 200, { ok: !registry.persistence.error, version }),
        },
      ],
      authRoutes({
        config,
        registry,
        accounts,
        sessions,
        access,
        hub,
        rooms: () => watch,
        signIn,
        accountRoutes: () => accountRoutes,
        watchRoutes: () => watchRoutes,
        setOwnerName,
        files,
      }),
    );
    const server = createHttpServer({ config, logger, tls, json, route });
    const watchConnections = watchSockets({ server, config, routes: watchRoutes, watch, hub, throttle });
    const sweep = setInterval(() => {
      watch.maintainPlexSessions();
      watchRoutes.sweep();
      accountRoutes.sweep();
      signIn.sweep();
      sessions.sweep();
      void guests.sweep();
    }, 1000);
    sweep.unref();
    let closing;
    function close() {
      if (closing) return closing;
      clearInterval(sweep);
      watchConnections.close();
      const mediaClosed = watch.close();
      watchRoutes.close();
      accountRoutes.close();
      hub.close();
      files.close();
      untapLogger?.();
      closing = Promise.allSettled([
        mediaClosed,
        diagnosticLog?.close(),
        new Promise(resolve => (server.listening ? server.close(resolve) : resolve())),
      ]).then(async results => {
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
    return { server, hub, watch, access, close, registry, plexAuth, setOwnerName };
  } catch (error) {
    // Construction may fail before the registry exists.
    Promise.resolve(registry?.persistence.abort()).catch(() => {});
    throw error;
  }
}
module.exports = { createApp };
