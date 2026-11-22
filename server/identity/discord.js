'use strict';
const { randomBytes } = require('node:crypto');
const { hash } = require('../core');

/**
 * Discord sign-in: the authorization attempts in flight and the redirect that starts one.
 * @param {{config: any, demo?: () => any, sessions: any, authorizeUrl: string}} services - `demo` is the
 *   isolated demo's stand-in provider, when one is running.
 */
function createDiscordSignIn({ config, demo = () => undefined, sessions, authorizeUrl }) {
  const { COOKIES, cookie, cookies, json } = sessions;
  const states = new Map();
  async function start(req, res, linkLogin, ownerOnly = false, returnTo = undefined) {
    if (config.accessPolicy && !config.accessPolicy.discord && !ownerOnly)
      throw new Error('Discord authorization is disabled');
    const state = randomBytes(32).toString('hex');
    states.set(state, {
      expires: Date.now() + 300000,
      ownerOnly,
      returnTo,
      ...(linkLogin
        ? {
            linkUserId: linkLogin.userId,
            sourceHash: hash(cookies(req)[COOKIES.session] || ''),
            revision: linkLogin.accountRevision,
          }
        : {}),
    });
    const query = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.publicUrl + '/auth/callback',
      response_type: 'code',
      scope: 'identify',
      state,
    });
    res.setHeader('Set-Cookie', cookie(COOKIES.oauth, state, 300));
    const destination =
      config.demo && demo() ? config.publicUrl + '/demo-discord?state=' + state : authorizeUrl + '?' + query;
    if (linkLogin) json(res, 200, { url: destination });
    else {
      res.writeHead(302, { Location: destination });
      res.end();
    }
  }
  /** Takes the attempt a callback names; each attempt works once. */
  const take = state => {
    const attempt = states.get(state);
    states.delete(state);
    return attempt;
  };
  const sweep = () => {
    for (const [id, attempt] of states) if (attempt.expires <= Date.now()) states.delete(id);
  };
  /**
   * The Discord account an authorization code belongs to, and its refresh grant when Discord gives
   * one. Proves who someone is; whether they get in is admission's decision.
   * @param {string} code
   * @param {(url: string, options?: any) => Promise<any>} discordFetch
   */
  async function exchange(code, discordFetch) {
    const token = await discordFetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.publicUrl + '/auth/callback',
      }),
    });
    const identity = await discordFetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + token.access_token },
    });
    const name = String(identity.username || identity.global_name || 'Discord user').slice(0, 100);
    const oauth =
      typeof token.refresh_token === 'string' && Number.isFinite(token.expires_in) && token.expires_in > 0
        ? { refreshToken: token.refresh_token, expires: Date.now() + token.expires_in * 1000 }
        : undefined;
    return { id: String(identity.id), name, oauth };
  }
  return { start, take, sweep, exchange };
}

module.exports = { createDiscordSignIn };
