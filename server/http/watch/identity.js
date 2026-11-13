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
    login.expires = Date.now() + lifetime;
    login.viewerId = randomUUID();
    identities.set(token, login);
    return { token, expiresAt: login.expires };
  }
  async function rawLogin(req) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    const identity = req.headers.authorization ? token && identities.get(token) : await user(req);
    if (!identity || !validIdentity(identity) || (identity.expires != null && identity.expires <= Date.now())) return;
    if (token && identity.expires != null) identity.expires = Math.max(identity.expires, Date.now() + 3600000);
    return identity;
  }
  async function login(req) {
    const identity = await rawLogin(req);
    if (!identity) return;
    if (config.accessPolicy) {
      if (!config.accessPolicy.publicWeb && !identity.activity) return;
      if (!entryPolicy.password(req, identity)) return;
      entryPolicy.entered(identity.userId);
      if (!(await entryPolicy.admit(identity.userId, identity))) return;
    } else if (
      !(hub.access?.canWatch ? hub.access.canWatch(identity.userId) : hub.access?.isMember(identity.userId)) &&
      !(await (hub.access?.refreshWatch || hub.access?.refresh)?.(identity.userId))
    )
      return;
    const current = await rawLogin(req);
    return current?.userId === identity.userId && current?.accountRevision === identity.accountRevision
      ? current
      : undefined;
  }
  async function authorized(req, write = false) {
    const identity = await login(req);
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
