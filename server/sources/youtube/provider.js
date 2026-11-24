'use strict';

const fsp = require('node:fs').promises;
const { randomUUID } = require('node:crypto');
const { PlaybackError } = require('../../errors');
const { fileStream } = require('../../file-stream');
const Tracks = require('../../media-tracks');
const { prepareStream } = require('../../media-delivery');
const { runOperation, currentSignal } = require('../../operation');
const { VIDEO_ID, PLAYLIST_ID, parseYouTubeUrl, isAllowedThumbnailUrl } = require('./urls');
const { fetchVideos, fetchPlaylist, fetchOEmbed } = require('./api');
const { YouTubeCache, SAFE_ID, SAFE_TRACK, DEFAULT_MAX_CACHE_BYTES } = require('./ytdlp');

const YOUTUBE_SERVER = 'youtube';
const ORIGIN = 'uburoom-youtube://media';
const ART_LIMIT = 5 * 1024 * 1024;
const TEXT_LIMIT = 4 * 1024 * 1024;
const META_TTL_MS = 10 * 60 * 1000;
const META_CACHE_MAX = 500;
const PLAYLIST_CACHE_MAX = 50;
const PAGE = 30;
const UNKNOWN_EMBED_DURATION = 3600;
const CACHE_LEASE = Symbol('cache lease');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * MediaProvider implementation for YouTube links and playlists backed by either
 * the built-in `yt-dlp` rolling disk cache, IFrame embed playback, or automatic fallback.
 */
class YouTubeMedia {
  constructor({
    delivery = 'auto',
    apiKey = '',
    ytDlp = '',
    ffmpegPath = '',
    ffprobePath = '',
    cacheDirectory = '',
    maxCacheGb = 20,
    maxConcurrent = 2,
    cookiesFile = '',
    poTokenUrl = '',
    playlistLimit = 50,
    label = 'YouTube',
    pipeline,
    fetch = globalThis.fetch,
    runCommand,
    platform = process.platform,
    logger,
  } = {}) {
    this.kind = 'youtube';
    this.principal = 'configured';
    this.serverId = YOUTUBE_SERVER;
    this.name = label || 'YouTube';
    this.delivery = delivery || 'auto';
    this.apiKey = apiKey || '';
    this.cacheDirectory = cacheDirectory || '';
    this.playlistLimit = Math.max(1, Math.min(Number(playlistLimit) || 50, 200));
    this.pipeline = pipeline;
    this.fetch = fetch || globalThis.fetch;
    this.logger = logger;
    this.prepareTimeoutMs = 120000;

    const maxBytes = Number.isFinite(Number(maxCacheGb))
      ? Math.round(Number(maxCacheGb) * 1024 * 1024 * 1024)
      : DEFAULT_MAX_CACHE_BYTES;

    this.cache =
      (this.delivery === 'ytdlp' || this.delivery === 'auto') && this.cacheDirectory
        ? new YouTubeCache({
            cacheDirectory: this.cacheDirectory,
            maxCacheBytes: maxBytes,
            maxConcurrent,
            ytDlpPath: ytDlp,
            ffmpegPath,
            ffprobePath,
            cookiesFile,
            poTokenUrl,
            platform,
            runCommand,
            logger,
          })
        : null;
    this.configured = this.delivery === 'ytdlp' ? !!this.cache : true;
    this.videos = new Map();
    this.playlists = new Map();
    this.inFlight = new Map();
    this.provisionalDurations = new Set();
    this.closed = false;
  }

  rememberProvisionalDuration(videoId) {
    if (!videoId) return;
    this.provisionalDurations.delete(videoId);
    this.provisionalDurations.add(videoId);
    while (this.provisionalDurations.size > META_CACHE_MAX) {
      this.provisionalDurations.delete(this.provisionalDurations.values().next().value);
    }
  }

