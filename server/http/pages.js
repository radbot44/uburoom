'use strict';
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { watchPage } = require('../watch-page');
const { WEB } = require('./static');

const ROOM_PAGE = /^\/room\/([a-z0-9-]+)$/i;
const JOIN_PAGE = /^\/join\/[^/]{1,60}$/;
/** The page that hosts the player: the lobby, a room, an invite and Discord's Activity entry. */
const isWatchDocument = route =>
  route === '/' || route === '/activity' || ROOM_PAGE.test(route) || JOIN_PAGE.test(route);

/** The browser's content security policy for the page that hosts the player. */
function playerPolicy({ nonce, plexOrigin = '' }) {
  return `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; font-src 'self'; connect-src 'self'${plexOrigin}; media-src 'self' blob:${plexOrigin}; worker-src 'self' blob:; img-src 'self' blob: data:; frame-src 'self'; base-uri 'none'; frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com; form-action 'self'`;
}

/**
 * The watch page: redirects to canonical addresses, the document itself, and the player's security policy.
 * @param {{config: any, rooms: () => any, watchRoutes: () => any, sessions: any, files: any}} services
 * @returns {{redirects: import('./router').Route[], documents: import('./router').Route[]}}
 */
function pageRoutes({ config, rooms, watchRoutes, sessions, files }) {
  const { user, renewCookie } = sessions;
  const redirect = (res, location) => {
    res.writeHead(302, { Location: location });
    res.end();
  };
  const withQuery = (base, query) => base + (query ? '?' + query : '');
  const redirects = [
    {
      name: 'Activity entry',
      methods: ['GET'],
      match: ({ route, activity }) =>
        route === '/activity' || (activity.context && ['/auth/discord', '/auth/callback'].includes(route)),
      handle: ({ res, activity }) => redirect(res, '/' + activity.query),
    },
    {
      name: 'room without an address',
      methods: ['GET'],
      path: '/room',
      handle: ({ res, url }) => redirect(res, withQuery('/', url.searchParams.toString())),
    },
    {
      // A room's earlier addresses lead to its current one.
      name: 'renamed room',
      methods: ['GET'],
      path: ROOM_PAGE,
      handle({ res, url }, match) {
        const requested = match[1].toLowerCase();
        const open = [...rooms().rooms.values()].find(room => room.previousSlugs?.has(requested));
        if (!open || !open.slug || open.slug === requested) return false;
        return redirect(res, withQuery('/room/' + encodeURIComponent(open.slug), url.searchParams.toString()));
      },
    },
    {
      name: 'legacy watch address',
      methods: ['GET'],
      path: '/watch',
      handle({ res, url }) {
        const requested = url.searchParams.get('room');
        if (requested) {
          try {
            const record = rooms().roomState.store.get(requested);
            if (record?.slug) {
              url.searchParams.delete('room');
              return redirect(res, withQuery('/room/' + encodeURIComponent(record.slug), url.searchParams.toString()));
            }
          } catch {
            /* No such room: the lobby. */
          }
        }
        return redirect(res, withQuery('/', url.searchParams.toString()));
      },
    },
  ];
  const documents = [
    {
      // The player's security policy, and a per-response nonce for OverlayScrollbars' own inline <style>.
      name: 'player security policy',
      async handle(ctx) {
        const { req, res, route, activity } = ctx;
        const document = isWatchDocument(route);
        if (!document && route !== '/__diagnostics/codec') return false;
        ctx.nonce = document ? randomBytes(16).toString('base64') : undefined;
        const auto = document && !activity.context && config.plexDelivery?.mode === 'auto';
        const origins =
          auto && watchRoutes().deliveryOrigins
            ? await watchRoutes().deliveryOrigins(req)
            : config.plexDelivery?.clientUrl
              ? [config.plexDelivery.clientUrl]
              : [];
        res.setHeader(
          'Content-Security-Policy',
          playerPolicy({ nonce: ctx.nonce, plexOrigin: auto ? origins.map(origin => ' ' + origin).join('') : '' }),
        );
        return false;
      },
    },
    {
      name: 'watch page',
      methods: ['GET', 'HEAD'],
      path: route => isWatchDocument(route) || route === '/watch',
      async handle(ctx) {
        const { req, res } = ctx;
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end();
        }
        const [initial, template] = await Promise.all([
          watchRoutes().bootstrap(req),
          files.readAsset(path.join(WEB, 'watch.html'), 'utf8'),
        ]);
        const current = await user(req);
        if (current) renewCookie(req, res, current);
        const html = watchPage(template, initial, ctx.nonce);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      },
    },
  ];
  return { redirects, documents };
}
module.exports = { pageRoutes };
