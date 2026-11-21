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
 * @property {string} kind - The kind of media it prepares (plex, jellyfin, local).
 * @property {string} [id] - The `sources:` entry it was built from; set by server/sources.
 * @property {string} [type] - That entry's source type.
 * @property {string} [label] - That entry's optional name.
 * @property {any} root - The provider seen with its configured credential.
 * @property {() => Promise<string>} identity - The stable server id media from this provider is recorded under.
 * @property {string} [serverName] - The name the server gives itself (Plex's "VIGRID"), once `identity()` has
 *   answered; shown on its libraries' cards. Absent for a provider with no server of its own.
 * @property {(actor: any) => Promise<import('./media-provider').ProviderScope>} scopeFor
 *   The provider as this person may use it; refuses rather than widening access.
 * @property {(services: {hub: any, now: () => number, authorize: (room: any, viewer: any) => Promise<boolean>}) => any} [reporting]
 *   Builds what reports a viewer's playback back to this provider; absent when it takes no reports.
 * @property {any} [direct]
 *   Lets a viewer fetch media straight from this provider's server with a credential of
 *   their own: `file`, `hlsPlan` and `deliveryOrigins`. Absent when it has no such path.
 */

/** Two sources report the same server identity. */
function duplicate(providers) {
  const names = providers.map(provider => provider.id || provider.kind).join(' and ');
  return failure(`Sources ${names} report the same server; keep one of them in sources`, 503);
}

/** A server's own name as it reports it, made safe to show: one line, at most 60 characters. */
function serverName(value) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, 60)
    : '';
}

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
  /** Whether viewers may opt in to personal watch-state sync for this media (or, with none, for any source). */
  watchStateAllowed(media) {
    return this.reporters.some(reporter => reporter.watchStateAllowed?.(media));
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

/** Media recorded under a server no configured source answers for. Kept, never deleted; it plays again once that server is back. */
const unavailable = () =>
  Object.assign(failure("This media's source is unavailable: it is not configured on this server"), {
    unavailable: true,
  });

/**
 * What a request that names no server reaches on an installation with no sources (the built-in demo
 * still plays): a scope with nothing in it that refuses every item.
 */
function noSource(pipeline) {
  const none = () => Promise.reject(failure('No media source is configured', 404));
  const root = {
    kind: 'none',
    configured: false,
    principal: 'none',
    pipeline,
    get root() {
      return root;
    },
    browse: async () => ({ items: [], total: 0, offset: 0, nextOffset: null }),
    filters: async () => ({ genres: [], years: [] }),
    details: none,
    playableItem: none,
    // Says nothing about any item, the built-in demo included.
    availability: async () => new Map(),
    queueItems: async () => [],
    artwork: none,
    allows: async () => false,
    visible: async () => false,
    url: () => {
      throw failure('No media source is configured', 404);
    },
    request: none,
    prepare: none,
    source: none,
    stop: async () => {},
  };
  return {
    kind: 'none',
    root,
    identity: () => Promise.reject(failure('No media source is configured', 404)),
    scopeFor: async () => root,
  };
}

class MediaProviders {
  /** @param {MediaProvider[]} [list] @param {any} [pipeline] - What every provider plays through. */
  constructor(list = [], pipeline) {
    // With no source configured, requests that name no server reach an empty one (the demo still plays).
    this.list = list.length ? list : [noSource(pipeline)];
    this.pipeline = pipeline;
    /** @type {Map<MediaProvider, boolean>} Whether each source's last identity check answered. */
    this.answered = new Map();
  }
  /** A provider's identity, remembering whether it answered for the source list's availability. */
  async identityOf(provider) {
    try {
      const id = await provider.identity();
      this.answered.set(provider, true);
      return id;
    } catch (error) {
      this.answered.set(provider, false);
      throw error;
    }
  }
  /**
   * Every configured source for the page: id, name, type and whether it is available (its server
   * last answered, or has not been asked yet). Never a credential, address or path.
   */
  summary() {
    return this.list
      .filter(provider => provider.id)
      .map(provider => ({
        id: provider.id,
        name: provider.label || provider.serverName || provider.id,
        type: provider.type,
        available: !!provider.root?.configured && this.answered.get(provider) !== false,
      }));
  }
  /** The provider a request reaches by naming no server: the first one that is configured. */
  get primary() {
    return this.list.find(provider => provider.root?.configured) || this.list[0];
  }
  get configured() {
    return this.list.some(provider => provider.root?.configured);
  }
  /**
   * The provider that answers for a server id. A provider that cannot say who it is right now must
   * not hide the ones that can. Two sources answering for the same server are a configuration
   * error, refused rather than guessed between: their media would be one server's twice.
   */
  async find(serverId) {
    let unanswered;
    const found = [];
    for (const provider of this.list) {
      try {
        if ((await this.identityOf(provider)) === serverId) found.push(provider);
      } catch (error) {
        // One that is not set up has no id to give; that is not a failure to answer.
        if (provider.root?.configured !== false) unanswered ||= error;
      }
    }
    if (found.length > 1) throw duplicate(found);
    if (found.length) return found[0];
    if (unanswered) throw unanswered;
  }
  /** Asks every source who it is and refuses two that report the same server (startup and the doctor). */
  async verify() {
    const seen = new Map();
    for (const provider of this.list) {
      let id;
      try {
        id = await this.identityOf(provider);
      } catch {
        continue;
      }
      if (seen.has(id)) throw duplicate([seen.get(id), provider]);
      seen.set(id, provider);
    }
  }
  /** The provider recorded under a server id. */
  async select(serverId) {
    if (serverId === undefined || serverId === null || serverId === '' || serverId === DEMO_SERVER) {
      if (!this.primary) throw new Error('No media provider is configured');
      return this.primary;
    }
    const provider = await this.find(serverId);
    if (!provider) throw unavailable();
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
  /** Whether a server id names a configured source that answers for it now. */
  async available(serverId) {
    try {
      return !!(await this.find(serverId));
    } catch {
      return false;
    }
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
          serverId = await this.identityOf(provider).catch(error => {
            if (!first) throw error;
          });
        const scope = await scopeFor(actor, first ? undefined : serverId);
        // Each library names the kind and name of the source it is on, for its card on Libraries home.
        const name = provider.label || provider.serverName;
        const server = {
          serverKind: provider.kind,
          ...(provider.id ? { sourceId: provider.id } : {}),
          ...(name ? { serverName: name } : {}),
        };
        for (const item of (await scope.browse({})).items || [])
          items.push(serverId ? { ...item, serverId, ...server } : { ...item, ...server });
      } catch (error) {
        unanswered ||= error;
      }
    }
    if (unanswered && !items.length) throw unanswered;
    return { items, total: items.length, offset: 0, nextOffset: null };
  }
  /**
   * The Media Home rows for one viewer: Continue watching from providers that know this viewer's own progress,
   * and Recently added from every provider that lists it, newest first. Each item names its server.
   */
  async shelves(actor, scopeFor = (person, serverId) => this.for(person, serverId)) {
    const continueWatching = [],
      recentlyAdded = [];
    for (const provider of this.list) {
      if (!provider.root?.configured) continue;
      try {
        const first = provider === this.primary,
          serverId = await this.identityOf(provider).catch(error => {
            if (!first) throw error;
          });
        const named = item => (serverId ? { ...item, serverId } : item);
        const scope = await scopeFor(actor, first ? undefined : serverId);
        if (provider.continueWatching) continueWatching.push(...(await provider.continueWatching(actor)).map(named));
        if (scope.recentlyAdded) recentlyAdded.push(...(await scope.recentlyAdded()).map(named));
      } catch {
        // A server that cannot answer leaves its items out; the rest still show.
      }
    }
    recentlyAdded.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return { continueWatching: continueWatching.slice(0, 20), recentlyAdded: recentlyAdded.slice(0, 20) };
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
    if (Array.isArray(media?.qualities) && media.qualities.length) return media.qualities;
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
  /** Extra CSP script/frame origins and referrer policy needed by configured embedded players. */
  embedPolicy() {
    const scriptSrc = new Set();
    const frameSrc = new Set();
    let referrerPolicy;
    for (const provider of this.list) {
      const policy = provider.embedPolicy;
      if (!provider.root?.configured || !policy) continue;
      for (const origin of policy.scriptSrc || []) scriptSrc.add(origin);
      for (const origin of policy.frameSrc || []) frameSrc.add(origin);
      if (policy.referrerPolicy) referrerPolicy = policy.referrerPolicy;
    }
    return { scriptSrc: [...scriptSrc], frameSrc: [...frameSrc], referrerPolicy };
  }
  /** End provider transcodes uburoom started and no longer holds; each provider reports under its kind. */
  async reconcileSessions(inUse) {
    const reports = {};
    for (const provider of this.list)
      if (provider.root?.configured && provider.root.reconcileSessions)
        reports[provider.id || provider.kind] = await provider.root.reconcileSessions(inUse);
    return reports;
  }
  close() {
    return Promise.all(this.list.map(provider => provider.root?.close?.()));
  }
}

module.exports = { MediaProviders, serverName };
