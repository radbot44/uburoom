'use strict';
// @ts-check
// A small Jellyfin HTTP client for calls made as someone: the source's API key, a person's own
// token, or nobody (before sign-in). Media and catalog calls stay in ./provider.js.
const { createHash } = require('node:crypto');
const { resilientFetch } = require('../../resilience');
const { version } = require('../../../package.json');

const GUID = /^[a-f0-9]{32}$/i;
const DASHED = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** A Jellyfin id (user, server, item) in one form: 32 lowercase hex digits, or undefined. */
function jellyfinId(value) {
  if (typeof value !== 'string') return undefined;
  const plain = DASHED.test(value) ? value.replaceAll('-', '') : value;
  return GUID.test(plain) ? plain.toLowerCase() : undefined;
}

/** The identity provider name for people signed in to one Jellyfin server. */
const jellyfinIdentityProvider = (/** @type {string} */ serverId) => 'jellyfin:' + serverId;

/**
 * A Jellyfin base address as uburoom keeps it: origin and base path, no trailing slash.
 * @param {unknown} value
 */
function baseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw Object.assign(new Error('Use the Jellyfin server address, such as http://192.168.1.10:8096'), {
      code: 'JELLYFIN_URL',
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Object.assign(new Error('Use an http or https address without a user name or password'), {
      code: 'JELLYFIN_URL',
    });
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * One install-wide device id per server address and purpose. Jellyfin ends a user's earlier session
 * on the same device when they sign in again, so each purpose (people, setup) gets its own.
 * @param {string} url
 * @param {string} [purpose]
 */
const deviceId = (url, purpose = '') =>
  'uburoom-' +
  createHash('sha256')
    .update(String(url) + (purpose ? '\n' + purpose : ''))
    .digest('hex')
    .slice(0, 16);

/**
 * @param {{url: string, fetcher?: typeof fetch, device?: string}} options
 */
function jellyfinClient({ url, fetcher = fetch, device }) {
  const base = new URL(baseUrl(url) + '/');
  const fetchSafe = resilientFetch(fetcher);
  const id = device || deviceId(base.href);
  /**
   * @param {string} path - inside the server's base path, without a leading slash
   * @param {{method?: string, query?: Record<string, any>, body?: any, token?: string, signal?: AbortSignal,
   *   timeoutMs?: number}} [options]
   * @returns {Promise<any>} the parsed JSON answer, or undefined for an empty one
   */
  async function request(path, { method = 'GET', query = {}, body, token, signal, timeoutMs = 12000 } = {}) {
    const target = new URL(path, base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
      throw new Error('Invalid Jellyfin resource');
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value));
    const headers = {
      Accept: 'application/json',
      Authorization:
        `MediaBrowser Client="uburoom", Device="uburoom", DeviceId="${id}", Version="${version}"` +
        (token ? `, Token="${token}"` : ''),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    let response;
    try {
      response = await fetchSafe(target, {
        method,
        headers,
        redirect: 'manual',
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // No answer: the server is down, unreachable or too slow. Never a denial.
      throw Object.assign(new Error('The Jellyfin server did not answer'), {
        status: error?.status || 503,
        unanswered: true,
        cause: error,
      });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`Jellyfin answered HTTP ${response.status}`), {
        status: response.status,
        unanswered: response.status >= 500 || response.status === 429,
      });
    }
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Jellyfin sent an answer uburoom cannot read'), { status: 502, unanswered: true });
    }
  }
  return { base: base.href.replace(/\/$/, ''), device: id, request };
}

module.exports = { jellyfinClient, jellyfinId, jellyfinIdentityProvider, baseUrl, deviceId };
