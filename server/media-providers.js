'use strict';
const { QUALITIES } = require('../shared/engine.mjs');
const { runOperation } = require('./operation');

const failure = (message, status = 409) => Object.assign(new Error(message), { status });
/** What the built-in demo is recorded under. It is not a provider, so it names no server. */
const DEMO_SERVER = 'local-demo';

/**
 * The media providers this server is configured with. Rooms, queues and viewer
 * streams reach a provider only through here, addressed by the server id stored
 * with every queue entry, bookmark and prepared media object. Only a request that
 * has no media yet, such as opening the library, may name no server; it gets the
 * first one that is configured.
 *
 * @typedef {Object} MediaProvider
 * @property {string} kind
 * @property {any} root - The provider seen with its configured credential.
 * @property {() => Promise<string>} identity - The stable server id media from this provider is recorded under.
 * @property {(actor: any) => Promise<import('./media-provider').ProviderScope>} scopeFor
 *   The provider as this person may use it; refuses rather than widening access.
 * @property {(services: {hub: any, now: () => number, authorize: (room: any, viewer: any) => Promise<boolean>}) => any} [reporting]
 *   Builds what reports a viewer's playback back to this provider; absent when it takes no reports.
 * @property {any} [direct]
 *   Lets a viewer fetch media straight from this provider's server with a credential of
 *   their own: `file`, `hlsPlan` and `deliveryOrigins`. Absent when it has no such path.
 */

/** Playback reports, sent to every provider that takes them; each ignores media that is not its own. */
class ProviderReporting {
  constructor(reporters) {
    this.reporters = reporters;
  }
  each(method, args) {
    return Promise.all(this.reporters.map(reporter => reporter[method](...args)));
  }
  isEligible(userId) {
    return this.reporters.some(reporter => reporter.isEligible(userId));
  }
  reconnect(...args) {
    for (const reporter of this.reporters) reporter.reconnect(...args);
  }
  updateConsent(...args) {
    for (const reporter of this.reporters) reporter.updateConsent(...args);
  }
  observe(...args) {
    return this.each('observe', args);
  }
  end(...args) {
    return this.each('end', args);
  }
  endViewer(...args) {
    return this.each('endViewer', args);
  }
  endRoom(...args) {
    return this.each('endRoom', args);
  }
  close() {
    return this.each('close', []);
  }
}

class MediaProviders {
  /** @param {MediaProvider[]} [list] @param {any} [pipeline] - What every provider plays through. */
  constructor(list = [], pipeline) {
    this.list = list;
    this.pipeline = pipeline;
  }
  /** The provider a request reaches by naming no server: the first one that is configured. */
  get primary() {
    return this.list.find(provider => provider.root?.configured) || this.list[0];
  }
  get configured() {
    return this.list.some(provider => provider.root?.configured);
  }
  // A provider that cannot say who it is right now must not hide the ones that can.
  async find(serverId) {
    let unanswered;
    for (const provider of this.list) {
      try {
        if ((await provider.identity()) === serverId) return provider;
      } catch (error) {
        // One that is not set up has no id to give; that is not a failure to answer.
        if (provider.root?.configured !== false) unanswered ||= error;
      }
    }
    if (unanswered) throw unanswered;
  }
  /** The provider recorded under a server id. */
  async select(serverId) {
    if (serverId === undefined || serverId === null || serverId === '' || serverId === DEMO_SERVER) {
      if (!this.primary) throw new Error('No media provider is configured');
      return this.primary;
    }
    const provider = await this.find(serverId);
    if (!provider) throw failure('This media belongs to a server that is no longer configured');
    return provider;
  }
  /** The provider, as this person may use it. */
  async for(actor, serverId) {
    return (await this.select(serverId)).scopeFor(actor);
  }
  /**
   * The server id media is recorded under: the provider that prepared it, else the
   * server it already names. The built-in demo is not a provider.
   */
  async identify(media) {
    if (media?.id === 'demo' || media?.mediaId === 'demo') return DEMO_SERVER;
    const owner = media?.provider && this.owner(media.provider);
    return (owner || (await this.select(media?.roomServerId ?? media?.serverId))).identity();
  }
  /** Whether a saved reference still names a server configured here. */
  async recorded(saved) {
    if (saved?.mediaId === 'demo') return saved.serverId === DEMO_SERVER;
    return !!saved?.serverId && !!(await this.find(saved.serverId));
  }
  /** The configured provider a scope belongs to. */
  owner(scope) {
    return this.list.find(provider => provider.root === scope || provider.root === scope?.root);
  }
  /**
   * The libraries of every configured provider this person may use, each naming its
   * server. A provider that cannot answer leaves its libraries out rather than
   * hiding the others'; with a single provider its failure is the answer.
   */
  async libraries(actor, scopeFor = (person, serverId) => this.for(person, serverId)) {
    const items = [];
    let unanswered;
    for (const provider of this.list) {
      if (!provider.root?.configured) continue;
      try {
        // The first provider is the one a request reaches by naming no server, so its
        // libraries stay listed even while it cannot say which server it is.
        const first = provider === this.primary,
          serverId = await provider.identity().catch(error => {
            if (!first) throw error;
          });
        const scope = await scopeFor(actor, first ? undefined : serverId);
        for (const item of (await scope.browse({})).items || []) items.push(serverId ? { ...item, serverId } : item);
      } catch (error) {
        unanswered ||= error;
      }
    }
    if (unanswered && !items.length) throw unanswered;
    return { items, total: items.length, offset: 0, nextOffset: null };
  }
  /** Whoever prepared a media object releases it; one that no provider prepared holds only pipeline state. */
  stop(media) {
    if (media?.provider) return media.provider.stop(media);
    return runOperation(undefined, async () => this.pipeline?.release(media));
  }
  /** Keep a provider's own transcode alive; media without one has nothing to keep. */
  ping(media) {
    return media?.provider?.ping?.(media);
  }
  /** The qualities offered for a video, which the pipeline decides from its source. */
  qualities(media) {
    return this.pipeline?.qualities(media) || QUALITIES;
  }
  /** What reports playback back to the providers that take reports. */
  reporting(services) {
    return new ProviderReporting(this.list.filter(provider => provider.reporting).map(p => p.reporting(services)));
  }
  /**
   * An address the viewer can fetch this file from directly. Undefined, with nothing
   * asked of anyone, when its provider has no direct path or the owner left it off.
   */
  directFile(media, auth, valid, remoteAddress) {
    const direct = this.owner(media?.provider)?.direct;
    return direct?.enabled ? direct.file(media, auth, valid, remoteAddress) : undefined;
  }
  /** Where and with what credential this viewer may fetch the provider's own HLS directly. */
  directPlan(scope, viewer, room, valid) {
    const direct = this.owner(scope)?.direct;
    return direct?.enabled ? direct.hlsPlan(scope, viewer, room, valid) : undefined;
  }
  /** Every origin a page may be sent to for direct delivery; the player's security policy names them. */
  async directOrigins(remoteAddress) {
    const origins = [];
    for (const { direct } of this.list)
      if (direct?.enabled) origins.push(...((await direct.deliveryOrigins(remoteAddress)) || []));
    return origins;
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
