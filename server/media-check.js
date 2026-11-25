// @ts-check
'use strict';
const { fromProvider } = require('./media-provider');
const { codecMatches, classifyHdr } = require('./media-tools');

// How a track list is named when its provider does not say.
const LIBRARY = { name: 'The library', owner: "the library's", refresh: '' };
const IMAGE_SUBTITLES = new Set(['pgs', 'vobsub', 'dvd_subtitle', 'hdmv_pgs_subtitle']);
const EMBEDDED_SUBTITLES = new Set(['eia_608', 'eia_708', 'cea_608', 'cea_708']);
const LEVELS = ['problem', 'warning', 'info', 'ok'];
/**
 * @typedef {{level:'problem'|'warning'|'info'|'ok', topic:string, title:string, detail?:string}} CheckItem
 */

/**
 * Checks a video before and while a room plays it, for the host's info screen. File facts
 * (tracks, HDR, audio start, bitrate) are gathered once per file and kept. The provider
 * that serves the video adds what only it can say (its `checks`): per file, such as whether
 * it would play it, and about itself, read fresh each time. Nothing here changes playback.
 */
class MediaChecks {
  /** @param {{pipeline?:any}} options */
  constructor({ pipeline } = {}) {
    this.pipeline = pipeline;
    /** @type {Map<string,{promise:Promise<CheckItem[] | undefined>, signal?:AbortSignal, items?:CheckItem[], checkedAt?:number}>} */
    this.files = new Map();
  }
  key(media) {
    return media?.sourceKey;
  }
  /** Begin the file checks in the background; repeated calls share one run. */
  start(media) {
    const key = this.key(media);
    const signal = media?.lifecycleAbort?.signal;
    if (!key || !fromProvider(media) || signal?.aborted) return;
    const cached = this.files.get(key);
    this.files.delete(key);
    if (cached && (cached.items || !cached.signal?.aborted)) {
      this.files.set(key, cached);
      return cached;
    }
    /** @type {Promise<CheckItem[] | undefined>} */
    const promise = this.fileItems(media).catch(error => {
      if (signal?.aborted) return;
      return [
        {
          level: 'warning',
          topic: 'file',
          title: "This file couldn't be checked",
          detail: String(error.message || error).slice(0, 200),
        },
      ];
    });
    const entry = { promise, signal, items: undefined, checkedAt: undefined };
    promise.then(items => {
      // A canceled preload or room can share a source key with a subsequent active load.
      if (!items) {
        if (this.files.get(key) === entry) this.files.delete(key);
        return;
      }
      entry.items = items;
      entry.checkedAt = Date.now();
    });
    this.files.set(key, entry);
    while (this.files.size > 50) this.files.delete(this.files.keys().next().value);
    return entry;
  }
  /** Drop a file's results so the next report checks it again. */
  forget(media) {
    const key = this.key(media);
    this.files.delete(key);
    this.pipeline?.mediaFacts?.forget(key);
  }
  /** Build a synthetic video descriptor from Plex/source HDR metadata when container probing is skipped. */
  hdrVideoFromMetadata(media) {
    const kind = media?.sourceHdrKind || media?.hdrKind;
    if (!kind || kind === 'sdr') return null;
    if (kind === 'dovi-p5') {
      return {
        codec_type: 'video',
        side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 5, bl_signal_compatibility_id: 0 }],
      };
    }
    if (kind === 'dovi-hdr10') {
      return {
        codec_type: 'video',
        color_transfer: 'smpte2084',
        side_data_list: [
          {
            side_data_type: 'DOVI configuration record',
            dv_profile: media?.doviProfile ?? 8,
            bl_signal_compatibility_id: 1,
          },
        ],
      };
    }
    if (kind === 'dovi-hlg') {
      return {
        codec_type: 'video',
        color_transfer: 'arib-std-b67',
        side_data_list: [
          {
            side_data_type: 'DOVI configuration record',
            dv_profile: media?.doviProfile ?? 8,
            bl_signal_compatibility_id: 4,
          },
        ],
      };
    }
    if (kind === 'dovi-sdr') {
      return {
        codec_type: 'video',
        side_data_list: [
          {
            side_data_type: 'DOVI configuration record',
            dv_profile: media?.doviProfile ?? 8,
            bl_signal_compatibility_id: 2,
          },
        ],
      };
    }
    if (kind === 'hdr10') return { codec_type: 'video', color_transfer: 'smpte2084' };
    if (kind === 'hlg') return { codec_type: 'video', color_transfer: 'arib-std-b67' };
    return null;
  }
  /** The full report for a room's current video. */
  async report(media, { allowFileProbe = true } = {}) {
    const key = this.key(media);
    const existing = key ? this.files.get(key) : undefined;
    const canStartProbe = allowFileProbe || Boolean(existing?.items);
    const entry = canStartProbe ? this.start(media) : undefined;
    const serverCheck = media?.provider?.checks?.server;
    const hasServerCheck = typeof serverCheck === 'function';
    let live = [];
    if (hasServerCheck) {
      try {
        live = (await serverCheck()) || [];
      } catch (error) {
        live = [
          {
            level: 'warning',
            topic: 'provider',
            title: "Provider check couldn't run",
            detail: String(error?.message || error || 'The media server could not be checked.').slice(0, 200),
          },
        ];
      }
    }
    let skippedItems = [];
    let hasSkippedDirectCheck = false;
    if (!canStartProbe && media && fromProvider(media)) {
      hasSkippedDirectCheck = true;
      const fileChecks = (await media.provider?.checks?.file?.(media).catch(() => [])) || [];
      skippedItems.push(...fileChecks);
      const hdrVideo = this.hdrVideoFromMetadata(media);
      if (hdrVideo) {
        const usable =
          typeof this.pipeline?.usableOutputs === 'function'
            ? await this.pipeline.usableOutputs(media?.provider, ['av1', 'vp9', 'vp8']).catch(() => [])
            : [];
        const hdr = this.hdrItem(hdrVideo, {
          hasLocalTonemap: usable.some(o => o !== 'provider'),
          ubuplayerEnabled: this.pipeline?.ubuplayer !== false,
        });
        if (hdr) skippedItems.push(hdr);
      }
      const images = (media.tracks?.subtitles || []).filter(track => IMAGE_SUBTITLES.has(track.codec));
      if (images.length) {
        skippedItems.push({
          level: 'info',
          topic: 'subtitles',
          title: images.length + (images.length === 1 ? ' subtitle track is' : ' subtitle tracks are') + ' images',
          detail: 'They show on the page, but need Burn-in in iPhone fullscreen.',
        });
      }
      skippedItems.push({
        level: 'info',
        topic: 'file',
        title: 'Direct Plex playback active — container scan skipped',
        detail: 'Use Refresh to inspect the file through uburoom.',
      });
    }
    const items = [...(entry?.items || []), ...skippedItems, ...live.filter(Boolean)];
    const checking = !!entry && !entry.items;
    const applicable = !!entry || hasSkippedDirectCheck || hasServerCheck;
    const status = !applicable ? 'not-applicable' : checking ? 'checking' : 'checked';
    if (checking) items.push({ level: 'info', topic: 'file', title: 'Checking the file…' });
    items.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
    return {
      title: media?.title,
      applicable,
      status,
      checking,
      checkedAt: entry?.checkedAt,
      level: items[0]?.level || (applicable ? 'ok' : 'info'),
      items,
    };
  }
  probe(media, args) {
    const av1 = this.pipeline?.av1;
    if (!av1?.ffprobe) throw new Error('FFprobe is not configured.');
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new DOMException('Timeout', 'TimeoutError')), 120000);
    timer.unref?.();
    const signal = media?.lifecycleAbort?.signal
      ? AbortSignal.any([media.lifecycleAbort.signal, timeoutController.signal])
      : timeoutController.signal;
    const execute = () =>
      av1.input({ ...media, start: media.sourceStart }, signal, url =>
        av1.run(av1.ffprobe, ['-v', 'error', ...args, url], signal, 120000, 16 * 1024 * 1024),
      );
    return execute().finally(() => clearTimeout(timer));
  }
  async fileItems(media) {
    let streams, duration, average;
    if (this.pipeline?.mediaFacts) {
      const facts = await this.pipeline.mediaFacts.inspect(media, { signal: media?.lifecycleAbort?.signal });
      streams = facts.streams || [];
      duration = Number(facts.format?.duration);
      average = Number(facts.format?.bitRate) / 1e6;
    } else {
      const raw = await this.probe(media, [
        '-show_entries',
        'stream=index,codec_type,codec_name,color_transfer:stream_side_data=side_data_type,dv_profile,bl_signal_compatibility_id:format=duration,bit_rate',
        '-of',
        'json',
      ]);
      const info = JSON.parse(raw.toString());
      streams = info.streams || [];
      duration = Number(info.format?.duration);
      average = Number(info.format?.bit_rate) / 1e6;
    }
    const items = [];
    items.push(this.trackItem(media, streams));
    items.push(...((await media.provider?.checks?.file?.(media)) || []));
    const video = streams.find(stream => stream.codec_type === 'video');
    const usable =
      typeof this.pipeline?.usableOutputs === 'function'
        ? await this.pipeline.usableOutputs(media?.provider, ['av1', 'vp9', 'vp8']).catch(() => [])
        : [];
    const hdr = this.hdrItem(video, {
      hasLocalTonemap: usable.some(o => o !== 'provider'),
      ubuplayerEnabled: this.pipeline?.ubuplayer !== false,
    });
    if (hdr) items.push(hdr);
    const images = (media.tracks?.subtitles || []).filter(track => IMAGE_SUBTITLES.has(track.codec));
    if (images.length)
      items.push({
        level: 'info',
        topic: 'subtitles',
        title: images.length + (images.length === 1 ? ' subtitle track is' : ' subtitle tracks are') + ' images',
        detail: 'They show on the page, but need Burn-in in iPhone fullscreen.',
      });
    if (streams.some(stream => stream.codec_type === 'audio')) items.push(await this.audioStartItem(media));
    if (duration > 60) items.push(await this.bitrateItem(media, duration, average));
    return items.filter(Boolean);
  }
  hdrItem(video, { hasLocalTonemap = false, ubuplayerEnabled = this.pipeline?.ubuplayer !== false } = {}) {
    if (!video) return null;
    const hdrInfo = classifyHdr(video);
    if (hdrInfo.kind === 'dovi-p5') {
      return {
        level: hasLocalTonemap ? 'info' : 'warning',
        topic: 'hdr',
        title: hdrInfo.label,
        detail: hasLocalTonemap
          ? ubuplayerEnabled
            ? 'Eligible browsers can play directly with client-side tone-mapping in UbuPlayer; converted qualities are tone-mapped by uburoom.'
            : 'Converted qualities are tone-mapped by uburoom.'
          : 'Profile 5 uses proprietary Dolby Vision color without an HDR10 fallback layer; browsers without Profile 5 support require uburoom tone-mapping.',
      };
    }
    if (hdrInfo.kind === 'dovi-hdr10' || hdrInfo.kind === 'dovi-hlg') {
      return {
        level: 'info',
        topic: 'hdr',
        title: hdrInfo.label,
        detail:
          'Converted qualities are tone-mapped for ordinary screens. Original keeps the compatible HDR base layer for screens that support it.',
      };
    }
    if (hdrInfo.kind === 'dovi-sdr') {
      return { level: 'info', topic: 'hdr', title: hdrInfo.label, detail: 'Includes an SDR-compatible base layer.' };
    }
    if (hdrInfo.hdr) {
      return {
        level: 'info',
        topic: 'hdr',
        title: hdrInfo.label,
        detail:
          'Converted qualities are tone-mapped for ordinary screens. Original keeps ' +
          hdrInfo.label +
          ' for screens that support it.',
      };
    }
    return null;
  }
  /** The provider's track list against the file it serves (the Star Wars remux case). */
  trackItem(media, streams) {
    const rows = [...(media.tracks?.audio || []), ...(media.tracks?.subtitles || [])].filter(
      row => !row.external && Number.isInteger(row.index) && !EMBEDDED_SUBTITLES.has(row.codec),
    );
    const wrong = rows.filter(row => {
      const at = streams.find(stream => stream.index === row.index);
      return !at || !codecMatches(row.codec, at.codec_name);
    });
    const counts = type => streams.filter(stream => stream.codec_type === type).length;
    const listedAudio = (media.tracks?.audio || []).filter(row => !row.external).length;
    const listedSubtitles = (media.tracks?.subtitles || []).filter(
      row => !row.external && !EMBEDDED_SUBTITLES.has(row.codec),
    ).length;
    if (wrong.length || listedAudio !== counts('audio') || listedSubtitles !== counts('subtitle')) {
      const { name, owner, refresh } = media.provider?.checks?.label || LIBRARY;
      const detail =
        listedAudio !== counts('audio') || listedSubtitles !== counts('subtitle')
          ? name +
            ' lists ' +
            listedAudio +
            ' audio and ' +
            listedSubtitles +
            ' subtitle tracks; the file has ' +
            counts('audio') +
            ' and ' +
            counts('subtitle') +
            '. uburoom finds tracks by order, but some may be wrong.' +
            refresh
          : "The file's tracks do not match " + owner + ' saved stream information.' + refresh;
      return {
        level: 'problem',
        topic: 'tracks',
        title: owner[0].toUpperCase() + owner.slice(1) + ' track info is out of date for this file',
        detail,
      };
    }
    return { level: 'ok', topic: 'tracks', title: 'Tracks match the file' };
  }
  /** Audio that starts after the picture (the Hope case). */
  async audioStartItem(media) {
    const raw = (
      await this.probe(media, [
        '-read_intervals',
        '%+30',
        '-show_entries',
        'packet=stream_index,codec_type,pts_time',
        '-of',
        'csv=p=0',
      ])
    ).toString();
    let video, audio;
    for (const line of raw.split(/\r?\n/)) {
      const [type, , time] = line.split(','),
        at = Number(time);
      if (!Number.isFinite(at)) continue;
      if (type === 'video' && video === undefined) video = at;
      if (type === 'audio' && audio === undefined) audio = at;
      if (video !== undefined && audio !== undefined) break;
    }
    if (video === undefined) return;
    if (audio === undefined)
      return {
        level: 'warning',
        topic: 'audio',
        title: 'No audio in the first 30 seconds',
        detail: 'uburoom plays silence until the sound starts.',
      };
    const late = audio - video;
    if (late > 1)
      return {
        level: 'info',
        topic: 'audio',
        title: 'Audio starts ' + Math.round(late * 10) / 10 + ' s after the picture',
        detail: 'uburoom plays silence until the sound starts.',
      };
  }
  /** Peak video bitrate from three samples, for viewers watching Original. */
  async bitrateItem(media, duration, average) {
    let peak = 0;
    for (const share of [0.25, 0.5, 0.75]) {
      const start = Math.floor(duration * share),
        bytes = new Map();
      const raw = (
        await this.probe(media, [
          '-read_intervals',
          start + '%+10',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time,size',
          '-of',
          'csv=p=0',
        ])
      ).toString();
      for (const line of raw.split(/\r?\n/)) {
        const [time, size] = line.split(',').map(Number);
        if (Number.isFinite(time) && Number.isFinite(size))
          bytes.set(Math.floor(time), (bytes.get(Math.floor(time)) || 0) + size);
      }
      for (const total of bytes.values()) peak = Math.max(peak, (total * 8) / 1e6);
    }
    if (!peak) return;
    const text =
      'Video peaks at about ' +
      Math.round(peak) +
      ' Mbps' +
      (average > 0 ? ' (average ' + Math.round(average) + ' Mbps)' : '');
    return peak > 80 && peak > average * 1.8
      ? {
          level: 'warning',
          topic: 'bitrate',
          title: text,
          detail:
            'Viewers on Original need that much bandwidth at peaks, or they will stall. A converted quality avoids it.',
        }
      : { level: 'info', topic: 'bitrate', title: text };
  }
}

module.exports = { MediaChecks };
