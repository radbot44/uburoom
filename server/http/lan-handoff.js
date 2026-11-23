'use strict';
// @ts-check
/**
 * One-time sign-in and account-linking handoff between `server.public_url` (where Discord and
 * Plex OAuth callbacks land) and a configured LAN origin (`server.lan_url`).
 *
 * Flow:
 * 1. Browser on LAN starts sign-in or linking -> `begin()` sets a host-scoped nonce cookie on
 *    the LAN origin and redirects to `public_url/auth/lan-start?t=<startToken>`.
 * 2. `public_url` consumes `startToken`, sets the normal OAuth state cookie on `public_url`, and
 *    redirects to Discord or Plex.
 * 3. Discord/Plex returns to `public_url`'s single registered callback. After normal OAuth CSRF
 *    verification and code/PIN exchange, the callback calls `issueTicket()` and redirects to
 *    `<lanOrigin>/auth/lan#ticket=<ticket>` (fragment only, never sent over HTTP).
 * 4. The LAN page posts `{ ticket }` to `/api/auth/lan-handoff`. The server verifies the LAN
 *    `Origin`, the host-scoped LAN nonce cookie, and the single-use hashed ticket before setting
 *    the session cookie on the LAN origin.
 */
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { hash } = require('../core');
const { isAllowedBrowserOrigin, isLanOrigin, requestLanOrigin } = require('../origins');
const { safeReturn } = require('./auth');
const { WEB } = require('./static');

const MAX_PENDING = 200;
const START_TTL_MS = 60_000;
const TICKET_TTL_MS = 60_000;
const NONCE_SECONDS = 300;
const EXPIRED = 'Sign-in expired; start again from uburoom.';

/** @param {string} a @param {string} b */
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * @param {{config: any, sessions: any, signIn: any, accountRoutes: () => any, setOwnerName: (name: string) => void,
 *   files: any}} services
 */
