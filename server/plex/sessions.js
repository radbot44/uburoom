'use strict';
const { randomUUID } = require('node:crypto');
const { qualityId } = require('../../shared/engine.mjs');
const { PlaybackError, classifyHdr } = require('../av1');
const Tracks = require('../media-tracks');
const Output = require('../plex-output');
const Sources = require('../plex-source');
const SubtitleResources = require('../subtitle-resources');
const { planDelivery } = require('../delivery-plan');
const { mediaIdentity } = require('../../shared/room-protocol.mjs');
const { runOperation, currentSignal } = require('../operation');

function parseChapters(item) {
  if (!Array.isArray(item?.Chapter)) return [];
  const durationSec = Number(item.duration || 0) / 1000;
  return item.Chapter.map((ch, idx) => {
    const start = Number(ch.startTimeOffset || 0) / 1000;
    const rawEnd = Number(ch.endTimeOffset || 0) / 1000;
    const end = rawEnd > start ? rawEnd : durationSec > start ? durationSec : start;
    return {
      id: String(ch.id ?? idx + 1),
      index: Number(ch.index ?? idx + 1),
      title: String(ch.tag || 'Chapter ' + (ch.index ?? idx + 1)).slice(0, 100),
      startTime: Math.max(0, Math.round(start * 1000) / 1000),
      endTime: Math.max(0, Math.round(end * 1000) / 1000),
    };
  })
    .filter(ch => Number.isFinite(ch.startTime) && ch.startTime >= 0)
    .sort((a, b) => a.startTime - b.startTime);
}

function parseMarkers(item) {
  if (!Array.isArray(item?.Marker)) return [];
  return item.Marker.map((m, idx) => {
    const type = String(m.type || '').toLowerCase();
    const start = Number(m.startTimeOffset || 0) / 1000;
    const end = Number(m.endTimeOffset || 0) / 1000;
    return {
      id: String(m.id ?? idx + 1),
      type,
      startTime: Math.max(0, Math.round(start * 1000) / 1000),
      endTime: Math.max(0, Math.round(end * 1000) / 1000),
    };
  })
    .filter(
      m =>
        ['intro', 'credits'].includes(m.type) &&
        Number.isFinite(m.startTime) &&
        Number.isFinite(m.endTime) &&
        m.endTime > m.startTime,
    )
    .sort((a, b) => a.startTime - b.startTime);
}

