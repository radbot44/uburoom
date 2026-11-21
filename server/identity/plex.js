'use strict';
// @ts-check
const { randomUUID, sign } = require('node:crypto');
const { resilientFetch } = require('../resilience');

/** A Plex answer that refuses this credential (`revoked`) or the access asked for. */
class PlexAccessError extends Error {
  constructor(message, revoked = false) {
    super(message);
    this.revoked = revoked;
  }
}

/**
 * Plex sign-in: plex.tv proves which Plex account someone is (a PIN they approve at plex.tv) and
 * nothing about any server. Media sources reach plex.tv through the same client for what only
 * a source needs (its servers, renewing a stored sign-in); this file never reads sources.
 */
class PlexTv {
  /** @param {typeof fetch} [fetcher] */
  constructor(fetcher = fetch) {
    this.fetch = resilientFetch(fetcher, { timeoutMs: 10000 });
  }
  async request(resource, { token, clientId, method = 'GET', data } = {}) {
    const response = await this.fetch('https://clients.plex.tv/api/v2' + resource, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: 'application/json',
        'X-Plex-Product': 'uburoom',
        'X-Plex-Client-Identifier': clientId || 'uburoom-auth',
        ...(token ? { 'X-Plex-Token': token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok)
      throw new PlexAccessError(
        [401, 403, 498].includes(response.status)
          ? 'Plex authorization expired or was revoked'
          : 'Plex is temporarily unavailable; try again',
        [401, 403, 498].includes(response.status),
      );
    return response.json();
  }
  jwt(credential, claims = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url'),
      now = Math.floor(Date.now() / 1000);
    const payload = encode({
      aud: 'plex.tv',
      iss: credential.clientId,
      iat: now,
      exp: now + 300,
      scope: 'username,friendly_name,restricted',
      ...claims,
    });
    const input = encode({ kid: credential.kid, alg: 'EdDSA', typ: 'JWT' }) + '.' + payload;
    return input + '.' + sign(null, Buffer.from(input), credential.privateKey).toString('base64url');
  }
  async start(forwardUrl) {
    // PMS installations can reject JWT resource tokens despite accepting the
    // same account at plex.tv. Use Plex's documented traditional PIN flow.
    const clientId = randomUUID(),
      credential = { clientId, authType: 'traditional' };
    const pin = await this.request('/pins?strong=true', { clientId, method: 'POST' });
    if (!pin.id || typeof pin.code !== 'string') throw new Error('Plex sign-in could not start');
    const params = new URLSearchParams({
      clientID: clientId,
      code: pin.code,
      forwardUrl,
      'context[device][product]': 'uburoom',
    });
    return { credential, pinId: String(pin.id), url: 'https://app.plex.tv/auth#?' + params };
  }
  /** The plex.tv account a finished PIN belongs to; says nothing about any server. */
  async identify(attempt) {
    const { credential } = attempt,
      pin = await this.request(
        '/pins/' +
          encodeURIComponent(attempt.pinId) +
          (credential.privateKey ? '?deviceJWT=' + encodeURIComponent(this.jwt(credential)) : ''),
        { clientId: credential.clientId },
      );
    if (typeof pin.authToken !== 'string' || !pin.authToken)
      throw new Error('Plex sign-in was not completed; start again');
    credential.token = pin.authToken;
    if (credential.privateKey) credential.expires = Date.now() + 6 * 86400000;
    const profile = await this.request('/user', { token: credential.token, clientId: credential.clientId });
    if (!/^\d{1,20}$/.test(String(profile.id))) throw new Error('Plex account identity unavailable');
    const name = String(profile.username || profile.friendlyName || 'Plex user').slice(0, 100);
    return { subject: String(profile.id), name, credential };
  }
}

module.exports = { PlexTv, PlexAccessError };
