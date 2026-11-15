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
  /** The best quality a conversion may produce. */
  maxTranscodeQuality() {
    return this.qualityOptions.find(q => q.id !== 'direct') || QUALITIES[1];
  }
  // Configured outputs this viewer can use, in priority order. 'plex' stands for the
  // provider's own transcode and is usable only where the provider has one. Without a
  // working hardware encoder, a local codec waits behind it rather than loading the CPU.
  async usableOutputs(provider, localCodecs = []) {
    const remote = typeof provider?.startTranscode === 'function';
    const configured = (this.conversionPolicy.settings?.outputs || ['plex']).filter(
        output => output !== 'plex' || remote,
      ),
      usable = [];
    for (const [index, output] of configured.entries()) {
      if (output === 'plex') {
        usable.push(output);
        continue;
      }
      if (!this.av1.ffmpeg || !localCodecs.includes(output)) continue;
      try {
        const encoder = await this.av1.selectEncoder(output);
        if (encoder !== 'software' || this.av1.encoder === 'software' || !configured.slice(index + 1).includes('plex'))
          usable.push(output);
      } catch {
        /* An output with no working encoder is skipped. */
      }
    }
    return usable;
  }
  close() {
    this.cacheBudget.clear();
    return (this.closing ||= Promise.all([this.hlsPool.close(), this.av1.close()]));
  }
}

module.exports = { MediaPipeline };
