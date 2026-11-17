'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { PlaybackError, classifyHdr } = require('./av1');
const Tracks = require('./media-tracks');
const { LocalIndex } = require('./local/index');
const { prepareStream } = require('./media-delivery');
const { runOperation, currentSignal } = require('./operation');

/** The server id every local library is recorded under. */
const LOCAL_SERVER = 'local-media';
const ORIGIN = 'uburoom-local://media';
const PAGE = 48,
  TEXT_LIMIT = 4 * 1024 * 1024;
const TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
};
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
function unavailable(entry) {
  return Object.assign(new PlaybackError(entry.title + ' is unavailable.'), {
    code: 'MEDIA_UNAVAILABLE',
    status: 409,
    mediaId: entry.token,
    title: entry.title,
  });
}
// Like a media server's line under a title: the year and edition once the name says them, otherwise the subfolder.
const subtitle = entry => [entry.year, entry.edition].filter(Boolean).join(' · ') || entry.folder;
const seconds = value => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const tag = (stream, name) => {
  const tags = stream?.tags || {};
  const key = Object.keys(tags).find(candidate => candidate.toLowerCase() === name);
  return key ? String(tags[key]) : undefined;
};
// A sidecar is text only once it is UTF-8; older subtitle files are often a
// single-byte Windows encoding or UTF-16 with a byte-order mark.
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Videos in folders on the server's own disk. It has no accounts of its own, so
 * everyone uburoom admits watches through the same scope; who is admitted stays
 * the access policy's decision. It supplies sources only: every conversion is
 * uburoom's own, reading bytes through `request()` like any other provider.
 * See server/media-provider.js for the contract.
 */