// Session lifecycle: preparing a stream (direct, Plex HLS or local conversion), confirming
// it started, stopping it, and reconciling the Plex sessions uburoom started.
class PlexSessions {
  constructor(plex, shared) {
    this.plex = plex;
    this.sessions = shared.sessions;
    this.partQueues = shared.partQueues;
    this.hlsPool = shared.hlsPool;
  }
  async prepare(id, quality, compatible = false, source, fallback, choices = {}) {
    quality = qualityId(quality);
    if (!choices.sourceOnly && !this.plex.qualityOptions.some(q => q.id === quality))
      throw new PlaybackError('This quality is not offered by the server.');
    const sameSource = source && (source.principal || 'discord-shared') === this.plex.principal;
    const { ratingKey, mediaId: targetMediaId } = mediaIdentity(this.plex.id(id));
    const item = (await this.plex.json(`/library/metadata/${ratingKey}?checkFiles=1`)).Metadata?.[0];
    if (!item || !['movie', 'episode'].includes(item.type)) throw new Error('Select a movie or episode');
    const pinned = targetMediaId ? { mediaId: targetMediaId } : source?.sourceSelection;
    const selected = Sources.select(item, pinned),
      { media: original, part } = selected;
    const videoStream = part.Stream?.find(x => Number(x.streamType) === 1);
    const hdrInfo = classifyHdr(videoStream || original);
    const sourceBitDepth = Number(videoStream?.bitDepth || original?.bitDepth) || (hdrInfo.hdr ? 10 : 8);
    const media = {
      title: String(item.title).slice(0, 200),
      subtitle: this.plex.subtitle(item),
      duration: item.duration / 1000,
      quality,
      kind: 'plex',
      resources: new Map(),
      id,
      source: item,
      sourceSelection: selected.identity,
      principal: this.plex.principal,
      plexContext: this.plex,
      videoCodec: original.videoCodec || videoStream?.codec,
      audioCodec:
        original.audioCodec ||
        part.Stream?.find(x => x.streamType === 2 && x.selected)?.codec ||
        part.Stream?.find(x => x.streamType === 2)?.codec,
      hdr: hdrInfo.hdr,
      hdrKind: hdrInfo.kind,
      hdrLabel: hdrInfo.label,
      doviProfile: hdrInfo.doviProfile,
      bitDepth: sourceBitDepth,
      sourceHdr: hdrInfo.hdr,
      sourceHdrKind: hdrInfo.kind,
      sourceHdrLabel: hdrInfo.label,
      ...(sameSource ? { previousId: source.previousId, nextId: source.nextId } : await this.plex.neighbors(item)),
    };
    media.chapters = parseChapters(item);
    media.markers = parseMarkers(item);
    media.tracks = Tracks.catalog(part, {
      browserSubtitles: choices.browserSubtitles,
      extractSubtitles: !!this.plex.av1.ffmpeg,
    });
    media.selection = Tracks.select(media.tracks, choices);
    media.sourceStart = this.plex.url(part.key).href;
    media.partId = String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key)[1]);
    media.sourceKey = JSON.stringify([
      this.plex.base.origin,
      id,
      media.partId,
      this.plex.url(part.key).pathname,
      part.size,
      item.duration,
      original.id,
    ]);
    media.captionVersion = randomUUID();
    media.subtitleAbort = new AbortController();
    const audio = media.selection.audio;
    if (audio) media.audioCodec = audio.codec;
    const burn = media.selection.subtitle?.available && media.selection.subtitle.delivery === 'burn';
    const effectiveAudioTracks = hdrInfo.hdr && (!audio || audio.ordinal === 0) ? 1 : media.tracks.audio.length;
    const conversion =
      !choices.sourceOnly &&
      (!fallback || fallback === 'audio') &&
      (burn || compatible || quality !== 'direct' || effectiveAudioTracks > 1);
    const plan = planDelivery({
      quality,
      compatible,
      fallback,
      burn,
      audioTracks: effectiveAudioTracks,
      sourceOnly: choices.sourceOnly,
      outputs: conversion ? await this.plex.usableOutputs(choices.localCodecs) : undefined,
    });
    media.deliveryReason = plan.reason;
    if (plan.route !== 'file') {
      media.hdr = false;
      media.hdrKind = 'sdr';
      media.hdrLabel = 'SDR';
      media.doviProfile = null;
      media.bitDepth = 8;
    }
    this.plex.av1.logger.info(
      'Delivery',
      `"${media.title}" ${quality}: ${plan.route}${plan.codec ? ' ' + plan.codec : ''} (${plan.reason}), source ${media.videoCodec}/${media.audioCodec}${fallback ? ', requested ' + fallback : ''}`,
    );
    const directPlan = plan.route === 'plex-hls' ? await choices.directPlan?.() : undefined;
    const directHls = !!(directPlan || choices.directHls);
    if (directPlan) media.directHls = directPlan;
    if (choices.shareKey && plan.route === 'plex-hls') {
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
        shared = await this.hlsPool.acquire(
          key,
          authorized =>
            this.plex.prepare(id, quality, compatible, source, fallback, {
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
      media.hlsContext = shared.media.plexContext;
      if (shared.lease) media.hlsLease = shared.lease;
      else media.releaseConversion = shared.media.releaseConversion;
      return media;
    }
    if (plan.route === 'file') {
      media.format = 'file';
      media.start = media.sourceStart;
    } else if (plan.route === 'local') {
      const codec = plan.codec;
      try {
        await this.plex.conversionPolicy.video('uburoom', codec);
      } catch (error) {
        const failure = new PlaybackError(error.message);
        failure.media = media;
        throw failure;
      }
      const maxTranscode = this.plex.maxTranscodeQuality();
      const preset =
        quality === 'direct' ? maxTranscode : this.plex.qualityOptions.find(q => q.id === qualityId(quality));
      media.bitrateCeiling =
        quality === 'direct'
          ? Math.min(maxTranscode?.bitrate || 20000, Math.max(2000, original.bitrate || maxTranscode?.bitrate || 20000))
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
        this.plex.conversionPolicy.settings &&
        this.plex.conversionPolicy.jobs.size >= this.plex.conversionPolicy.settings.maxJobs
      ) {
        try {
          media.av1Lease = this.plex.av1.acquire(localSource, quality, true, codec);
        } catch (error) {
          if (!error.conversionCapacity) throw error;
          const release = await this.plex.conversionPolicy.wait({ authorized: choices.authorized });
          release();
        }
      }
      media.av1Lease ||= this.plex.av1.acquire(localSource, quality, choices.sharedOnly, codec);
    } else {
      const prepare = async () => {
        let copyOnly = false;
        try {
          try {
            await this.plex.conversionPolicy.video('plex');
          } catch (error) {
            if (error.videoDisabled) copyOnly = true;
            else throw error;
          }
          if (choices.sharedOnly)
            throw Object.assign(new PlaybackError('No matching shared output is available.'), {
              conversionCapacity: true,
            });
          media.releaseConversion = await this.plex.conversionPolicy.wait({ authorized: choices.authorized });
        } catch (error) {
          throw error instanceof PlaybackError ? error : new PlaybackError(error.message);
        }
        if (choices.authorized && !(await choices.authorized()))
          throw new PlaybackError('Viewing access or track selection expired.');
        const restoreAudio = await this.plex.selectAudioForTranscode(media, choices);
        let restoreSubtitle;
        try {
          if (burn) restoreSubtitle = await this.plex.selectSubtitleForBurn(media, choices);
          media.format = 'hls';
          media.transcodeId = randomUUID();
          this.sessions.set(media.transcodeId, { context: this.plex, at: Date.now() });
          const directStream = copyOnly || (!burn && !compatible);
          const params = this.plex.transcodeParams({
            ratingKey,
            selected,
            original,
            quality,
            session: media.transcodeId,
            audio,
            burn,
            directStream,
          });
          const decision = await this.plex.json('/video/:/transcode/universal/decision?' + params);
          if (
            copyOnly &&
            (burn ||
              !decision.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream?.some(
                stream => Number(stream.streamType) === 1 && stream.decision === 'copy',
              ) ||
              decision.Metadata.some(item =>
                item.Media?.some(output =>
                  output.Part?.some(part =>
                    part.Stream?.some(stream => Number(stream.streamType) === 1 && stream.decision !== 'copy'),
                  ),
                ),
              ))
          ) {
            throw new PlaybackError(
              'This media needs video transcoding, which Plex has disabled. Try Original playback or another compatible player.',
            );
          }
          const preset =
            quality !== 'direct'
              ? this.plex.qualityOptions.find(q => q.id === qualityId(quality))
              : !directStream
                ? this.plex.maxTranscodeQuality()
                : undefined;
          const ceiling = {
            bitrate: Number(params.get('maxVideoBitrate')),
            width: preset?.width,
            height: preset?.height,
          };
          const allowHevcCopy = directStream && hdrInfo.kind !== 'dovi-p5';
          const confirmed = Output.confirm(decision, {
            audio,
            burn,
            subtitle: media.selection.subtitle,
            ceiling,
            allowHevcCopy,
          });
          Object.assign(media, confirmed, { compatible, bitrateCeiling: ceiling.bitrate, output: confirmed });
          if (confirmed.videoCodec === 'hevc' && confirmed.videoDecision === 'copy') {
            media.hdr = hdrInfo.hdr;
            media.hdrKind = hdrInfo.kind;
            media.hdrLabel = hdrInfo.label;
            media.doviProfile = hdrInfo.doviProfile;
            media.bitDepth = sourceBitDepth;
          }
          media.start = this.plex.url('/video/:/transcode/universal/start.m3u8?' + params).href;
          if (burn || audio || directHls) {
            if (choices.authorized && !(await choices.authorized()))
              throw new PlaybackError('Viewing access or track selection expired.');
            const response = await this.plex.request(media.start, {
              headers: { Accept: 'application/vnd.apple.mpegurl' },
            });
            const text = await response.text();
            if (!text.startsWith('#EXTM3U') || text.length > 2e6)
              throw new PlaybackError('Plex could not start the requested audio and subtitle transcode.');
            media.initialManifest = text;
            await this.plex.confirmStarted(media, text);
          }
        } finally {
          await runOperation(undefined, async () => {
            try {
              await restoreSubtitle?.();
            } finally {
              await restoreAudio?.();
            }
          });
        }
      };
      try {
        await this.plex.withPartLock((this.plex.principal || 'global') + ':' + media.partId, prepare);
      } catch (error) {
        await this.plex.stop(media);
        const failure =
          error instanceof PlaybackError
            ? error
            : new PlaybackError('Plex playback could not be prepared. Check server access and transcoding support.');
        failure.media = media;
        throw failure;
      }
    }
    return media;
  }
  // Plex can accept a session and then refuse to run it, for example when its transcode
  // drive is nearly full. Without this the viewer gets a black screen and no error.
  async confirmStarted(media, manifest) {
    const first = manifest
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line && !line.startsWith('#'));
    if (!first?.split('?')[0].endsWith('.m3u8')) return;
    const target = this.plex.url(new URL(first, media.start).href).href,
      id = media.transcodeId;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.plex.request(target, {
          headers: {
            Accept: 'application/vnd.apple.mpegurl',
            'X-Plex-Client-Identifier': id,
            'X-Plex-Session-Identifier': id,
          },
        });
        await response.body?.cancel().catch(() => {});
        return;
      } catch (error) {
        if (![404, 500].includes(error.status)) return;
        if (attempt) {
          this.plex.av1.logger.warn(
            'Plex',
            `Plex accepted a session for "${media.title}" and then refused it (HTTP ${error.status}). Check Plex's log and its transcode drive's free space.`,
          );
          throw new PlaybackError("Plex couldn't start this video. Try a lower quality.");
        }
        await new Promise(resolve => setTimeout(resolve, 750));
      }
    }
  }
  async withPartLock(id, action) {
    const key = String(id);
    const previous = this.partQueues.get(key) || Promise.resolve();
    const signal = currentSignal();
    const job = previous
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted();
        return action();
      });
    this.partQueues.set(key, job);
    job
      .finally(() => {
        if (this.partQueues.get(key) === job) this.partQueues.delete(key);
      })
      .catch(() => {});
    return job;
  }
  stop(media) {
    return runOperation(undefined, () => this.plex.stopOwned(media));
  }
  async stopOwned(media) {
    media?.subtitleAbort?.abort();
    media?.subtitleCache?.clear();
    if (media) SubtitleResources.clear(media);
    if (media?.hlsLease) {
      await media.hlsLease.release();
      return;
    }
    if (media?.av1Lease) this.plex.av1.release(media.av1Lease);
    if (media?.transcodeId) {
      const id = media.transcodeId,
        headers = { 'X-Plex-Client-Identifier': id, 'X-Plex-Session-Identifier': id };
      const entry = this.sessions.get(id);
      if (entry) entry.stoppedAt = Date.now();
      await (media.hlsContext || media.plexContext || this.plex)
        .request('/video/:/transcode/universal/stop?' + new URLSearchParams({ session: id, ...headers }), { headers })
        .catch(() => {});
    }
    media?.releaseConversion?.();
    if (media) media.releaseConversion = undefined;
  }
  /**
   * Desired state for Plex sessions: every transcode uburoom started and no longer uses
   * is ended, whichever path dropped it. Plex keeps a session's files on its transcode
   * drive until the session ends, so a leak fills the disk.
   * @param {Set<string>} inUse transcode IDs that rooms, viewers or shared streams hold
   */
  async reconcileSessions(inUse, now = Date.now()) {
    const data = await this.plex.json('/transcode/sessions');
    const listed = (data?.TranscodeSession || [])
      .map(session =>
        String(session.key || '')
          .split('/')
          .pop(),
      )
      .filter(Boolean);
    const present = new Set(listed),
      ended = [];
    for (const id of listed) {
      const entry = this.sessions.get(id);
      // Never touch other apps' sessions or one still being prepared.
      if (!entry || inUse.has(id) || now - entry.at < 120000) continue;
      const headers = { 'X-Plex-Client-Identifier': id, 'X-Plex-Session-Identifier': id };
      await entry.context
        .request('/video/:/transcode/universal/stop?' + new URLSearchParams({ session: id, ...headers }), { headers })
        .catch(() => {});
      ended.push({ id, stopped: !!entry.stoppedAt });
      entry.stoppedAt = now;
    }
    for (const [id, entry] of this.sessions) {
      if (!present.has(id) && !inUse.has(id) && (entry.stoppedAt || now - entry.at > 86400000))
        this.sessions.delete(id);
    }
    if (ended.length)
      this.plex.av1.logger.warn(
        'Plex',
        `Ended ${ended.length} Plex transcode ${ended.length === 1 ? 'session' : 'sessions'} that uburoom no longer used (${ended.filter(item => item.stopped).length} had already been asked to stop).`,
      );
    return {
      plexSessions: listed.length,
      uburoomSessions: listed.filter(id => this.sessions.has(id)).length,
      ended: ended.length,
    };
  }
  async ping(media) {
    if (!media?.transcodeId) return false;
    const id = media.transcodeId,
      headers = { 'X-Plex-Client-Identifier': id, 'X-Plex-Session-Identifier': id };
    try {
      await (media.hlsContext || media.plexContext || this.plex).request(
        '/video/:/transcode/universal/ping?' + new URLSearchParams({ session: id, ...headers }),
        { headers },
      );
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { PlexSessions };
