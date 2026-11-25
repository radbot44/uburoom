'use strict';
const { QUALITIES } = require('../shared/engine.mjs');
const { AV1 } = require('./av1');
const { CacheBudget } = require('./cache-budget');
const { HLSPool } = require('./hls-pool');
const { MediaFacts } = require('./media-facts');
const { Remux } = require('./remux');
const { ConversionPolicy, ProcessGate } = require('./transcoding-policy');
const SubtitleResources = require('./subtitle-resources');

// What every media provider plays through: local conversion, pooled provider HLS,
// the shared conversion capacity and the offered qualities. One per server, owned
// by the application rather than by any provider. A provider only supplies sources
// and, where it can, its own transcodes; each prepared media object names the
// provider that answers for it (see server/media-provider.js).
class MediaPipeline {
  /** @param {any} [config] @param {{logger?: any, execute?: Function}} [options] */
  constructor(config = {}, { logger, execute } = {}) {
    this.ubuplayer = config.ubuplayer !== false && config.transcoding?.ubuplayer !== false;
    this.cacheBudget = new CacheBudget();
    this.qualityOptions = config.transcoding?.qualities || QUALITIES;
    this.conversionPolicy = new ConversionPolicy(config.transcoding);
    this.processGate = new ProcessGate(Math.max(4, (config.transcoding?.maxJobs || 2) * 3));
    this.av1 = new AV1(config, execute, logger);
    this.av1.conversionPolicy = this.conversionPolicy;
    this.av1.processGate = this.processGate;
    this.mediaFacts = new MediaFacts({ av1: this.av1, logger });
    this.av1.mediaFacts = this.mediaFacts;
    this.subtitleResources = new SubtitleResources.SubtitleResourceManager({
      mediaFacts: this.mediaFacts,
      logger,
    });
    this.hlsPool = new HLSPool(media => media.provider.stop(media));
    /** Copies a file's picture and converts only its sound, for providers with no transcoder. */
    this.remux = new Remux(this.av1);
  }
  /** The offered qualities a source can fill: none above its own bitrate or picture height. */
  qualities(media) {
    const source = media?.unavailable ? undefined : media,
      bitrate = source?.sourceBitrate,
      height = source?.sourceHeight && Math.max(source.sourceHeight, ((source.sourceWidth || 0) * 9) / 16);
    return this.qualityOptions
      .filter(q => !q.bitrate || ((!bitrate || q.bitrate <= bitrate) && (!height || q.height <= height)))
      .map(q =>
        q.id === 'direct' && bitrate > 0 ? { ...q, label: 'Original · ' + Math.round(bitrate / 1000) + ' Mbps' } : q,
      );
  }
  /**
   * Release what the pipeline holds for a prepared media object: its subtitle work,
   * its place on a shared output, its local conversion and its conversion capacity.
   * A provider's `stop` calls this with `own`, which ends whatever the provider itself
   * started; media no provider prepared holds nothing else.
   * @param {any} media @param {() => Promise<any>} [own]
   */
  async release(media, own) {
    if (!media) return;
    media.lifecycleAbort?.abort();
    media.subtitleAbort?.abort();
    media.subtitleCache?.clear();
    this.subtitleResources.clear(media);
    SubtitleResources.clear(media);
    // A shared output is ended by its pool once its last viewer leaves.
    if (media.hlsLease) return media.hlsLease.release();
    if (media.av1Lease) this.av1.release(media.av1Lease);
    await media.remuxLease?.release();
    await own?.();
    media.releaseConversion?.();
    media.releaseConversion = undefined;
  }
  /** Whether a conversion for playback is running, so background work can wait for it. */
  get busy() {
    return this.av1.groups.size > 0 || this.hlsPool.groups.size > 0;
  }
  /** The best quality a conversion may produce. */
  maxTranscodeQuality() {
    return this.qualityOptions.find(q => q.id !== 'direct') || QUALITIES[1];
  }
  // Configured outputs this viewer can use, in priority order. 'provider' stands for the
  // provider's own transcode and is usable only where the provider has one. Without a
  // working hardware encoder, a local codec waits behind it rather than loading the CPU.
  async usableOutputs(provider, localCodecs = []) {
    const remote = typeof provider?.startTranscode === 'function';
    const configured = (this.conversionPolicy.settings?.outputs || ['provider']).filter(
        output => output !== 'provider' || remote,
      ),
      usable = [];
    for (const [index, output] of configured.entries()) {
      if (output === 'provider') {
        usable.push(output);
        continue;
      }
      if (!this.av1.ffmpeg || !localCodecs.includes(output)) continue;
      try {
        const encoder = await this.av1.selectEncoder(output);
        if (
          encoder !== 'software' ||
          this.av1.encoder === 'software' ||
          !configured.slice(index + 1).includes('provider')
        )
          usable.push(output);
      } catch {
        /* An output with no working encoder is skipped. */
      }
    }
    return usable;
  }
  stats() {
    return {
      mediaFacts: this.mediaFacts.stats(),
      subtitleResources: this.subtitleResources.stats?.() || {},
      cacheBudgetBytes: this.cacheBudget.bytes,
    };
  }
  close() {
    this.cacheBudget.clear();
    this.mediaFacts.close();
    this.subtitleResources.close?.();
    return (this.closing ||= Promise.all([this.hlsPool.close(), this.remux.close(), this.av1.close()]));
  }
}

module.exports = { MediaPipeline };