class LocalMedia {
  /** @param {{id: string, name: string, paths: string[], parseNames?: boolean}[]} libraries @param {{pipeline: any, logger?: any}} services */
  constructor(libraries, { pipeline, logger }) {
    this.libraries = libraries;
    this.pipeline = pipeline;
    this.index = new LocalIndex(libraries, { logger });
  }
  get kind() {
    return 'local';
  }
  get configured() {
    return this.libraries.length > 0;
  }
  get principal() {
    return LOCAL_SERVER;
  }
  get root() {
    return this;
  }
  // Catalog
  item(entry) {
    const info = this.index.known(entry);
    return {
      id: entry.token,
      section: entry.library,
      type: 'movie',
      title: entry.title,
      subtitle: subtitle(entry),
      ...(entry.year ? { year: entry.year } : {}),
      duration: info?.duration || 0,
      available: true,
      edition: entry.edition,
      sortTitle: entry.sortTitle,
      contentRating: '',
      addedAt: 0,
      genres: [],
      genreIds: [],
      count: 0,
      episodeCount: 0,
      showTitle: '',
      parentTitle: '',
      hasPoster: false,
      hasLandscape: false,
      summary: '',
    };
  }
  async entry(id) {
    await this.index.refresh();
    const entry = this.index.get(id);
    if (!entry) throw failure('Select a video from the library', 404);
    return entry;
  }
  // The file as it is now. A file that has gone is unavailable, not an error.
  async described(entry) {
    let stat;
    try {
      stat = await fsp.stat(entry.path);
    } catch {
      throw unavailable(entry);
    }
    if (!stat.isFile()) throw unavailable(entry);
    const info = await this.index.probe(entry, stat, file => this.probe(file));
    return { stat, info };
  }
  async probe(file) {
    const av1 = this.pipeline.av1;
    if (!av1?.ffprobe) throw new PlaybackError('Local media needs FFprobe; set tools.ffprobe or add it to PATH.');
    let data;
    try {
      data = JSON.parse(
        (
          await av1.run(
            av1.ffprobe,
            ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file],
            currentSignal() || AbortSignal.timeout(30000),
            30000,
            8 * 1024 * 1024,
          )
        ).toString(),
      );
    } catch {
      throw new PlaybackError('This file could not be read as a video.');
    }
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const duration = seconds(data.format?.duration) || seconds(video?.duration);
    if (!video || !(duration > 0)) throw new PlaybackError('This file could not be read as a video.');
    return {
      duration,
      bitrate: Math.round(seconds(data.format?.bit_rate) / 1000) || undefined,
      video,
      streams,
      container: String(data.format?.format_name || '').split(',')[0],
      chapters: (Array.isArray(data.chapters) ? data.chapters : [])
        .map((chapter, index) => {
          const start = seconds(chapter.start_time),
            end = seconds(chapter.end_time);
          return {
            id: String(index + 1),
            index: index + 1,
            title: String(tag(chapter, 'title') || 'Chapter ' + (index + 1)).slice(0, 100),
            startTime: Math.round(start * 1000) / 1000,
            endTime: Math.round((end > start ? end : duration) * 1000) / 1000,
          };
        })
        .sort((a, b) => a.startTime - b.startTime),
    };
  }
  async browse(options = {}) {
    const { section, parent, collection, tab = 'library', q = '', sort, order = 'asc', seed } = options;
    const offset = Number(options.offset || 0);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof q !== 'string' ||
      q.length > 200 ||
      !['asc', 'desc'].includes(order) ||
      !['library', 'collections'].includes(tab)
    )
      throw failure('Invalid library query');
    await this.index.refresh();
    if (!section && !parent && !collection) {
      const items = this.libraries.map(library => ({
        id: library.id,
        title: library.name,
        type: 'library',
        mediaType: 'movie',
        source: 'folder',
        collections: false,
        filters: false,
        autoQueue: false,
      }));
      return { items, total: items.length, offset: 0, nextOffset: null };
    }
    if (!this.libraries.some(library => library.id === section)) throw failure('Select a library', 404);
    // Folders hold videos only: no collections and nothing inside an item.
    if (parent || collection || tab === 'collections') return { items: [], total: 0, offset: 0, nextOffset: null };
    const needle = q.trim().toLowerCase();
    let entries = this.index.list(section);
    if (needle)
      entries = entries.filter(
        entry =>
          entry.title.toLowerCase().includes(needle) ||
          entry.folder.toLowerCase().includes(needle) ||
          (!!entry.year && String(entry.year) === needle),
      );
    if (sort === 'random') {
      if (!/^[a-f0-9]{32}$/.test(seed || '')) throw failure('Invalid shuffle seed');
      const rank = entry =>
        createHash('sha256')
          .update(seed + entry.token)
          .digest('hex');
      entries = entries
        .map(entry => ({ entry, rank: rank(entry) }))
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map(row => row.entry);
    } else if (order === 'desc') entries = [...entries].reverse();
    const page = entries.slice(offset, offset + PAGE);
    return {
      items: page.map(entry => this.item(entry)),
      total: entries.length,
      offset,
      nextOffset: offset + PAGE < entries.length ? offset + PAGE : null,
    };
  }
  async filters() {
    return { genres: [], years: [] };
  }
  async details(id) {
    const entry = await this.entry(id);
    const { info } = await this.described(entry);
    const audio = info.streams.find(stream => stream.codec_type === 'audio');
    return {
      ...this.item(entry),
      directors: [],
      cast: [],
      ratings: [],
      otherEditions: [],
      mediaInfo: [
        info.video.height ? info.video.height + 'p' : '',
        info.video.codec_name,
        info.bitrate ? (info.bitrate / 1000).toFixed(1) + ' Mbps' : '',
        audio?.codec_name,
        audio?.channels ? audio.channels + ' channels' : '',
        info.container,
      ]
        .filter(Boolean)
        .map(value => String(value).slice(0, 60)),
    };
  }
  async playableItem(id) {
    const entry = await this.entry(id);
    await this.described(entry);
    return this.item(entry);
  }
  async availability(ids = []) {
    await this.index.refresh();
    const status = new Map();
    for (const id of ids) {
      const entry = this.index.get(id);
      status.set(
        id,
        !!entry &&
          (await fsp.access(entry.path, fs.constants.R_OK).then(
            () => true,
            () => false,
          )),
      );
    }
    return status;
  }
  async queueItems({ type, id } = {}) {
    await this.index.refresh();
    if (type !== 'library' || !this.libraries.some(library => library.id === id))
      throw failure('Select a library', 404);
    const items = [];
    for (const entry of this.index.list(id)) {
      // A queue entry records its duration, so every queued file is read once.
      try {
        await this.described(entry);
        items.push(this.item(entry));
      } catch {
        /* A file that cannot be read is left out of the queue. */
      }
    }
    return items;
  }
  async artwork() {
    throw failure('Artwork unavailable', 404);
  }
  async allows(id) {
    await this.index.refresh();
    return !!this.index.get(id);
  }
  visible(id) {
    return this.allows(id);
  }
  // Delivery
  url(resource) {
    const url = new URL(resource, ORIGIN + '/');
    if (url.origin !== 'null' || url.protocol !== 'uburoom-local:' || url.host !== 'media' || url.search || url.hash)
      throw new Error('Invalid local media resource');
    return url;
  }
  // The file a resource names, found through the index: `/file/<token>` is the video,
  // `/sub/<token>/<n>/<part>` one part of its n-th sidecar subtitle.
  async locate(resource) {
    const parts = this.url(resource).pathname.split('/').slice(1);
    const entry = this.index.get(parts[1]) || (await this.index.refresh(), this.index.get(parts[1]));
    if (!entry) throw failure('Local media unavailable', 404);
    if (parts[0] === 'file' && parts.length === 2)
      return { file: entry.path, type: TYPES[path.extname(entry.path).toLowerCase()] };
    if (parts[0] === 'sub' && parts.length === 4 && /^\d{1,2}$/.test(parts[2])) {
      const sidecar = (await this.index.sidecars(entry))[Number(parts[2])];
      const file =
        parts[3] === 'index' ? sidecar?.index : ['data', 'text'].includes(parts[3]) ? sidecar?.file : undefined;
      if (file) return { file, text: parts[3] === 'text', type: 'application/octet-stream' };
    }
    throw failure('Local media unavailable', 404);
  }
  /** The file on this machine a prepared item's bytes come from; FFmpeg may read it directly. */
  async filePath(media) {
    return (await this.locate(media.sourceStart)).file;
  }
  /** Read a local resource as an HTTP response would carry it, honouring one byte range. */
  async request(resource, options = {}) {
    const { file, text, type = 'application/octet-stream' } = await this.locate(resource);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw failure('Local media unavailable', 404);
    }
    if (!stat.isFile()) throw failure('Local media unavailable', 404);
    if (text) {
      if (stat.size > TEXT_LIMIT) throw failure('Subtitle file exceeds the supported size', 413);
      return new Response(decodeText(await fsp.readFile(file, { signal: options.signal })), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const size = stat.size,
      range = Object.entries(options.headers || {}).find(([name]) => name.toLowerCase() === 'range')?.[1];
    let start = 0,
      end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && !match[1] && match[2]) start = Math.max(0, size - Number(match[2]));
      else if (match?.[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end || start >= size)
        throw failure('Requested range is outside this file', 416);
    }
    const headers = { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (options.method === 'HEAD' || !size) return new Response(null, { status: range ? 206 : 200, headers });
    const stream = fs.createReadStream(file, { start, end, signal: options.signal });
    return new Response(/** @type {any} */ (Readable.toWeb(stream)), { status: range ? 206 : 200, headers });
  }
  prepare(id, quality, compatible = false, source, fallback, choices = {}) {
    return prepareStream(this, id, quality, compatible, source, fallback, choices);
  }
  async source(id, _previous, choices = {}) {
    const entry = await this.entry(id);
    const { stat, info } = await this.described(entry);
    const hdr = classifyHdr(info.video);
    const audio = info.streams.filter(stream => stream.codec_type === 'audio');
    const language = stream => tag(stream, 'language');
    const flag = (stream, name) => stream.disposition?.[name] === 1;
    const sources = [];
    for (const stream of info.streams) {
      const kind = stream.codec_type === 'audio' ? 'audio' : stream.codec_type === 'subtitle' ? 'subtitles' : undefined;
      if (!kind || !Number.isSafeInteger(stream.index)) continue;
      const name = tag(stream, 'title');
      sources.push({
        kind,
        id: (kind === 'audio' ? 'a' : 's') + stream.index,
        index: stream.index,
        codec: stream.codec_name,
        language: language(stream),
        title: name,
        label: [name || language(stream)?.toUpperCase(), kind === 'audio' && stream.codec_name?.toUpperCase()]
          .filter(Boolean)
          .join(' · '),
        default: flag(stream, 'default'),
        forced: flag(stream, 'forced'),
        sdh: flag(stream, 'hearing_impaired'),
        commentary: flag(stream, 'comment'),
        description: flag(stream, 'visual_impaired'),
        channels: stream.channels,
      });
    }
    for (const [number, sidecar] of (await this.index.sidecars(entry)).entries()) {
      const base = `${ORIGIN}/sub/${entry.token}/${number}/`;
      sources.push({
        kind: 'subtitles',
        id: 'x' + number,
        codec: sidecar.codec,
        language: sidecar.language,
        label: [sidecar.language?.toUpperCase(), sidecar.forced && 'Forced', sidecar.sdh && 'SDH', 'External']
          .filter(Boolean)
          .join(' · '),
        forced: sidecar.forced,
        sdh: sidecar.sdh,
        resources: {
          data: base + 'data',
          ...(['subrip', 'webvtt'].includes(sidecar.codec) ? { text: base + 'text' } : {}),
          ...(sidecar.index ? { index: base + 'index' } : {}),
        },
      });
    }
    const media = {
      title: entry.title,
      subtitle: subtitle(entry),
      duration: info.duration,
      kind: this.kind,
      type: 'movie',
      resources: new Map(),
      id,
      principal: this.principal,
      provider: this,
      videoCodec: info.video.codec_name,
      audioCodec: (audio.find(stream => flag(stream, 'default')) || audio[0])?.codec_name,
      hdr: hdr.hdr,
      hdrKind: hdr.kind,
      hdrLabel: hdr.label,
      doviProfile: hdr.doviProfile,
      bitDepth: Number(info.video.bits_per_raw_sample) || (hdr.hdr ? 10 : 8),
      sourceHdr: hdr.hdr,
      sourceHdrKind: hdr.kind,
      sourceHdrLabel: hdr.label,
      sourceBitrate: info.bitrate,
      sourceWidth: Number(info.video.width) || undefined,
      sourceHeight: Number(info.video.height) || undefined,
      chapters: info.chapters,
      markers: [],
    };
    media.tracks = Tracks.catalog(sources, {
      browserSubtitles: choices.browserSubtitles,
      extractSubtitles: !!this.pipeline.av1.ffmpeg,
    });
    media.selection = Tracks.select(media.tracks, choices);
    media.sourceStart = `${ORIGIN}/file/${entry.token}`;
    media.sourceKey = JSON.stringify([LOCAL_SERVER, entry.token, stat.size, stat.mtimeMs]);
    media.captionVersion = randomUUID();
    media.subtitleAbort = new AbortController();
    return { media, detail: {} };
  }
  stop(media) {
    return runOperation(undefined, () => this.pipeline.release(media));
  }
  close() {
    this.index.close();
  }
}

/**
 * The configured local libraries as a media provider, or nothing when none are configured.
 * @param {{config: any, pipeline: any, logger?: any}} services
 * @returns {import('./media-providers').MediaProvider | undefined}
 */
function localProvider({ config, pipeline, logger }) {
  const libraries = config.localMedia?.libraries || [];
  if (!libraries.length) return;
  const local = new LocalMedia(libraries, { pipeline, logger });
  return { kind: 'local', root: local, identity: async () => LOCAL_SERVER, scopeFor: async () => local };
}

module.exports = { LocalMedia, localProvider, LOCAL_SERVER };