function createLanHandoff({ config, sessions, signIn, accountRoutes, setOwnerName, files }) {
  const { COOKIES, cookie, cookies, json, body, user, replaceBrowserSession, discordIdentity, loginSeconds } = sessions;
  /** @type {Map<string, any>} */
  const starts = new Map();
  /** @type {Map<string, any>} */
  const tickets = new Map();

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of starts) if (entry.expires <= now) starts.delete(key);
    for (const [key, entry] of tickets) if (entry.expires <= now) tickets.delete(key);
  }

  /**
   * Starts a LAN-origin OAuth flow by binding a nonce cookie on the LAN origin and returning
   * the `public_url/auth/lan-start?t=…` URL that initiates the provider redirect.
   * @param {any} req
   * @param {any} res
   * @param {{provider: 'discord'|'plex', ownerOnly?: boolean, returnTo?: string, linkLogin?: any}} options
   */
  function begin(req, res, { provider, ownerOnly = false, returnTo = undefined, linkLogin = undefined }) {
    sweep();
    const lanOrigin = requestLanOrigin(config, req);
    if (!lanOrigin) throw new Error('LAN sign-in is unavailable from this address');
    if (starts.size >= MAX_PENDING) throw new Error('Sign-in is busy; try again shortly');
    const nonce = randomBytes(32).toString('hex');
    const startToken = randomBytes(32).toString('hex');
    starts.set(startToken, {
      provider,
      lanOrigin,
      lanNonceHash: hash(nonce),
      ownerOnly: !!ownerOnly,
      returnTo: safeReturn(returnTo),
      ...(linkLogin
        ? {
            link: {
              userId: linkLogin.userId,
              sourceHash: hash(cookies(req)[COOKIES.session] || ''),
              revision: linkLogin.accountRevision,
            },
          }
        : {}),
      expires: Date.now() + START_TTL_MS,
    });
    res.setHeader('Set-Cookie', cookie(COOKIES.lanHandoff, nonce, NONCE_SECONDS));
    return config.publicUrl + '/auth/lan-start?t=' + startToken;
  }

  /**
   * Issues a single-use, 60-second completion ticket for the LAN origin after OAuth succeeds on `public_url`.
   * @param {{lanOrigin: string, lanNonceHash: string, returnTo?: string, payload: any}} entry
   */
  function issueTicket({ lanOrigin, lanNonceHash, returnTo, payload }) {
    sweep();
    if (!isLanOrigin(config, lanOrigin)) throw new Error('LAN origin is no longer allowed');
    if (tickets.size >= MAX_PENDING) throw new Error('Sign-in is busy; try again shortly');
    const ticket = randomBytes(32).toString('hex');
    tickets.set(hash(ticket), {
      lanOrigin,
      lanNonceHash,
      returnTo: safeReturn(returnTo),
      payload,
      expires: Date.now() + TICKET_TTL_MS,
    });
    return lanOrigin + '/auth/lan#ticket=' + ticket;
  }

  /** @type {import('./router').Route[]} */
  const routes = [
    {
      name: 'start LAN OAuth on public_url',
      methods: ['GET'],
      path: '/auth/lan-start',
      async handle({ req, res, url }) {
        sweep();
        const token = url.searchParams.get('t') || '';
        const start = starts.get(token);
        starts.delete(token);
        if (!start || start.expires <= Date.now() || !isLanOrigin(config, start.lanOrigin)) {
          return accountRoutes().failAuth(res, EXPIRED);
        }
        try {
          if (start.provider === 'discord') {
            return await signIn.start(req, res, undefined, start.ownerOnly, start.returnTo, {
              lanOrigin: start.lanOrigin,
              lanNonceHash: start.lanNonceHash,
              link: start.link,
            });
          }
          if (start.provider === 'plex') {
            return await accountRoutes().startLanPlex(req, res, start);
          }
          return accountRoutes().failAuth(res, EXPIRED);
        } catch (error) {
          return accountRoutes().failAuth(res, error.message || EXPIRED);
        }
      },
    },
    {
      name: 'LAN hand-off page',
      methods: ['GET', 'HEAD'],
      path: '/auth/lan',
      async handle({ req, res }) {
        res.setHeader('Referrer-Policy', 'no-referrer');
        files.send(
          req,
          res,
          await files.readAsset(path.join(WEB, 'lan-handoff.html')),
          'text/html; charset=utf-8',
          '/auth/lan',
          { cacheControl: 'no-store' },
        );
      },
    },
    {
      name: 'redeem LAN hand-off ticket',
      methods: ['POST'],
      path: '/api/auth/lan-handoff',
      async handle({ req, res }) {
        sweep();
        const origin = req.headers.origin;
        if (!isAllowedBrowserOrigin(config, origin, req) || !isLanOrigin(config, origin)) {
          return json(res, 403, { error: 'Not authorized' });
        }
        let data;
        try {
          data = await body(req, 1024);
        } catch {
          return json(res, 400, { error: EXPIRED });
        }
        const ticket = typeof data.ticket === 'string' && data.ticket.length <= 128 ? data.ticket : '';
        const key = ticket ? hash(ticket) : '';
        const pending = key ? tickets.get(key) : undefined;
        if (key) tickets.delete(key);
        const nonce = cookies(req)[COOKIES.lanHandoff] || '';
        if (
          !pending ||
          pending.expires <= Date.now() ||
          pending.lanOrigin !== origin ||
          !nonce ||
          !sameHash(hash(nonce), pending.lanNonceHash)
        ) {
          return json(res, 400, { error: EXPIRED });
        }
        const clearLanCookie = cookie(COOKIES.lanHandoff, '', 0);
        const { payload } = pending;
        if (payload.kind === 'discord-signin') {
          if (payload.id === config.ownerId) setOwnerName(payload.name);
          await replaceBrowserSession(
            req,
            res,
            {
              ...discordIdentity({ userId: payload.id, name: payload.name }),
              csrf: randomBytes(32).toString('hex'),
              expires: null,
              ...(payload.oauth ? { oauth: payload.oauth } : {}),
            },
            { maxAge: loginSeconds, extraCookies: [clearLanCookie] },
          );
          return json(res, 200, { ok: true, destination: safeReturn(pending.returnTo) || '/' });
        }
        if (payload.kind === 'plex-signin') {
          await accountRoutes().completeSignIn(
            req,
            res,
            {
              provider: 'plex',
              subject: payload.subject,
              name: payload.name,
              credential: payload.credential,
            },
            [clearLanCookie],
          );
          return json(res, 200, { ok: true, destination: safeReturn(pending.returnTo) || '/' });
        }
        if (payload.kind === 'link') {
          const linking = await user(req);
          if (
            !linking ||
            linking.userId !== payload.link.userId ||
            !sameHash(hash(cookies(req)[COOKIES.session] || ''), payload.link.sourceHash) ||
            linking.accountRevision !== payload.link.revision
          ) {
            res.setHeader('Set-Cookie', clearLanCookie);
            return json(res, 403, { error: 'Account changed during linking; start again' });
          }
          const result = await accountRoutes().verifiedLink(
            req,
            res,
            linking,
            payload.provider,
            payload.subject,
            payload.name,
            payload.credential,
            payload.oauth,
            [clearLanCookie],
          );
          if (!res.getHeader('Set-Cookie')) res.setHeader('Set-Cookie', clearLanCookie);
          const destination = result?.pendingMerge ? '/?account=1&merge=1' : '/?account=1';
          return json(res, 200, { ok: true, destination });
        }
        res.setHeader('Set-Cookie', clearLanCookie);
        return json(res, 400, { error: EXPIRED });
      },
    },
  ];

  return { begin, issueTicket, sweep, routes };
}

module.exports = { createLanHandoff };
