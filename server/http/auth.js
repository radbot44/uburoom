'use strict';
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { hash } = require('../core');
const { WEB } = require('./static');

/** Where a sign-in may send the browser afterwards: only this server's own pages. */
const RETURN_TARGETS = [
  /^\/auth\/native#[a-f0-9]{64}$/,
  /^\/watch\?room=[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  /^\/room\/[a-z0-9-]+$/,
  /^\/(?:join\/[a-z]{6}-[a-z]{6})?$/,
];
const safeReturn = target => (target && RETURN_TARGETS.some(pattern => pattern.test(target)) ? target : undefined);

/**
 * The sign-in routes: who the browser is, Admin mode, Discord sign-in and sign-out, and the native hand-off pages.
 * `accountRoutes` and `watchRoutes` are read when a request arrives, after everything is built.
 * @param {{config: any, registry: any, accounts: any, sessions: any, access: any, hub: any, rooms: () => any,
 *   signIn: ReturnType<typeof import('../identity/discord').createDiscordSignIn>, accountRoutes: () => any, watchRoutes: () => any,
 *   setOwnerName: (name: string) => void, files: any}} services
 * @returns {import('./router').Route[]}
 */
function authRoutes({
  config,
  registry,
  accounts,
  sessions,
  access,
  hub,
  rooms,
  signIn,
  accountRoutes,
  watchRoutes,
  setOwnerName,
  files,
}) {
  const {
    logins,
    oauthReady,
    loginSeconds,
    cookieRenewedAt,
    cookie,
    cookies,
    json,
    renewCookie,
    user,
    protectedPost,
    webActor,
    body,
    discordFetch,
    discordIdentity,
  } = sessions;
  return [
    {
      name: 'browser hand-off page',
      methods: ['GET'],
      path: '/auth/handoff',
      async handle({ res }) {
        const content = await files.readAsset(path.join(WEB, 'handoff.html'));
        res.setHeader('Set-Cookie', cookie('uburoom_handoff', randomBytes(32).toString('hex'), 60));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      },
    },
    {
      name: 'native hand-off page',
      methods: ['GET'],
      path: '/auth/native',
      async handle({ res }) {
        const content = await files.readAsset(path.join(WEB, 'native-handoff.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      },
    },
    {
      name: 'who am I',
      methods: ['GET'],
      path: '/api/me',
      async handle({ req, res }) {
        const login = await user(req);
        renewCookie(req, res, login, true);
        json(res, 200, {
          oauthReady,
          loggedIn: !!login,
          csrf: login?.csrf,
          owner: !!login && hub.isOwner(webActor(login)),
          name: login?.name,
          adminMode: !!login && hub.isAdmin(webActor(login)),
        });
      },
    },
    {
      name: 'admin mode',
      methods: ['POST'],
      path: '/api/admin-mode',
      async handle({ req, res }) {
        const login = await protectedPost(req),
          data = await body(req);
        if (login) await hub.refreshAdmin(webActor(login));
        if (!login || !hub.canAdmin(webActor(login)) || typeof data.enabled !== 'boolean')
          return json(res, 403, { error: 'Only an authorized administrator can change Admin mode' });
        hub.setAdminMode(webActor(login), data.enabled);
        rooms().identityChanged();
        json(res, 200, { adminMode: hub.isAdmin(webActor(login)) });
      },
    },
    {
      name: 'start Discord sign-in',
      methods: ['GET'],
      path: route => ['/auth/discord', '/auth/owner'].includes(route),
      async handle({ req, res, route, url }) {
        if (!oauthReady) return json(res, 503, { error: 'Configure Discord OAuth on the server first' });
        return signIn.start(req, res, undefined, route === '/auth/owner', safeReturn(url.searchParams.get('return')));
      },
    },
    {
      name: 'finish Discord sign-in',
      methods: ['GET'],
      path: '/auth/callback',
      async handle({ req, res, url }) {
        const state = url.searchParams.get('state'),
          code = url.searchParams.get('code');
        const attempt = signIn.take(state);
        if (
          !oauthReady ||
          !state ||
          cookies(req).uburoom_oauth !== state ||
          !attempt ||
          attempt.expires <= Date.now() ||
          !code ||
          code.length > 512
        )
          return json(res, 403, { error: 'Invalid or expired login; start again' });
        const linking = attempt.linkUserId ? await user(req) : undefined;
        if (
          attempt.linkUserId &&
          (!linking ||
            linking.userId !== attempt.linkUserId ||
            hash(cookies(req).uburoom || '') !== attempt.sourceHash ||
            linking.accountRevision !== attempt.revision)
        )
          return json(res, 403, { error: 'Account changed during linking; start again' });
        const { name, oauth, ...identity } = await signIn.exchange(code, discordFetch);
        if (attempt.ownerOnly && identity.id !== config.ownerId)
          return json(res, 403, { error: 'This sign-in is reserved for the configured installation owner' });
        if (linking) {
          if ((await user(req)) !== linking) return json(res, 403, { error: 'Account sign-in expired during linking' });
          await accountRoutes().verifiedLink(req, res, linking, 'discord', identity.id, name, undefined, oauth);
          const existing = res.getHeader('Set-Cookie');
          res.writeHead(302, {
            Location: '/?account=1',
            'Set-Cookie': [...(existing ? [existing] : []), cookie('uburoom_oauth', '', 0)],
          });
          return res.end();
        }
        if (!config.accessPolicy && !(await access.refresh(identity.id)))
          return json(res, 403, {
            error: 'Sign in as a member of the configured Discord server; the bot must be connected.',
          });
        const id = randomBytes(32).toString('hex');
        // Signing in replaces a guest session in this browser.
        const previous = logins.get(hash(cookies(req).uburoom || ''));
        if (previous && registry.isGuest(previous.userId)) logins.delete(hash(cookies(req).uburoom));
        if (identity.id === config.ownerId) setOwnerName(name);
        logins.set(hash(id), {
          ...discordIdentity({ userId: identity.id, name }),
          csrf: randomBytes(32).toString('hex'),
          expires: null,
          ...(oauth ? { oauth } : {}),
        });
        accounts.save();
        res.writeHead(302, {
          Location: safeReturn(attempt.returnTo) || '/',
          'Set-Cookie': [cookie('uburoom', id, loginSeconds), cookie('uburoom_oauth', '', 0)],
        });
        return res.end();
      },
    },
    {
      name: 'sign out',
      methods: ['POST'],
      path: '/api/logout',
      async handle({ req, res }) {
        // Sign-out needs the existing cookie and CSRF proof, not current provider
        // eligibility: revocation or an upstream outage must not trap a login.
        const token = cookies(req).uburoom,
          id = token && hash(token),
          login = id && logins.get(id);
        if (!login || req.headers.origin !== config.publicUrl || req.headers['x-csrf-token'] !== login.csrf)
          return json(res, 403, { error: 'Not authorized' });
        hub.clearAdmin(webActor(login));
        logins.delete(id);
        cookieRenewedAt.delete(id);
        accounts.save();
        await watchRoutes().logout(id);
        res.setHeader('Set-Cookie', cookie('uburoom', '', 0));
        json(res, 200, { ok: true });
      },
    },
  ];
}
module.exports = { authRoutes };
