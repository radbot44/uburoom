'use strict';
const { randomBytes } = require('node:crypto');
const { hash } = require('../core');

/**
 * Browser sign-in state: cookies, logins, renewal of Discord logins, request throttling and the JSON/body helpers
 * every route shares. `access` is the admission gate (server/access.js).
 */
function createSessions({ config, logger, registry, accounts, access, oauthFetch }) {
  // Server logins have no fixed lifetime; Discord renewal/revocation governs them.
  const loginSeconds = 365 * 24 * 60 * 60,
    renewals = new Map(),
    cookieRenewedAt = new Map();
  const logins = accounts.logins,
    limits = new Map();
  function discordIdentity(identity) {
    const account = registry.resolve('discord', identity.userId, identity.name);
    return { ...identity, name: account.name, userId: account.id, accountRevision: account.revision };
  }
  function validIdentity(identity) {
    const account = registry.canonical(identity.userId);
    return !!account && account.id === identity.userId && account.revision === identity.accountRevision;
  }
  const oauthReady = !!(config.clientId && config.clientSecret && config.ownerId);
  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(p => p.trim().split('=')));
  }
  function browserLogin(res, identity) {
    // Activity OAuth is not duplicated/rotated across browser sessions. This
    // browser login expires with its source's one-hour identity grant.
    const id = randomBytes(32).toString('hex');
    logins.set(hash(id), {
      userId: identity.userId,
      name: identity.name,
      accountRevision: identity.accountRevision,
      csrf: randomBytes(32).toString('hex'),
      expires: identity.expires,
    });
    accounts.save();
    res.setHeader('Set-Cookie', [
      cookie('uburoom', id, Math.max(1, Math.floor((identity.expires - Date.now()) / 1000))),
      cookie('uburoom_handoff', '', 0),
    ]);
  }
  function throttle(key, max = 60) {
    const now = Date.now();
    let bucket = limits.get(key);
    if (!bucket || now - bucket.at > 60000) {
      bucket = { at: now, count: 0 };
      limits.set(key, bucket);
    }
    return ++bucket.count <= max;
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
  function renewCookie(req, res, login, force = false) {
    if (!login || login.expires !== null) return;
    const token = cookies(req).uburoom,
      now = Date.now();
    if (force || now - (cookieRenewedAt.get(hash(token)) || 0) >= 86400000) {
      res.setHeader('Set-Cookie', cookie('uburoom', token, loginSeconds));
      cookieRenewedAt.set(hash(token), now);
    }
  }
  async function user(req) {
    const token = cookies(req).uburoom;
    const id = token && /^[a-f0-9]{64}$/.test(token) && hash(token);
    const login = id && logins.get(id);
    if (!login || !validIdentity(login) || (login.expires !== null && login.expires <= Date.now())) return;
    // Pending identities must remain usable for account linking when admission
    // requires Plex. Playback admission is enforced separately by watch routes.
    if (!config.accessPolicy && !access.canWatch(login.userId) && !(await access.refreshWatch(login.userId))) return;
    if (logins.get(id) !== login || !validIdentity(login) || (login.expires !== null && login.expires <= Date.now()))
      return;
    if (login.oauth && login.oauth.expires <= Date.now()) {
      if (!renewals.has(id)) {
        const renewal = (async () => {
          const response = await oauthFetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal: AbortSignal.timeout(10000),
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              grant_type: 'refresh_token',
              refresh_token: login.oauth.refreshToken,
            }),
          });
          if (!response.ok) {
            if ([400, 401, 403].includes(response.status)) {
              logins.delete(id);
              accounts.save();
              return;
            }
            throw new Error('Discord login renewal temporarily unavailable');
          }
          const renewed = await response.json();
          if (
            typeof renewed.refresh_token !== 'string' ||
            !Number.isFinite(renewed.expires_in) ||
            renewed.expires_in <= 0
          )
            throw new Error('Invalid login renewal');
          // Logout may have removed this login while Discord was responding.
          if (
            logins.get(id) !== login ||
            !validIdentity(login) ||
            (login.expires !== null && login.expires <= Date.now())
          )
            return;
          login.oauth = { refreshToken: renewed.refresh_token, expires: Date.now() + renewed.expires_in * 1000 };
          accounts.save();
          return login;
        })()
          .catch(() => {
            throw Object.assign(new Error('Discord login renewal temporarily unavailable'), { status: 503 });
          })
          .finally(() => renewals.delete(id));
        renewals.set(id, renewal);
      }
      return renewals.get(id);
    }
    return logins.get(id) === login && validIdentity(login) && (login.expires === null || login.expires > Date.now())
      ? login
      : undefined;
  }
  async function protectedPost(req) {
    if (req.headers.origin !== config.publicUrl) return;
    const login = await user(req);
    return login && req.headers.origin === config.publicUrl && req.headers['x-csrf-token'] === login.csrf
      ? login
      : undefined;
  }
  // These actor fields come from the server/login, never from the caller's JSON.
  function webActor(login) {
    return {
      userId: login.userId,
      ...(registry
        ? { discordId: registry.identities(login.userId).find(i => i.provider === 'discord' && i.verified)?.subject }
        : {}),
      name: registry.canonical(login.userId)?.name || login.name,
      activity: login.activity === true,
      ...(login.guestRoom ? { guestRoomId: login.guestRoom, device: login.device } : {}),
    };
  }
  async function body(req, limit = 4096) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > limit) throw new Error('Body too large');
    }
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
    return value;
  }
  async function discordFetch(url, options) {
    const response = await oauthFetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Discord authentication failed');
    return response.json();
  }
  function sweep() {
    let expired = false;
    for (const [id, login] of logins)
      if (login.expires !== null && login.expires <= Date.now()) {
        logins.delete(id);
        expired = true;
      }
    if (expired) Promise.resolve(accounts.save()).catch(() => logger.error('Storage', 'Login storage unavailable'));
    for (const id of cookieRenewedAt.keys()) if (!logins.has(id)) cookieRenewedAt.delete(id);
    for (const [id, bucket] of limits) if (Date.now() - bucket.at > 60000) limits.delete(id);
  }
  return {
    logins,
    oauthReady,
    loginSeconds,
    cookieRenewedAt,
    discordIdentity,
    validIdentity,
    cookie,
    cookies,
    browserLogin,
    throttle,
    json,
    renewCookie,
    user,
    protectedPost,
    webActor,
    body,
    discordFetch,
    sweep,
  };
}
module.exports = { createSessions };
