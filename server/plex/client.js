'use strict';
const { resilientFetch } = require('../resilience');
const { mediaIdentity } = require('../../shared/room-protocol.mjs');

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
  async json(resource, options) {
    return (await (await this.plex.request(resource, options)).json()).MediaContainer || {};
  }
  id(value) {
    const identity = mediaIdentity(String(value || ''));
    if (!identity) throw new Error('Invalid Plex item');
    return identity.id;
  }
}

module.exports = { PlexClient };
