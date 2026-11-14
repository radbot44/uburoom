'use strict';
const { CacheBudget } = require('./cache-budget');
const { createHash } = require('node:crypto');
const { QUALITIES } = require('../shared/engine.mjs');
const { AV1 } = require('./av1');
const { HLSPool } = require('./hls-pool');
const { ConversionPolicy } = require('./transcoding-policy');
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
  constructor(config, fetcher = fetch, { logger } = {}, scoped) {
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
      // State every scope shares: conversions, Plex sessions and their part locks.
      this.shared = {
        cacheBudget: new CacheBudget(),
        partQueues: new Map(),
        /** @type {Map<string,{context:any,at:number,stoppedAt?:number}>} Plex transcode sessions uburoom started */
        sessions: new Map(),
        qualityOptions: config.transcoding?.qualities || QUALITIES,
        hlsPool: new HLSPool(media => (media.plexContext || this).stop(media)),
      };
      this.shared.av1 = new AV1(this, config, undefined, logger);
      this.shared.conversionPolicy = new ConversionPolicy(config.transcoding, this);
      this.shared.av1.conversionPolicy = this.shared.conversionPolicy;
    }
    this.scopes = new Map();
    this.access = new PlexAccess(this);
    this.catalogs = new PlexCatalog(this, this.shared.cacheBudget);
    this.transcode = new PlexTranscode(this);
    this.lifecycle = new PlexSessions(this, this.shared);
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
  get av1() {
    return this.shared.av1;
  }
  get hlsPool() {
    return this.shared.hlsPool;
  }
  get sessions() {
    return this.shared.sessions;
  }
  get partQueues() {
    return this.shared.partQueues;
  }
  get conversionPolicy() {
    return this.shared.conversionPolicy;
  }
  get qualityOptions() {
    return this.shared.qualityOptions;
  }
  get cacheBudget() {
    return this.shared.cacheBudget;
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
  qualities(media) {
    return this.transcode.qualities(media);
  }
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
  usableOutputs(localCodecs) {
    return this.transcode.usableOutputs(localCodecs);
  }
  selectSubtitleForBurn(media, choices) {
    return this.transcode.selectSubtitleForBurn(media, choices);
  }
  // Session lifecycle
  prepare(...args) {
    return this.lifecycle.prepare(...args);
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
    this.cacheBudget.clear();
    return Promise.all([this.hlsPool.close(), this.av1.close()]);
  }
}

module.exports = { Plex };