  noteDuration(videoId, duration) {
    if (!VIDEO_ID.test(videoId || '') || !Number.isFinite(duration) || duration < 1 || duration > 86400) return;
    const prev = this.cachedVideo(videoId);
    this.rememberProvisionalDuration(videoId);
    this.cacheVideo({
      ...(prev || { id: videoId }),
      duration: Math.round(duration * 10) / 10,
      durationUnknown: false,
      hadUnknownDuration: true,
    });
  }

  cacheVideo(video) {
    if (!video?.id) return;
    const prev = this.videos.get(video.id)?.value;
    const hadUnknownDuration = Boolean(
      prev?.hadUnknownDuration ||
      video.hadUnknownDuration ||
      video.durationUnknown ||
      this.provisionalDurations.has(video.id),
    );
    const hasDuration = Number(video.duration) > 0;
    const merged = prev
      ? {
          ...prev,
          ...video,
          thumbnailUrl: video.thumbnailUrl || prev.thumbnailUrl,
          channelTitle: video.channelTitle || prev.channelTitle,
          description: video.description || prev.description,
          duration: hasDuration ? Number(video.duration) : prev.duration,
          durationUnknown: hasDuration ? false : Boolean(video.durationUnknown ?? prev.durationUnknown),
          hadUnknownDuration,
          year: video.year || prev.year,
        }
      : {
          ...video,
          durationUnknown: hasDuration ? false : Boolean(video.durationUnknown),
          hadUnknownDuration,
        };
    this.videos.delete(video.id);
    this.videos.set(video.id, { value: merged, expiresAt: Date.now() + META_TTL_MS });
    while (this.videos.size > META_CACHE_MAX) {
      this.videos.delete(this.videos.keys().next().value);
    }
    return merged;
  }

