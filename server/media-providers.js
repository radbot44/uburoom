'use strict';
const { QUALITIES } = require('../shared/engine.mjs');

const failure = (message, status = 409) => Object.assign(new Error(message), { status });

/**
 * The media providers this server is configured with. Rooms, queues and viewer
 * streams reach a provider only through here, addressed by the server id stored
 * with every queue entry and bookmark. Plex is the only provider today, so a
 * request that names no server gets it.
 *
 * @typedef {Object} MediaProvider
 * @property {string} kind
 * @property {any} root - The provider seen with its configured credential.
 * @property {() => Promise<string>} identity - The stable server id media from this provider is recorded under.
 * @property {(actor: any) => Promise<import('./media-provider').ProviderScope>} scopeFor
 *   The provider as this person may use it; refuses rather than widening access.
 */
class MediaProviders {
  /** @param {MediaProvider[]} [list] */
  constructor(list = []) {
    this.list = list;
  }
  get primary() {
    return this.list[0];
  }
  get configured() {
    return this.list.some(provider => provider.root?.configured);
  }
  /** The provider recorded under a server id. */
  async select(serverId) {
    if (serverId === undefined) {
      if (!this.primary) throw new Error('No media provider is configured');
      return this.primary;
    }
    for (const provider of this.list) if ((await provider.identity()) === serverId) return provider;
    throw failure('This media belongs to a server that is no longer configured');
  }
  /** The provider, as this person may use it. */
  async for(actor, serverId) {
    return (await this.select(serverId)).scopeFor(actor);
  }
  /** The server id media is recorded under. The built-in demo is not a provider. */
  async identify(media) {
    if (media?.id === 'demo' || media?.mediaId === 'demo') return 'local-demo';
    return ((media?.provider && this.owner(media.provider)) || (await this.select())).identity();
  }
  /** The configured provider a scope belongs to. */
  owner(scope) {
    return this.list.find(provider => provider.root === scope || provider.root === scope?.root);
  }
  /** Whoever prepared a media object releases it; one that no provider prepared holds only pipeline state. */
  stop(media) {
    return (media?.provider || this.primary?.root)?.stop(media);
  }
  ping(media) {
    return (media?.provider || this.primary?.root)?.ping?.(media);
  }
  qualities(media) {
    return (media?.provider || this.primary?.root)?.qualities?.(media) || QUALITIES;
  }
  /** End provider transcodes uburoom started and no longer holds; each provider reports under its kind. */
  async reconcileSessions(inUse) {
    const reports = {};
    for (const provider of this.list)
      if (provider.root?.reconcileSessions) reports[provider.kind] = await provider.root.reconcileSessions(inUse);
    return reports;
  }
  close() {
    return Promise.all(this.list.map(provider => provider.root?.close?.()));
  }
}

module.exports = { MediaProviders };
