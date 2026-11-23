'use strict';
// @ts-check
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { hash } = require('../core');
const { clientAddress } = require('../client-address');
const { isServerOperator } = require('../operator-policy');
const { isAllowedBrowserOrigin, unconfiguredOriginMessage } = require('../origins');
const { WEB } = require('./static');

// Failed sign-ins allowed per window, per username and per address.
const FAILURE_WINDOW_MS = 15 * 60000,
  USERNAME_FAILURES = 5,
  ADDRESS_FAILURES = 20;
const WRONG = 'Wrong username or password';
const LINK_UNUSABLE = 'This link has expired or was already used. Ask the server operator for a new one.';
const LIMITED = 'Too many sign-in attempts; try again later';

/**
 * uburoom account routes: the set-password page and its link, username/password sign-in, and the
 * operator's account management (`/api/operator/accounts`).
 * @param {{config: any, registry: any, uburoomAccounts: ReturnType<typeof import('../identity/accounts').createUburoomAccounts>,
 *   sessions: any, loginStore: any, hub: any, watchRoutes: () => any, files: any}} services
 * @returns {{routes: import('./router').Route[], sweep: () => void}}
 */
function uburoomAccountRoutes({
  config,
  registry,
  uburoomAccounts,
  sessions,
  loginStore,
  hub,
  revokeAccountSessions,
  files,
}) {
  const { COOKIES, json, body, cookies, logins, replaceBrowserSession, user, protectedPost, validIdentity } = sessions;
  const failures = new Map();

  function limited(key, max) {
    const bucket = failures.get(key);
    return !!bucket && bucket.until > Date.now() && bucket.count >= max;
  }
  function fail(key) {
    let bucket = failures.get(key);
    if (!bucket || bucket.until <= Date.now())
      failures.set(key, (bucket = { count: 0, until: Date.now() + FAILURE_WINDOW_MS }));
    bucket.count++;
  }
  const usernameKey = value => {
    try {
      return 'username:' + uburoomAccounts.normalizeUsername(value);
    } catch {
      return 'username:' + String(typeof value === 'string' ? value.trim().toLowerCase() : '').slice(0, 64);
    }
  };
  const addressKey = req => 'address:' + (clientAddress(req, config) || 'local');
  const sameOrigin = req => isAllowedBrowserOrigin(config, req.headers.origin, req);

  /** A new browser session for this account; signing in replaces a guest session in this browser. */
  async function signedIn(req, res, userId) {
    const account = registry.canonical(userId);
    await replaceBrowserSession(req, res, {
      userId: account.id,
      accountRevision: account.revision,
      name: account.name,
      csrf: randomBytes(32).toString('hex'),
      expires: null,
    });
  }
  /** Ends every session of these accounts, and their room connections. */
  function endSessions(ids) {
    return revokeAccountSessions(ids);
  }

  /** The operator's request, checked now and again by `still()` after any awaited work. */
  async function operator(req, res) {
    const login = req.method === 'GET' ? await user(req) : await protectedPost(req);
    const current = () =>
      !!login &&
      logins.get(hash(cookies(req)[COOKIES.session] || '')) === login &&
      validIdentity(login) &&
      (login.expires === null || login.expires > Date.now());
    const still = () => current() && isServerOperator(registry, config, login.userId);
    if (!current()) {
      json(res, req.method === 'GET' ? 401 : 403, { error: 'Sign in to manage accounts' });
      return undefined;
    }
    if (!still()) {
      json(res, 403, { error: 'Server operator required' });
      return undefined;
    }
    return { login, still };
  }
  async function operatorAction(req, res, act) {
    const auth = await operator(req, res);
    if (!auth) return;
    try {
      const data = req.method === 'POST' ? await body(req) : {};
      await registry.flush();
      if (!auth.still()) return json(res, 403, { error: 'Operator authorization changed; nothing was changed' });
      const result = await act(data, auth.login.userId);
      await registry.flush();
      json(res, 200, result);
    } catch (error) {
      if (error.code?.startsWith?.('ACCOUNT_') || error.message?.startsWith('Use a display name'))
        return json(res, error.code === 'ACCOUNT_MISSING' ? 404 : 400, { error: error.message });
      json(res, error instanceof SyntaxError ? 400 : 503, { error: 'Account request failed; check storage' });
    }
  }
  const linkUrl = token => config.publicUrl + '/account/password#' + token;
  const withLink = result => ({
    account: result.account,
    link: { url: linkUrl(result.link.token), expires: result.link.expires },
  });

  /** @type {import('./router').Route[]} */
  const routes = [
    {
      name: 'set-password page',
      methods: ['GET', 'HEAD'],
      path: '/account/password',
      async handle({ req, res }) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : await files.readAsset(path.join(WEB, 'account-password.html')));
      },
    },
    {
      name: 'uburoom account link',
      methods: ['POST'],
      path: '/api/uburoom-accounts/link',
      async handle({ req, res }) {
        if (!sameOrigin(req))
          return json(res, 403, { error: unconfiguredOriginMessage(config, req) || 'Not authorized' });
        if (limited(addressKey(req), ADDRESS_FAILURES)) return json(res, 429, { error: LIMITED });
        const data = await body(req).catch(() => ({}));
        const info = uburoomAccounts.linkInfo(data.token);
        if (!info) {
          fail(addressKey(req));
          return json(res, 400, { error: LINK_UNUSABLE });
        }
        json(res, 200, info);
      },
    },
    {
      name: 'set uburoom account password',
      methods: ['POST'],
      path: '/api/uburoom-accounts/password',
      async handle({ req, res }) {
        if (!sameOrigin(req))
          return json(res, 403, { error: unconfiguredOriginMessage(config, req) || 'Not authorized' });
        if (limited(addressKey(req), ADDRESS_FAILURES)) return json(res, 429, { error: LIMITED });
        try {
          const data = await body(req);
          const userId = await uburoomAccounts.setPassword(data.token, data.password);
          if (!userId) {
            fail(addressKey(req));
            return json(res, 400, { error: LINK_UNUSABLE });
          }
          await registry.flush();
          await endSessions([userId]);
          await signedIn(req, res, userId);
          json(res, 200, { ok: true });
        } catch (error) {
          if (error.code === 'ACCOUNT_BUSY') return json(res, 429, { error: error.message });
          if (error.code === 'PASSWORD_INVALID') return json(res, 400, { error: error.message });
          json(res, 400, { error: LINK_UNUSABLE });
        }
      },
    },
    {
      name: 'uburoom account sign-in',
      methods: ['POST'],
      path: '/api/uburoom-accounts/sign-in',
      async handle({ req, res }) {
        if (!sameOrigin(req))
          return json(res, 403, { error: unconfiguredOriginMessage(config, req) || 'Not authorized' });
        let data;
        try {
          data = await body(req);
        } catch {
          return json(res, 400, { error: WRONG });
        }
        const name = usernameKey(data.username),
          address = addressKey(req);
        if (limited(name, USERNAME_FAILURES) || limited(address, ADDRESS_FAILURES))
          return json(res, 429, { error: LIMITED });
        let userId;
        try {
          userId = await uburoomAccounts.verify(data.username, data.password);
        } catch (error) {
          return json(res, 429, { error: error.code === 'ACCOUNT_BUSY' ? error.message : LIMITED });
        }
        if (!userId) {
          fail(name);
          fail(address);
          return json(res, 401, { error: WRONG });
        }
        failures.delete(name);
        await registry.flush();
        await signedIn(req, res, userId);
        json(res, 200, { ok: true });
      },
    },
    {
      name: 'operator accounts',
      methods: ['GET', 'POST'],
      path: '/api/operator/accounts',
      handle: ({ req, res }) =>
        operatorAction(req, res, (data, actor) =>
          req.method === 'GET'
            ? { accounts: uburoomAccounts.list() }
            : withLink(uburoomAccounts.create({ username: data.username, name: data.name, actor })),
        ),
    },
    {
      name: 'operator account action',
      methods: ['POST'],
      path: /^\/api\/operator\/accounts\/(link|disable|enable)$/,
      handle: ({ req, res }, match) =>
        operatorAction(req, res, async (data, actor) => {
          if (match[1] === 'link') return withLink(uburoomAccounts.issueLink(data.subject, actor));
          const userId = uburoomAccounts.setDisabled(data.subject, match[1] === 'disable', actor);
          if (match[1] === 'disable') await endSessions([userId]);
          return { account: uburoomAccounts.account(data.subject) };
        }),
    },
  ];
  function sweep() {
    for (const [key, bucket] of failures) if (bucket.until <= Date.now()) failures.delete(key);
  }
  return { routes, sweep };
}

module.exports = { uburoomAccountRoutes };
