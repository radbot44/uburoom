'use strict';
const { createHash } = require('node:crypto');
const { MediaPipeline } = require('./media-pipeline');
const { PlexClient } = require('./plex/client');
const { PlexAccess } = require('./plex/access');
const { PlexCatalog } = require('./plex/catalog');
const { PlexTranscode } = require('./plex/transcode');
const { PlexSessions } = require('./plex/sessions');

// One Plex server, seen through one token. The work is split by concern:
// client (HTTP to the configured server), access (what this token may see),
// catalog (browsing and availability), transcode (quality and track decisions)
// and sessions (preparing, confirming and stopping streams). Parts reach each
// other through this object, so a scope or a test can replace any method here.
//
// No arbitrary upstream URLs: callers select Plex IDs, and only Plex-produced
// media paths on the configured server are eligible for proxying.
class Plex {
  constructor(config, fetcher = fetch, { logger, pipeline } = {}, scoped) {
    if (scoped) {
      this.shared = scoped.shared;
      this.client = new PlexClient(this, scoped.client);
    } else {
      let base;
      if (config.plexUrl) {
        base = new URL(config.plexUrl);
        if (
          !['http:', 'https:'].includes(base.protocol) ||
          base.username ||
          base.password ||
          base.search ||
          base.hash ||
          base.pathname !== '/'
        )
          throw new Error('PLEX_URL must be an HTTP(S) origin');
      }
      this.client = new PlexClient(this, { fetcher, token: config.plexToken, base, principal: 'discord-shared' });
      // State every scope shares: the pipeline streams play through, Plex sessions and
      // their part locks. A Plex built without a pipeline owns one and closes it.
      this.shared = {
        root: this,
        pipeline: pipeline || new MediaPipeline(config, { logger }),
        ownsPipeline: !pipeline,
        partQueues: new Map(),
        /** @type {Map<string,{context:any,at:number,stoppedAt?:number}>} Plex transcode sessions uburoom started */
        sessions: new Map(),
      };
    }
    this.scopes = new Map();
    this.access = new PlexAccess(this);
    this.catalogs = new PlexCatalog(this, this.shared.pipeline.cacheBudget);
    this.transcode = new PlexTranscode(this);
    this.lifecycle = new PlexSessions(this, this.shared);
  }
  get kind() {
    return 'plex';
  }
  get configured() {
    return this.client.configured;
  }
  get rawFetch() {
    return this.client.rawFetch;
  }
  get fetch() {
    return this.client.fetch;
  }
  get token() {
    return this.client.token;
  }
  get base() {
    return this.client.base;
  }
  get principal() {
    return this.client.principal;
  }
  get clientId() {
    return this.client.clientId;
  }
  get pipeline() {
    return this.shared.pipeline;
  }
  /** The scope holding the configured server token. */
  get root() {
    return this.shared.root;
  }
  get sessions() {
    return this.shared.sessions;
  }
  get partQueues() {
    return this.shared.partQueues;
  }
  get allowedItems() {
    return this.access.allowedItems;
  }
  get fileCache() {
    return this.catalogs.fileCache;
  }
  get catalogCache() {
    return this.catalogs.catalogCache;
  }
  get artSources() {
    return this.catalogs.artSources;
  }
  get imageCache() {
    return this.catalogs.imageCache;
  }
  get randomCache() {
    return this.catalogs.randomCache;
  }
  get itemChecks() {
    return this.access.itemChecks;
  }
  scope(token, principal) {
    const key = principal + ':' + createHash('sha256').update(token).digest('hex');
    let scoped = this.scopes.get(key);
    if (!scoped) {
      scoped = new Plex(undefined, undefined, undefined, {
        shared: this.shared,
        client: { fetcher: this.rawFetch, token, base: this.base, clientId: principal, principal: key },
      });
      this.scopes.set(key, scoped);
      if (this.scopes.size > 64) this.scopes.delete(this.scopes.keys().next().value);
    }
    return scoped;
  }
  // Client
  url(resource) {
    return this.client.url(resource);
  }
  request(resource, options) {
    return this.client.request(resource, options);
  }
  json(resource, options) {
    return this.client.json(resource, options);
  }
  id(value) {
    return this.client.id(value);
  }
  // Access
  allows(id) {
    return this.access.allows(id);
  }
  visible(id, type) {
    return this.access.visible(id, type);
  }
  invalidateAccess() {
    return this.access.invalidateAccess();
  }
  checkItem(key, resource, accepts) {
    return this.access.checkItem(key, resource, accepts);
  }
  // Catalog
  cached(...args) {
    return this.catalogs.cached(...args);
  }
  catalog(resource) {
    return this.catalogs.catalog(resource);
  }
  availability(...args) {
    return this.catalogs.availability(...args);
  }
  cachedAvailability(items) {
    return this.catalogs.cachedAvailability(items);
  }
  checkedItems(...args) {
    return this.catalogs.checkedItems(...args);
  }
  playableItem(id) {
    return this.catalogs.playableItem(id);
  }
  allItems(...args) {
    return this.catalogs.allItems(...args);
  }
  queueItems(...args) {
    return this.catalogs.queueItems(...args);
  }
  shuffle(items, seed) {
    return this.catalogs.shuffle(items, seed);
  }
  browse(options) {
    return this.catalogs.browse(options);
  }
  filters(section) {
    return this.catalogs.filters(section);
  }
  details(id, type) {
    return this.catalogs.details(id, type);
  }
  artwork(...args) {
    return this.catalogs.artwork(...args);
  }
  items(items) {
    return this.catalogs.items(items);
  }
  subtitle(item) {
    return this.catalogs.subtitle(item);
  }
  neighbors(item) {
    return this.catalogs.neighbors(item);
  }
  nextEpisodeOffer(episodeMediaId) {
    return this.catalogs.nextEpisodeOffer(episodeMediaId);
  }
  // Transcode decision
  maxTranscodeQuality() {
    return this.transcode.maxTranscodeQuality();
  }
  transcodeParams(options) {
    return this.transcode.transcodeParams(options);
  }
  startDecision(media, quality) {
    return this.transcode.startDecision(media, quality);
  }
  selectAudioForTranscode(media, choices) {
    return this.transcode.selectAudioForTranscode(media, choices);
  }
  videoConversionDisabled() {
    return this.transcode.videoConversionDisabled();
  }
  selectSubtitleForBurn(media, choices) {
    return this.transcode.selectSubtitleForBurn(media, choices);
  }
  // Session lifecycle
  prepare(...args) {
    return this.lifecycle.prepare(...args);
  }
  source(...args) {
    return this.lifecycle.source(...args);
  }
  startTranscode(...args) {
    return this.lifecycle.startTranscode(...args);
  }
  sessionHeaders(media, options) {
    return this.lifecycle.sessionHeaders(media, options);
  }
  confirmStarted(media, manifest) {
    return this.lifecycle.confirmStarted(media, manifest);
  }
  withPartLock(id, action) {
    return this.lifecycle.withPartLock(id, action);
  }
  stop(media) {
    return this.lifecycle.stop(media);
  }
  stopOwned(media) {
    return this.lifecycle.stopOwned(media);
  }
  reconcileSessions(...args) {
    return this.lifecycle.reconcileSessions(...args);
  }
  ping(media) {
    return this.lifecycle.ping(media);
  }
  close() {
    for (const scope of [this, ...this.scopes.values()]) {
      for (const task of scope.access.itemChecks?.values() || []) task.abort();
      const { fileCache, catalogCache, imageCache, randomCache, artSources } = scope.catalogs;
      for (const cache of [fileCache, catalogCache, imageCache, randomCache]) {
        for (const entry of cache.values()) entry.task?.abort();
        cache.clear();
      }
      artSources.clear();
    }
    return this.shared.ownsPipeline ? this.pipeline.close() : Promise.resolve();
  }
}

module.exports = { Plex };
