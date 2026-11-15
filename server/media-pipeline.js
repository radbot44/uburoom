'use strict';
const { QUALITIES } = require('../shared/engine.mjs');
const { AV1 } = require('./av1');
const { CacheBudget } = require('./cache-budget');
const { HLSPool } = require('./hls-pool');
const { ConversionPolicy } = require('./transcoding-policy');

// What every media provider plays through: local conversion, pooled provider HLS,
// the shared conversion capacity and the offered qualities. One per server, owned
// by the application rather than by any provider. A provider only supplies sources
// and, where it can, its own transcodes; each prepared media object names the
// provider that answers for it (see server/media-provider.js).
class MediaPipeline {
  /** @param {any} [config] @param {{logger?: any, execute?: Function}} [options] */
  constructor(config = {}, { logger, execute } = {}) {
    this.cacheBudget = new CacheBudget();
    this.qualityOptions = config.transcoding?.qualities || QUALITIES;
    this.conversionPolicy = new ConversionPolicy(config.transcoding);
    this.av1 = new AV1(config, execute, logger);
    this.av1.conversionPolicy = this.conversionPolicy;
    this.hlsPool = new HLSPool(media => media.provider.stop(media));
  }
  close() {
    this.cacheBudget.clear();
    return (this.closing ||= Promise.all([this.hlsPool.close(), this.av1.close()]));
  }
}

module.exports = { MediaPipeline };
