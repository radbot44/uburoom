'use strict';
const { qualityId } = require('../shared/engine.mjs');
const { PlaybackError } = require('./errors');
const { planDelivery } = require('./delivery-plan');
// Sound every current browser plays; anything else will likely come back as an "audio" fallback.
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

/**
 * Prepare one viewer's stream of one item. The provider scope says what the item
 * is and where its bytes are; this decides how they reach the viewer: the original
 * file, the picture copied with only its sound converted, uburoom's own conversion,
 * or the provider's transcode where it has one,
 * shared with other viewers when the output is identical.
 *
 * A provider implements `source(id, previous, choices)`, returning the prepared
 * media and whatever private detail its own transcode needs, and optionally
 * `startTranscode(media, detail, request)`.
 * @param {any} provider - The scope this viewer watches through; it becomes `media.provider`.
 */
async function prepareStream(provider, id, quality, compatible = false, source, fallback, choices = {}) {
  const pipeline = provider.pipeline;
  quality = qualityId(quality);
  if (!choices.sourceOnly && !pipeline.qualityOptions.some(q => q.id === quality))
    throw new PlaybackError('This quality is not offered by the server.');
  const { media, detail } = await provider.source(id, source, choices);
  media.quality = quality;
  const audio = media.selection.audio;
  if (audio) media.audioCodec = audio.codec;
  const burn = media.selection.subtitle?.available && media.selection.subtitle.delivery === 'burn';
  const effectiveAudioTracks = media.sourceHdr && (!audio || audio.ordinal === 0) ? 1 : media.tracks.audio.length;
  const conversion =
    !choices.sourceOnly &&
    (!fallback || fallback === 'audio') &&
    (burn || compatible || quality !== 'direct' || effectiveAudioTracks > 1);
  // A provider with a transcoder of its own keeps the picture through that instead.
  const remux =
    !choices.sourceOnly && typeof provider.startTranscode !== 'function' && !!pipeline.remux?.available(media);
  const plan = planDelivery({
    quality,
    compatible,
    fallback,
    burn,
    audioTracks: effectiveAudioTracks,
    sourceOnly: choices.sourceOnly,
    remux,
    outputs: conversion ? await pipeline.usableOutputs(provider, choices.localCodecs) : undefined,
  });
  media.deliveryReason = plan.reason;
  if (plan.route !== 'file' && plan.route !== 'remux') {
    media.hdr = false;
    media.hdrKind = 'sdr';
    media.hdrLabel = 'SDR';
    media.doviProfile = null;
    media.bitDepth = 8;
  }
  pipeline.av1.logger.info(
    'Delivery',
    `"${media.title}" ${quality}: ${plan.route}${plan.codec ? ' ' + plan.codec : ''} (${plan.reason}), source ${media.videoCodec}/${media.audioCodec}${fallback ? ', requested ' + fallback : ''}`,
  );
  // An original whose sound the browser will likely refuse, or that offers other audio tracks,
  // usually comes back as a copied-picture request moments later. Finding its keyframes is the
  // slow part of that, so it starts now; it is remembered per file and changes nothing else.
  if (
    remux &&
    plan.route === 'file' &&
    (media.tracks.audio.length > 1 || (audio && !BROWSER_AUDIO.has(String(audio.codec).toLowerCase())))
  )
    pipeline.remux.boundaries(media, AbortSignal.timeout(180000)).catch(() => {});
  const directPlan = plan.route === 'provider-hls' ? await choices.directPlan?.() : undefined;
  const directHls = !!(directPlan || choices.directHls);
  if (directPlan) media.directHls = directPlan;
  if (choices.shareKey && plan.route === 'provider-hls') {
    if (choices.authorized && !(await choices.authorized()))
      throw new PlaybackError('Viewing access or stream selection expired.');
    const key = JSON.stringify([
      choices.shareKey,
      media.sourceKey,
      qualityId(quality),
      audio?.id,
      burn ? media.selection.subtitle.id : null,
      directHls,
      !!compatible,
    ]);
    let shared;
    try {
      shared = await pipeline.hlsPool.acquire(
        key,
        authorized =>
          provider.prepare(id, quality, compatible, source, fallback, {
            ...choices,
            directPlan: undefined,
            directHls,
            shareKey: undefined,
            excludeLease: undefined,
            authorized,
          }),
        choices.authorized,
        choices.excludeLease,
        choices.shareWaitMs,
        choices.sharedOnly,
        directHls,
      );
    } catch (error) {
      media.subtitleAbort.abort();
      if (error instanceof PlaybackError) {
        const failure = Object.assign(new PlaybackError(error.message), {
          conversionCapacity: !!error.conversionCapacity,
          media,
        });
        throw failure;
      }
      throw error;
    }
    for (const field of [
      'format',
      'transcodeId',
      'start',
      'initialManifest',
      'videoCodec',
      'audioCodec',
      'bitrate',
      'bitrateCeiling',
      'output',
      'hdr',
      'hdrKind',
      'hdrLabel',
      'doviProfile',
      'bitDepth',
    ])
      media[field] = shared.media[field];
    media.compatible = compatible;
    media.hlsProvider = shared.media.provider;
    if (shared.lease) media.hlsLease = shared.lease;
    else media.releaseConversion = shared.media.releaseConversion;
    return media;
  }
  if (plan.route === 'file') {
    media.format = 'file';
    media.start = media.sourceStart;
  } else if (plan.route === 'remux') {
    try {
      pipeline.conversionPolicy.copy();
      if (choices.authorized && !(await choices.authorized()))
        throw new PlaybackError('Viewing access or track selection expired.');
      await pipeline.remux.acquire(media, audio, choices.shareKey);
      media.compatible = compatible;
    } catch (error) {
      const failure = new PlaybackError(
        error instanceof PlaybackError ? error.message : 'The video could not be copied.',
      );
      failure.media = media;
      throw failure;
    }
  } else if (plan.route === 'local') {
    const codec = plan.codec;
    try {
      await pipeline.conversionPolicy.video('uburoom', codec, provider);
    } catch (error) {
      const failure = new PlaybackError(error.message);
      failure.media = media;
      throw failure;
    }
    const maxTranscode = pipeline.maxTranscodeQuality();
    const preset = quality === 'direct' ? maxTranscode : pipeline.qualityOptions.find(q => q.id === qualityId(quality));
    media.bitrateCeiling =
      quality === 'direct'
        ? Math.min(
            maxTranscode?.bitrate || 20000,
            Math.max(2000, media.sourceBitrate || maxTranscode?.bitrate || 20000),
          )
        : preset?.bitrate;
    const localSource = {
      ...media,
      start: media.sourceStart,
      audioIndex: audio?.index,
      audioOrdinal: audio?.ordinal,
      audioTrack: audio,
      shareKey: choices.shareKey,
      burn: burn ? media.selection.subtitle : undefined,
    };
    media.format = codec;
    media.videoCodec = codec;
    media.audioCodec = 'opus';
    media.compatible = true;
    if (
      !choices.sharedOnly &&
      pipeline.conversionPolicy.settings &&
      pipeline.conversionPolicy.jobs.size >= pipeline.conversionPolicy.settings.maxJobs
    ) {
      try {
        media.av1Lease = pipeline.av1.acquire(localSource, quality, true, codec);
      } catch (error) {
        if (!error.conversionCapacity) throw error;
        const release = await pipeline.conversionPolicy.wait({ authorized: choices.authorized });
        release();
      }
    }
    media.av1Lease ||= pipeline.av1.acquire(localSource, quality, choices.sharedOnly, codec);
  } else {
    if (typeof provider.startTranscode !== 'function') {
      await provider.stop(media);
      throw Object.assign(new PlaybackError('This video needs a conversion this server cannot provide.'), { media });
    }
    await provider.startTranscode(media, detail, { quality, compatible, burn, audio, directHls, choices });
  }
  return media;
}

module.exports = { prepareStream };