  cachedVideo(id) {
    const hit = this.videos.get(id);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.videos.delete(id);
      return null;
    }
    return hit.value;
  }

  cachePlaylist(playlist) {
    if (!playlist?.id) return;
    this.playlists.delete(playlist.id);
    this.playlists.set(playlist.id, { value: playlist, expiresAt: Date.now() + META_TTL_MS });
    while (this.playlists.size > PLAYLIST_CACHE_MAX) {
      this.playlists.delete(this.playlists.keys().next().value);
    }
  }

  cachedPlaylist(id) {
    const hit = this.playlists.get(id);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.playlists.delete(id);
      return null;
    }
    return hit.value;
  }

  coalesce(key, fn) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  async getVideoMeta(videoId, { forEmbed = false } = {}) {
    if (!VIDEO_ID.test(videoId || '')) throw fail('Invalid YouTube video ID', 404);
    const cached = this.cachedVideo(videoId);
    const canUseUnknown = this.delivery === 'embed' || this.delivery === 'auto';
    if (
      cached &&
      (!forEmbed || !this.apiKey || cached.embeddable !== undefined) &&
      (cached.duration > 0 || (canUseUnknown && cached.durationUnknown))
    ) {
      return cached;
    }

    return this.coalesce('video:' + videoId, async () => {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      if (this.apiKey) {
        const map = await fetchVideos([videoId], { apiKey: this.apiKey, fetch: this.fetch });
        const found = map.get(videoId);
        if (!found) throw fail('YouTube video is unavailable or private', 404);
        return this.cacheVideo(found);
      }
      if (!forEmbed && this.cache) {
        try {
          const res = await this.cache.metadata(url);
          return this.cacheVideo(res.video);
        } catch (error) {
          if (this.delivery !== 'auto' || error?.name === 'AbortError') throw error;
          this.logger?.warn?.(
            'YouTube',
            `yt-dlp metadata failed for ${videoId} (${error?.message || error}); falling back to oEmbed`,
          );
        }
      }
      if (canUseUnknown) {
        if (cached && cached.duration > 0) return cached;
        const meta = await fetchOEmbed(videoId, { fetch: this.fetch });
        this.rememberProvisionalDuration(videoId);
        return this.cacheVideo(meta);
      }
      throw fail('YouTube metadata source is not configured', 500);
    });
  }

  async getPlaylistMeta(playlistId) {
    if (!PLAYLIST_ID.test(playlistId || '')) throw fail('Invalid YouTube playlist ID', 404);
    const cached = this.cachedPlaylist(playlistId);
    if (cached) return cached;

    return this.coalesce('playlist:' + playlistId, async () => {
      const url = `https://www.youtube.com/playlist?list=${playlistId}`;
      let pl;
      if (this.apiKey) {
        pl = await fetchPlaylist(playlistId, {
          apiKey: this.apiKey,
          fetch: this.fetch,
          limit: this.playlistLimit,
        });
      } else if (this.cache) {
        pl = await this.cache.metadata(url, { limit: this.playlistLimit });
        if (pl.kind !== 'playlist') throw fail('That link did not resolve to a YouTube playlist', 400);
      } else {
        throw fail(
          'YouTube playlists in IFrame embed mode require a YouTube Data API v3 key (or yt-dlp in Auto mode)',
          400,
        );
      }
      pl.items = (pl.items || []).map(v => this.cacheVideo(v)).filter(Boolean);
      this.cachePlaylist(pl);
      return pl;
    });
  }

  toCatalogItem(video) {
    const canUseUnknown = this.delivery === 'embed' || this.delivery === 'auto';
    const unknown = !(Number(video.duration) > 0) && !!video.durationUnknown && canUseUnknown;
    const duration = Number(video.duration) > 0 ? Number(video.duration) : unknown ? UNKNOWN_EMBED_DURATION : 0;
    return {
      id: video.id,
      type: 'movie',
      title: video.title || 'YouTube video',
      subtitle: video.channelTitle || 'YouTube',
      duration,
      ...(unknown ? { durationUnknown: true } : {}),
      ...(video.year ? { year: video.year } : {}),
      ...(video.summary || video.description ? { summary: (video.summary || video.description).slice(0, 500) } : {}),
      available:
        (duration > 0 || unknown) &&
        video.status !== 'failed' &&
        !video.isLive &&
        (this.delivery !== 'embed' || video.embeddable !== false),
      hasPoster: true,
      hasLandscape: true,
      hasBackdrop: true,
    };
  }

  /** Resolves a pasted YouTube video, Short, or playlist URL into library metadata. */
  async resolveUrl(rawUrl) {
    const parsed = parseYouTubeUrl(rawUrl);
    if (parsed.kind === 'playlist') {
      const pl = await this.getPlaylistMeta(parsed.playlistId);
      const items = (pl.items || [])
        .filter(v => !v.isLive && Number(v.duration) > 0 && (this.delivery !== 'embed' || v.embeddable !== false))
        .map(v => this.toCatalogItem(v));
      return {
        kind: 'playlist',
        id: pl.id,
        title: pl.title || 'YouTube playlist',
        channelTitle: pl.channelTitle || '',
        itemCount: pl.itemCount || items.length,
        items,
      };
    }

    const video = await this.getVideoMeta(parsed.videoId);
    if (video.isLive) throw fail('Live streams and upcoming premieres are not supported', 400);
    if (this.delivery === 'embed' && video.embeddable === false)
      throw fail('This video has embedding disabled by its owner', 400);
    const canUseUnknown = (this.delivery === 'embed' || this.delivery === 'auto') && !!video.durationUnknown;
    if (!(Number(video.duration) > 0) && !canUseUnknown) throw fail('This YouTube video has no playable duration', 400);
    return {
      kind: 'video',
      item: this.toCatalogItem(video),
      ...(parsed.playlistId
        ? { playlist: { id: parsed.playlistId, url: `https://www.youtube.com/playlist?list=${parsed.playlistId}` } }
        : {}),
    };
  }

  async browse(query = {}) {
    if (!query.section && !query.parent && !query.collection) {
      return {
        items: [
          {
            id: 'youtube',
            title: this.name || 'YouTube',
            type: 'library',
            mediaType: 'movie',
            source: 'link',
            collections: false,
            filters: false,
            autoQueue: false,
          },
        ],
        total: 1,
        offset: 0,
        nextOffset: null,
      };
    }
    const recent = this.cache ? await this.cache.recent(60).catch(() => []) : [];
    const items = recent.map(v => this.cacheVideo(v)).filter(v => Number(v?.duration) > 0);
    const rawSearch = query.q ?? query.search;
    const search = typeof rawSearch === 'string' ? rawSearch.trim().toLowerCase() : '';
    const filtered = search
      ? items.filter(
          v =>
            (v.title && v.title.toLowerCase().includes(search)) ||
            (v.channelTitle && v.channelTitle.toLowerCase().includes(search)),
        )
      : items;
    const offset = Math.max(0, Number(query.offset) || 0);
    const slice = filtered.slice(offset, offset + PAGE).map(v => this.toCatalogItem(v));
    return {
      items: slice,
      total: filtered.length,
      offset,
      nextOffset: offset + PAGE < filtered.length ? offset + PAGE : null,
      source: 'link',
    };
  }

  async filters() {
    return { genres: [], years: [] };
  }

  async recentlyAdded() {
    if (!this.cache) return [];
    const recent = await this.cache.recent(15).catch(() => []);
    return recent
      .map(v => this.cacheVideo(v))
      .filter(v => Number(v?.duration) > 0)
      .map(v => this.toCatalogItem(v));
  }

  async details(id, type) {
    if (type === 'playlist' || (!VIDEO_ID.test(id || '') && PLAYLIST_ID.test(id || ''))) {
      const pl = await this.getPlaylistMeta(id);
      return {
        id: pl.id,
        type: 'playlist',
        title: pl.title,
        subtitle: pl.channelTitle || 'YouTube playlist',
        directors: [],
        cast: [],
        ratings: [],
        otherEditions: [],
        mediaInfo: [`${pl.items.length} videos`, 'YouTube'].slice(0, 60),
      };
    }
    const video = await this.getVideoMeta(id);
    return {
      ...this.toCatalogItem(video),
      directors: [],
      cast: [],
      ratings: [],
      otherEditions: [],
      mediaInfo: [
        video.channelTitle,
        video.height ? video.height + 'p' : '',
        video.videoCodec,
        video.audioCodec,
        'YouTube',
      ]
        .filter(Boolean)
        .map(v => String(v).slice(0, 60)),
    };
  }

  async queueItems({ type, id }) {
    if (type !== 'playlist' || !PLAYLIST_ID.test(id || '')) throw fail('Unsupported YouTube bulk queue type', 400);
    const pl = await this.getPlaylistMeta(id);
    const items = (pl.items || [])
      .filter(v => !v.isLive && Number(v.duration) > 0 && (this.delivery !== 'embed' || v.embeddable !== false))
      .map(v => this.toCatalogItem(v));
    if (!items.length) throw fail('This YouTube playlist has no playable videos', 400);
    return items;
  }

  async playableItem(id) {
    if (!VIDEO_ID.test(id || '')) throw fail('Select a YouTube video', 400);
    const video = await this.getVideoMeta(id);
    if (video.isLive) throw fail('Live streams and upcoming premieres are not supported', 400);
    if (this.delivery === 'embed' && video.embeddable === false)
      throw fail('This video has embedding disabled by its owner', 400);
    const canUseUnknown = (this.delivery === 'embed' || this.delivery === 'auto') && !!video.durationUnknown;
    if (!(Number(video.duration) > 0) && !canUseUnknown) throw fail('This YouTube video has no playable duration', 400);
    return this.toCatalogItem(video);
  }

  async availability(ids) {
    const valid = (ids || []).filter(id => VIDEO_ID.test(id));
    const map = new Map();
    const canUseUnknown = this.delivery === 'embed' || this.delivery === 'auto';
    if (this.apiKey && valid.length) {
      const found = await fetchVideos(valid, { apiKey: this.apiKey, fetch: this.fetch });
      for (const id of valid) {
        const v = found.get(id);
        if (v) this.cacheVideo(v);
        map.set(
          id,
          !!v && !v.isLive && Number(v.duration) > 0 && (this.delivery !== 'embed' || v.embeddable !== false),
        );
      }
      return map;
    }
    for (const id of valid) {
      const cached = this.cachedVideo(id);
      if (cached) {
        map.set(
          id,
          cached.status !== 'failed' &&
            !cached.isLive &&
            (Number(cached.duration) > 0 || (canUseUnknown && !!cached.durationUnknown)) &&
            (this.delivery !== 'embed' || cached.embeddable !== false),
        );
      }
    }
    return map;
  }

  async warmQueue(items) {
    if (this.closed || this.delivery === 'embed' || !this.cache) return;
    const valid = (items || []).filter(item => item?.id && VIDEO_ID.test(item.id)).map(item => ({ id: item.id }));
    if (!valid.length) return;
    await this.cache.warm(valid);
  }

  async artwork(id) {
    if (!VIDEO_ID.test(id || '')) throw fail('Artwork unavailable', 404);
    let video = this.cachedVideo(id);
    if (!video?.thumbnailUrl) {
      video = await this.getVideoMeta(id).catch(() => null);
    }
    const candidates = [video?.thumbnailUrl, `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`].filter(
      url => isAllowedThumbnailUrl(url),
    );

    for (const url of candidates) {
      let response;
      try {
        response = await this.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        continue;
      }
      const type = response.headers?.get?.('content-type') || 'image/jpeg';
      if (!/^image\/(jpeg|png|webp)\b/i.test(type)) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > ART_LIMIT) continue;
      return { type: type.split(';')[0], bytes };
    }
    throw fail('Artwork unavailable', 404);
  }

  async allows(id) {
    return VIDEO_ID.test(id || '');
  }

  async visible(id, type) {
    return type === 'playlist' ? PLAYLIST_ID.test(id || '') : VIDEO_ID.test(id || '');
  }

  async prepareEmbed(id, _choices = {}, { fallbackFromYtdlp = false } = {}) {
    if (!VIDEO_ID.test(id || '')) throw Object.assign(new PlaybackError('Invalid YouTube video ID.'), { status: 400 });
    let video;
    try {
      video = await this.getVideoMeta(id, { forEmbed: true });
    } catch (error) {
      if (error instanceof PlaybackError) throw error;
      const msg =
        fallbackFromYtdlp && error?.notEmbeddable
          ? 'yt-dlp could not download this video, and embedding is disabled by its owner.'
          : error?.message || 'Could not load YouTube video for embedded playback.';
      throw Object.assign(new PlaybackError(msg), { status: error?.status || 502 });
    }
    if (video.isLive) {
      throw Object.assign(new PlaybackError('Live streams and upcoming premieres are not supported.'), { status: 400 });
    }
    if (video.embeddable === false) {
      throw Object.assign(
        new PlaybackError(
          fallbackFromYtdlp
            ? 'yt-dlp could not download this video, and embedding is disabled by its owner.'
            : 'This video has embedding disabled by its owner.',
        ),
        { status: 400 },
      );
    }
    const durationUnknown = !(Number(video.duration) > 0);
    const duration = durationUnknown ? UNKNOWN_EMBED_DURATION : Number(video.duration);
    if (durationUnknown) this.rememberProvisionalDuration(id);
    return {
      title: video.title || 'YouTube video',
      subtitle: video.channelTitle || 'YouTube',
      duration,
      durationUnknown,
      durationTolerance:
        durationUnknown || video.hadUnknownDuration || this.provisionalDurations.has(id) ? Infinity : 2,
      kind: this.kind,
      type: 'movie',
      format: 'youtube-embed',
      embed: {
        provider: 'youtube',
        videoId: id,
        watchUrl: `https://www.youtube.com/watch?v=${id}`,
      },
      qualities: [{ id: 'direct', label: 'YouTube Auto' }],
      quality: 'direct',
      deliveryReason: fallbackFromYtdlp ? 'youtube-embed-fallback' : 'youtube-embed',
      resources: new Map(),
      id,
      principal: this.principal,
      provider: this,
      chapters: [],
      markers: [],
    };
  }

  async prepare(id, quality, compatible = false, source, fallback, choices = {}) {
    if (source?.format === 'youtube-embed') {
      return {
        ...source,
        resources: new Map(),
        quality: 'direct',
      };
    }
    if (this.delivery === 'embed') {
      return this.prepareEmbed(id, choices);
    }
    const release = this.cache?.acquire(id);
    let media;
    try {
      if (this.delivery === 'auto' && !source?.sourceStart) {
        try {
          if (!this.cache) throw new Error('YouTube cache directory is not configured');
          const prepared = await this.cache.prepare(id, { signal: choices.signal || currentSignal() });
          if (!(Number(prepared.duration) > 0)) {
            throw Object.assign(new PlaybackError('This YouTube video has no playable duration.'), { status: 400 });
          }
        } catch (error) {
          if (
            error?.name === 'AbortError' ||
            choices.signal?.aborted ||
            currentSignal()?.aborted ||
            error?.status === 400
          ) {
            throw error;
          }
          this.logger?.warn?.(
            'YouTube',
            `yt-dlp failed for ${id} (${error?.message || error}); falling back to IFrame embed`,
          );
          return this.prepareEmbed(id, choices, { fallbackFromYtdlp: true });
        }
      }
      media = await prepareStream(this, id, quality, compatible, source, fallback, {
        ...choices,
        [CACHE_LEASE]: release,
      });
      return media;
    } finally {
      if (!media) release?.();
    }
  }

  async source(id, _previous, choices = {}) {
    if (!VIDEO_ID.test(id || '')) throw Object.assign(new PlaybackError('Invalid YouTube video ID.'), { status: 400 });
    if (this.delivery === 'embed') {
      return { media: await this.prepareEmbed(id, choices), detail: {} };
    }
    if (!this.cache) {
      throw Object.assign(new PlaybackError('YouTube cache directory is not configured.'), { status: 500 });
    }

    const sharedLease = choices[CACHE_LEASE];
    const release = sharedLease || this.cache.acquire(id);
    try {
      const prepared = await this.cache.prepare(id, { signal: choices.signal || currentSignal() });
      const media = this.cachedMedia(id, prepared, choices);
      media.releaseCacheLease = release;
      return { media, detail: {} };
    } catch (error) {
      if (!sharedLease) release();
      throw error;
    }
  }

  cachedMedia(id, prepared, choices) {
    const cached = this.cacheVideo({ ...prepared, status: 'ready' });
    if (!(Number(prepared.duration) > 0)) {
      throw Object.assign(new PlaybackError('This YouTube video has no playable duration.'), { status: 400 });
    }

    const sources = [];
    if (Array.isArray(prepared.streams)) {
      for (const stream of prepared.streams) {
        const kind =
          stream.codec_type === 'audio' ? 'audio' : stream.codec_type === 'subtitle' ? 'subtitles' : undefined;
        if (!kind || !Number.isSafeInteger(stream.index)) continue;
        const lang = stream.language && stream.language !== 'und' ? stream.language : undefined;
        sources.push({
          kind,
          id: (kind === 'audio' ? 'a' : 's') + stream.index,
          index: stream.index,
          codec: stream.codec_name,
          language: stream.language,
          title: stream.title,
          label: [stream.title || lang?.toUpperCase(), kind === 'audio' && stream.codec_name?.toUpperCase()]
            .filter(Boolean)
            .join(' · '),
          default: !!stream.default,
          forced: !!stream.forced,
          sdh: !!stream.sdh,
          commentary: !!stream.commentary,
          description: !!stream.description,
          channels: stream.channels,
        });
      }
    } else if (prepared.audioCodec) {
      sources.push({
        kind: 'audio',
        id: 'a0',
        codec: prepared.audioCodec,
        language: 'und',
        label: prepared.audioCodec.toUpperCase(),
        default: true,
      });
    }
    for (const [idx, sub] of (prepared.subtitles || []).entries()) {
      const subBase = `${ORIGIN}/sub/${encodeURIComponent(id)}/${encodeURIComponent(sub.id)}/`;
      sources.push({
        kind: 'subtitles',
        id: 'x' + idx,
        codec: 'webvtt',
        language: sub.language,
        label: [sub.label || sub.language?.toUpperCase(), 'YouTube'].filter(Boolean).join(' · '),
        resources: {
          data: subBase + 'data',
          text: subBase + 'text',
        },
      });
    }

    const container = prepared.container || 'mp4';
    const hdr = prepared.hdr || { hdr: false, kind: 'sdr', label: 'SDR', doviProfile: null };
    const bitDepth = Number(prepared.bitDepth) || (hdr.hdr ? 10 : 8);
    const media = {
      title: cached?.title || prepared.title || 'YouTube video',
      subtitle: cached?.channelTitle || prepared.channelTitle || 'YouTube',
      duration: prepared.duration,
      durationTolerance: 2,
      kind: this.kind,
      type: 'movie',
      resources: new Map(),
      id,
      principal: this.principal,
      provider: this,
      filename: prepared.filename,
      container,
      videoCodec: prepared.videoCodec,
      audioCodec: prepared.audioCodec,
      hdr: !!hdr.hdr,
      hdrKind: hdr.kind || 'sdr',
      hdrLabel: hdr.label || 'SDR',
      doviProfile: hdr.doviProfile ?? null,
      bitDepth,
      sourceHdr: !!hdr.hdr,
      sourceHdrKind: hdr.kind || 'sdr',
      sourceHdrLabel: hdr.label || 'SDR',
      sourceBitrate: prepared.bitrate,
      sourceWidth: prepared.width,
      sourceHeight: prepared.height,
      size: prepared.size,
      fileSize: Number(prepared.size) || undefined,
      chapters: [],
      markers: [],
    };
    media.tracks = Tracks.catalog(sources, {
      browserSubtitles: choices.browserSubtitles,
      extractSubtitles: !!this.pipeline?.av1?.ffmpeg,
    });
    media.selection = Tracks.select(media.tracks, choices);
    const name = prepared.filename || `${id}.${container}`;
    media.sourceStart = `${ORIGIN}/file/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
    media.sourceKey = JSON.stringify([YOUTUBE_SERVER, id, prepared.size || 0, prepared.mtimeMs || 0]);
    media.captionVersion = randomUUID();
    media.subtitleAbort = new AbortController();
    return media;
  }

  async filePath(media) {
    if (!this.cache || !media?.id) return undefined;
    const hit = await this.cache.resolveMediaFile(media.id);
    return hit ? hit.file : undefined;
  }

  url(resource) {
    let url;
    try {
      url = new URL(resource, ORIGIN + '/');
    } catch {
      throw fail('Invalid YouTube media resource', 400);
    }
    if (url.protocol !== 'uburoom-youtube:' || url.host !== 'media' || url.search || url.hash) {
      throw fail('Invalid YouTube media resource', 400);
    }
    return url;
  }

  async request(resource, options = {}) {
    const url = this.url(resource);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'file' && SAFE_ID.test(parts[1] || '')) {
      if (!this.cache) throw fail('YouTube cache is not configured', 500);
      const release = this.cache.acquire(parts[1]);
      let streaming = false;
      try {
        const hit = await this.cache.resolveMediaFile(parts[1]);
        if (!hit) throw fail('Cached YouTube video is unavailable', 404);
        const size = hit.stat.size;
        const range = Object.entries(options.headers || {}).find(([k]) => k.toLowerCase() === 'range')?.[1];
        let start = 0;
        let end = size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (match && !match[1] && match[2]) start = Math.max(0, size - Number(match[2]));
          else if (match?.[1]) {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
          }
          if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end || start >= size) {
            throw fail('Requested range is outside this file', 416);
          }
        }
        const headers = {
          'Content-Type': hit.contentType,
          'Content-Length': String(size ? end - start + 1 : 0),
          'Accept-Ranges': 'bytes',
        };
        if (range && size) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        if (options.method === 'HEAD' || !size)
          return new Response(null, { status: range && size ? 206 : 200, headers });
        const body = fileStream(hit.file, { start, end, signal: options.signal, onClose: release });
        const response = new Response(body, { status: range ? 206 : 200, headers });
        streaming = true;
        return response;
      } finally {
        if (!streaming) release();
      }
    }

    if (parts[0] === 'sub' && SAFE_ID.test(parts[1] || '') && SAFE_TRACK.test(parts[2] || '')) {
      if (!this.cache) throw fail('YouTube cache is not configured', 500);
      const release = this.cache.acquire(parts[1]);
      try {
        const subFile = await this.cache.resolveSubtitleFile(parts[1], parts[2]);
        if (!subFile) throw fail('Subtitle track unavailable', 404);
        const stat = await fsp.stat(subFile);
        if (stat.size > TEXT_LIMIT) throw fail('Subtitle file exceeds the supported size', 413);
        if (options.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': String(stat.size) },
          });
        }
        const text = await fsp.readFile(subFile, { encoding: 'utf8', signal: options.signal });
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'text/vtt; charset=utf-8' },
        });
      } finally {
        release();
      }
    }

    throw fail('Invalid YouTube media resource', 400);
  }

  async stop(media) {
    if (!media || media.format === 'youtube-embed') return;
    try {
      await runOperation(undefined, () => this.pipeline?.release?.(media));
    } finally {
      media.releaseCacheLease?.();
    }
  }

  async close() {
    this.closed = true;
    await this.cache?.close();
  }
}

/**
 * One YouTube source as a media provider under the fixed `youtube` server identity.
 */
function youtubeProvider({ source, config, pipeline, logger, youtubeFetch, youtubeRunner, platform }) {
  const delivery = source.delivery || 'auto';
  const provider = new YouTubeMedia({
    delivery,
    apiKey: source.apiKey,
    ytDlp: source.ytDlp,
    ffmpegPath: config?.ffmpegPath,
    ffprobePath: config?.ffprobePath,
    cacheDirectory: source.cacheDirectory,
    maxCacheGb: source.maxCacheGb,
    maxConcurrent: source.maxConcurrent,
    cookiesFile: source.cookiesFile,
    poTokenUrl: source.poTokenUrl,
    playlistLimit: source.playlistLimit,
    label: source.name || 'YouTube',
    pipeline,
    fetch: youtubeFetch || fetch,
    runCommand: youtubeRunner,
    platform: platform || process.platform,
    logger,
  });
  return {
    kind: 'youtube',
    root: provider,
    identity: async () => YOUTUBE_SERVER,
    scopeFor: async () => provider,
    ...(delivery === 'embed' || delivery === 'auto'
      ? {
          embedPolicy: {
            scriptSrc: ['https://www.youtube.com'],
            frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
            referrerPolicy: 'strict-origin-when-cross-origin',
          },
        }
      : {}),
  };
}

module.exports = { YouTubeMedia, youtubeProvider, YOUTUBE_SERVER, UNKNOWN_EMBED_DURATION };
