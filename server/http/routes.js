'use strict';
const { clientAddress } = require('../plex-delivery');
const { createRouter } = require('./router');
const { pageRoutes } = require('./pages');
const { mediaRoutes } = require('./media');
const { authRoutes } = require('./auth');
const version = require('../../package.json').version;

/**
 * The server's route table, in the order requests are tried: page redirects, the watch and account APIs,
 * the request budget, operator settings, the watch page, static files, media, health and sign-in.
 * `rooms` finds the Watch when called; the route sets are passed built.
 * @param {{config: any, registry: any, accounts: any, sessions: any, access: any, hub: any, rooms: () => any,
 *   files: any, signIn: any, setOwnerName: (name: string) => void, watchRoutes: any, accountRoutes: any,
 *   operatorRoutes: any}} services
 */
function createRoutes({
  config,
  registry,
  accounts,
  sessions,
  access,
  hub,
  rooms,
  files,
  signIn,
  setOwnerName,
  watchRoutes,
  accountRoutes,
  operatorRoutes,
}) {
  const { json, throttle } = sessions;
  const pages = pageRoutes({ config, rooms, watchRoutes: () => watchRoutes, sessions, files });
  return createRouter(
    pages.redirects,
    [
      { name: 'watch API', handle: ({ req, res, url }) => watchRoutes.route(req, res, url) },
      { name: 'account API', handle: ({ req, res, url }) => accountRoutes.route(req, res, url) },
      {
        // Everything but static files shares one request budget per client.
        name: 'request budget',
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
      rooms,
      signIn,
      accountRoutes: () => accountRoutes,
      watchRoutes: () => watchRoutes,
      setOwnerName,
      files,
    }),
  );
}
module.exports = { createRoutes };
