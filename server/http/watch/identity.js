'use strict';
const { randomBytes, randomUUID } = require('node:crypto');

/** Browser and bearer identities of the watch API: who a request is and whether the server admits them. */
function watchIdentity({ config, hub, user, webActor, entryPolicy, validIdentity }) {
  const identities = new Map();
  const activityOrigin = /^\d{17,20}$/.test(config.clientId || '')
    ? `https://${config.clientId}.discordsays.com`
    : undefined;
  const allowedOrigin = req =>
    req.headers.origin === config.publicUrl || (activityOrigin && req.headers.origin === activityOrigin);
  if (config.demo && (!['localhost', '127.0.0.1'].includes(new URL(config.publicUrl).hostname) || config.botToken))
    throw new Error('Demo identities are restricted to an isolated localhost server without a bot token');
  function issue(login, customLifetime) {
    const token = randomBytes(32).toString('hex');
    const lifetime =
      customLifetime ||
      (config.demo && Number.isSafeInteger(config.demoIdentityMs) && config.demoIdentityMs >= 10000
        ? config.demoIdentityMs
        : 3600000);
    login.maxExpires = Date.now() + lifetime;
    login.expires = login.maxExpires;
    login.viewerId = randomUUID();
    identities.set(token, login);
    return { token, expiresAt: login.expires };
  }
  async function rawLogin(req) {
    const auth = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    const token = bearer && /^[a-f0-9]{64}$/.test(bearer[1]) ? bearer[1] : undefined;
    const identity = bearer ? token && identities.get(token) : await user(req);
    if (!identity || !validIdentity(identity) || (identity.expires != null && identity.expires <= Date.now())) return;
    const location = identity.activityLocation;
    if (
      location &&
      hub.access.raw()?.activityLocation?.(location.subject, location.guildId, location.channelId) === false
    )
      return;
    if (token && identity.expires != null && identity.maxExpires != null && !identity.native)
      identity.expires = Math.min(identity.maxExpires, Math.max(identity.expires, Date.now() + 3600000));
    return identity;
  }
  async function login(req) {
    const identity = await rawLogin(req);
    if (!identity) return;
    if (!config.accessPolicy?.publicWeb && config.accessPolicy && !identity.activity) return;
    const admitted = entryPolicy
      ? await entryPolicy.admit(identity.userId, identity)
      : await hub.admit(identity.userId, identity);
    if (!admitted) return;
    const current = await rawLogin(req);
    return current?.userId === identity.userId && current?.accountRevision === identity.accountRevision
      ? current
      : undefined;
  }
  async function authorized(req, write = false) {
    const identity = typeof req.cachedLogin === 'function' ? await req.cachedLogin() : await login(req);
    if (
      !identity ||
      (req.controlSocket && req.controlSocket.readyState !== 1) ||
      (write && (!allowedOrigin(req) || (!req.headers.authorization && req.headers['x-csrf-token'] !== identity.csrf)))
    )
      return;
    return { identity, actor: webActor(identity) };
  }
  return { identities, issue, rawLogin, login, authorized, allowedOrigin, activityOrigin };
}
module.exports = { watchIdentity };
