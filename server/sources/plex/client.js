'use strict';
const { resilientFetch } = require('../../resilience');
const { plexIdentity } = require('./identity');
const { libraryOff } = require('../libraries');

// The Plex HTTP client for one token: resource URLs on the configured server only, and
// authenticated requests. Each access scope has its own client.
class PlexClient {
  constructor(plex, { fetcher, token, base, clientId, principal }) {
    this.plex = plex;
    this.rawFetch = fetcher;
    this.fetch = resilientFetch(fetcher);
    this.token = token;
    this.base = base;
    this.clientId = clientId;
    this.principal = principal;
  }
  get configured() {
    return !!this.base && !!this.token;
  }
  url(resource) {
    if (!this.plex.configured)
      throw new Error('Configure plex.url and plex.token in private config.yaml; never share this file');
    const url = new URL(resource, this.base);
    if (url.origin !== this.base.origin || url.username || url.password) throw new Error('Invalid Plex resource');
    url.searchParams.delete('X-Plex-Token');
    return url;
  }
  async request(resource, options = {}) {
    const url = this.plex.url(resource);
    const response = await this.fetch(url, {
      ...options,
      redirect: 'manual',
      signal: options.signal || (options.streaming ? undefined : AbortSignal.timeout(12000)),
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': this.token,
        'X-Plex-Product': 'uburoom',
        'X-Plex-Client-Identifier':
          url.searchParams.get('X-Plex-Client-Identifier') ||
          url.searchParams.get('session') ||
          this.clientId ||
          'uburoom-watch',
        'X-Plex-Platform': 'Firefox',
        ...options.headers,
      },
    });
    if (!response.ok && response.status !== 206) {
      void response.body?.cancel().catch(() => {});
      const error = new Error(
        `Plex server request failed (HTTP ${response.status}); check server access and playback support`,
      );
      error.status = response.status;
      throw error;
    }
    return response;
  }
  /** What Plex answered, whatever library it is in. Only for the operator choosing libraries. */
  async rawJson(resource, options) {
    return (await (await this.plex.request(resource, options)).json()).MediaContainer || {};
  }
  /**
   * What Plex answered, seen through the libraries this source offers. Every catalog, access and
   * playback read goes through here, so a library that is off is unreachable by any of them.
   */
  async json(resource, options) {
    const container = await this.rawJson(resource, options);
    const offered = this.plex.shared?.libraries;
    return offered ? offeredOnly(container, new URL(resource, this.base).pathname, offered) : container;
  }
  id(value) {
    const identity = plexIdentity(String(value || ''));
    if (!identity) throw new Error('Invalid Plex item');
    return identity.id;
  }
}

/**
 * A Plex answer with only the offered libraries' parts: the library list keeps offered sections, a
 * section's own resources are refused when it is off, and items from a section that is off are left
 * out (an item names its section, or the answer does for all its items). A request for one item or
 * collection that is left with nothing is refused as unavailable, so its error says why.
 * @param {any} container
 * @param {string} pathname
 * @param {Set<string>} offered
 */
function offeredOnly(container, pathname, offered) {
  const on = section => section === undefined || section === null || offered.has(String(section));
  if (pathname === '/library/sections')
    return {
      ...container,
      Directory: (container.Directory || []).filter(section => offered.has(String(section?.key))),
    };
  const section = /^\/library\/sections\/([^/]+)\//.exec(pathname + '/')?.[1];
  if (section !== undefined && !on(section)) throw libraryOff();
  if (!Array.isArray(container.Metadata)) return container;
  const kept = container.Metadata.filter(item => on(item?.librarySectionID ?? container.librarySectionID));
  if (kept.length === container.Metadata.length) return container;
  if (!kept.length && /^\/library\/(metadata|collections)\/\d{1,20}(\/|$)/.test(pathname)) throw libraryOff();
  return { ...container, Metadata: kept, size: kept.length };
}

module.exports = { PlexClient, offeredOnly };
