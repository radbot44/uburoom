'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { PlaybackError, classifyHdr } = require('./av1');
const Tracks = require('./media-tracks');
const { LocalIndex } = require('./local/index');
const { LocalArt } = require('./local/art');
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
// An episode's line, as Plex writes it: show, season and episode.
const episodeLine = entry =>
  [
    entry.episode.showTitle,
    entry.episode.seasonIndex ? 'Season ' + entry.episode.seasonIndex : 'Specials',
    entry.episode.index !== undefined ? 'Episode ' + entry.episode.index : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 200);
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
  /**
   * @param {{id: string, name: string, paths: string[], parseNames?: boolean}[]} libraries
   * @param {{pipeline: any, logger?: any, artDirectory?: string}} services `artDirectory` holds the pictures
   *   made for local videos; without one, local videos have none.
   */
  constructor(libraries, { pipeline, logger, artDirectory }) {
    this.libraries = libraries;
    this.pipeline = pipeline;
    this.index = new LocalIndex(libraries, { logger });
    this.art = artDirectory ? new LocalArt({ directory: artDirectory, tools: () => pipeline.av1, logger }) : undefined;
    this.logger = logger;
    /** Videos whose picture could not be made, not tried again until the server restarts. */
    this.unpictured = new Set();
    this.warming = undefined;
    this.warmAgain = false;
    // Pictures are made ahead of time from shortly after startup, not only when someone first browses.
    if (this.art)
      this.startup = setTimeout(
        () =>
          void this.index.refresh().then(
            () => this.warm(),
            () => {},
          ),
        30000,
      );
    this.startup?.unref?.();
    this.index.onScanned = () => void this.warm();
  }
  /**
   * Make each video's pictures ahead of time, newest first and one at a time, so a first browse does not
   * wait on FFmpeg. The poster also keeps the video's chosen frame, from which the other kinds are made at
   * once. Waits while a conversion for playback runs, and starts over after a rescan finds new files.
   */
  warm() {
    if (!this.art?.available) return;
    if (this.warming) {
      this.warmAgain = true;
      return;
    }
    this.warming = (async () => {
      do {
        this.warmAgain = false;
        for (const entry of this.index.newest()) {
          if (this.closed) return;
          while (this.pipeline.busy && !this.closed) await new Promise(resolve => setTimeout(resolve, 30000).unref?.());
          // An episode's poster is its show's, made once for the whole show.
          const source = this.index.get(entry.token) && this.pictureSource(entry.token, 'poster');
          if (this.closed || !source || this.unpictured.has(source.subject.token)) continue;
          await this.art
            .picture(source.subject, 'poster', () => this.described(source.video))
            .catch(() => this.unpictured.add(source.subject.token));
        }
      } while (this.warmAgain && !this.closed);
    })().finally(() => {
      this.warming = undefined;
    });
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
  /** A film, or an episode of a show in a `shows` library, as the library shows it. */
  item(entry) {
    const info = this.index.known(entry);
    // With FFmpeg every video has a frame to show; a picture file beside it is used first.
    const frames = !!this.art?.available;
    const place = entry.episode,
      show = place && /** @type {any} */ (this.index.group(place.show));
    return {
      id: entry.token,
      section: entry.library,
      type: place ? 'episode' : 'movie',
      title: entry.title,
      subtitle: place ? episodeLine(entry) : subtitle(entry),
      ...(entry.year ? { year: entry.year } : {}),
      duration: info?.duration || 0,
      available: true,
      edition: entry.edition,
      sortTitle: entry.sortTitle,
      contentRating: '',
      // In seconds, like Plex's.
      addedAt: Math.floor((entry.addedMs || 0) / 1000),
      genres: [],
      genreIds: [],
      count: 0,
      episodeCount: 0,
      showTitle: place ? place.showTitle : '',
      parentTitle: place ? (place.seasonIndex ? 'Season ' + place.seasonIndex : 'Specials') : '',
      ...(place
        ? {
            ...(place.index !== undefined ? { index: place.index } : {}),
            seasonIndex: place.seasonIndex,
            parentId: place.season,
            showId: place.show,
          }
        : {}),
      hasPoster: frames,
      hasLandscape: frames,
      hasBackdrop: frames,
      // An episode shows its show's logo, as a Plex episode does.
      hasLogo: frames && !!(place ? show?.art.logo : entry.art.logo),
      summary: '',
    };
  }
  /** A show or a season of a `shows` library, as the library shows it. */
  groupItem(group) {
    const frames = !!this.art?.available;
    const show = /** @type {any} */ ('seasons' in group ? group : this.index.group(group.show));
    const season = 'seasons' in group ? undefined : group;
    const episodes = season ? season.episodes : show.episodes;
    return {
      id: group.token,
      section: show.library,
      type: season ? 'season' : 'show',
      title: season ? season.title : show.title,
      subtitle: season ? show.title : show.year ? String(show.year) : '',
      ...(!season && show.year ? { year: show.year } : {}),
      duration: 0,
      edition: '',
      sortTitle: season ? season.title : show.sortTitle,
      contentRating: '',
      addedAt: Math.floor(Math.max(0, ...episodes.map(entry => entry.addedMs || 0)) / 1000),
      genres: [],
      genreIds: [],
      count: season ? episodes.length : show.seasons.length,
      episodeCount: episodes.length,
      ...(season ? { index: season.index, parentId: show.token, showTitle: show.title, parentTitle: show.title } : {}),
      showTitle: season ? show.title : '',
      parentTitle: season ? show.title : '',
      hasPoster: frames,
      hasLandscape: frames,
      hasBackdrop: frames,
      hasLogo: frames && !!show.art.logo,
    };
  }
  /**
   * What a picture of an item is made from: for a show, a season or an episode's poster, backdrop and logo, the
   * show's own folder pictures or else its first episode's frame; for an episode's wide picture, its own frame.
   */
  pictureSource(id, kind) {
    const entry = this.index.get(id);
    if (entry && (!entry.episode || kind === 'landscape')) return { subject: entry, video: entry };
    const group = /** @type {any} */ (entry ? this.index.group(entry.episode?.show) : this.index.group(id));
    const show = group && ('seasons' in group ? group : this.index.group(group.show));
    const first = show?.episodes.find(episode => episode.episode?.seasonIndex) || show?.episodes[0];
    if (!show || !first) return undefined;
    return { subject: { token: show.token, path: first.path, art: show.art, title: show.title }, video: first };
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
    const { section, parent, collection, tab = 'library', q = '', sort, order = 'asc', seed, year = '' } = options;
    const offset = Number(options.offset || 0);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof q !== 'string' ||
      q.length > 200 ||
      (year && !/^\d{4}$/.test(year)) ||
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
        mediaType: library.type === 'shows' ? 'show' : 'movie',
        source: 'folder',
        collections: false,
        // Release years come from names, so a library that keeps its file names has nothing to filter by.
        filters: library.parseNames !== false || library.type === 'shows',
        autoQueue: false,
      }));
      return { items, total: items.length, offset: 0, nextOffset: null };
    }
    // Folders hold no collections.
    if (collection || tab === 'collections') return { items: [], total: 0, offset: 0, nextOffset: null };
    const needle = q.trim().toLowerCase();
    /** @type {{token: string, title: string, folder?: string, year: number, addedMs?: number, item: () => any, runtime?: () => number}[]} */
    let rows;
    if (parent) {
      // Inside a show its seasons, inside a season its episodes, each in playing order.
      const group = /** @type {any} */ (this.index.group(parent));
      if (!group) throw failure('Select a show or season', 404);
      rows =
        'seasons' in group
          ? group.seasons.map(season => ({ ...season, year: 0, item: () => this.groupItem(season) }))
          : group.episodes.map(entry => this.row(entry));
    } else {
      const library = this.libraries.find(candidate => candidate.id === section);
      if (!library) throw failure('Select a library', 404);
      rows =
        library.type === 'shows'
          ? this.index.shows(section).map(show => ({ ...show, item: () => this.groupItem(show) }))
          : this.index.list(section).map(entry => this.row(entry));
    }
    if (needle)
      rows = rows.filter(
        row =>
          row.title.toLowerCase().includes(needle) ||
          !!row.folder?.toLowerCase().includes(needle) ||
          (!!row.year && String(row.year) === needle),
      );
    if (year) rows = rows.filter(row => String(row.year) === year);
    if (sort === 'random') {
      if (!/^[a-f0-9]{32}$/.test(seed || '')) throw failure('Invalid shuffle seed');
      const rank = row =>
        createHash('sha256')
          .update(seed + row.token)
          .digest('hex');
      rows = rows
        .map(row => ({ row, rank: rank(row) }))
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map(ranked => ranked.row);
    } else {
      // Rows come in title (or playing) order; other orders keep it among equals. Unknown values go last either way.
      const value = {
        added: row => row.addedMs,
        year: row => row.year,
        // Known once the file has been read for playback or pictures.
        runtime: row => row.runtime?.(),
      }[sort];
      if (value) {
        const direction = order === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const x = value(a) || 0,
            y = value(b) || 0;
          return !x || !y ? (y ? 1 : 0) - (x ? 1 : 0) || 0 : (x - y) * direction;
        });
      } else if (order === 'desc') rows = [...rows].reverse();
    }
    const page = rows.slice(offset, offset + PAGE);
    return {
      items: page.map(row => row.item()),
      total: rows.length,
      offset,
      nextOffset: offset + PAGE < rows.length ? offset + PAGE : null,
    };
  }
  /** A video as a row of a listing, with what it sorts by. */
  row(entry) {
    return { ...entry, item: () => this.item(entry), runtime: () => this.index.known(entry)?.duration };
  }
  /** Media Home's Recently added: the newest files across every local library; a new episode shows as its show. */
  async recentlyAdded() {
    await this.index.refresh();
    const items = [],
      shows = new Set();
    for (const entry of this.index.newest()) {
      if (items.length >= 20) break;
      if (!entry.episode) items.push(this.item(entry));
      else if (!shows.has(entry.episode.show)) {
        shows.add(entry.episode.show);
        const show = this.index.group(entry.episode.show);
        if (show) items.push(this.groupItem(show));
      }
    }
    return items;
  }
  /** A local library is narrowed by release year only: the years its names give, newest first. */
  async filters(section) {
    await this.index.refresh();
    const library = this.libraries.find(candidate => candidate.id === section);
    const rows = library?.type === 'shows' ? this.index.shows(section) : this.index.list(section);
    const years = [...new Set(rows.map(row => row.year))].filter(Boolean).sort((a, b) => b - a);
    return { genres: [], years: years.map(year => ({ id: String(year), title: String(year) })) };
  }
  async details(id) {
    await this.index.refresh();
    const group = this.index.group(id);
    if (group)
      return { ...this.groupItem(group), summary: '', directors: [], cast: [], ratings: [], otherEditions: [] };
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
      // An episode page steps to the episodes either side.
      ...(entry.episode ? this.neighbors(entry) : {}),
    };
  }
  /**
   * The episodes before and after one in its show, Specials left out: id, title and where each sits.
   * @returns {{previous?: any, next?: any}}
   */
  neighbors(entry) {
    const show = /** @type {any} */ (this.index.group(entry.episode?.show));
    if (!show || !entry.episode?.seasonIndex) return {};
    const episodes = show.episodes.filter(episode => episode.episode.seasonIndex);
    const at = episodes.findIndex(episode => episode.token === entry.token);
    const brief = episode =>
      episode && {
        id: episode.token,
        title: episode.title,
        ...(episode.episode.index !== undefined ? { index: episode.episode.index } : {}),
        seasonIndex: episode.episode.seasonIndex,
      };
    return at < 0 ? {} : { previous: brief(episodes[at - 1]), next: brief(episodes[at + 1]) };
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
  /** Every video of a library, show or season, in playing order; Specials only when asked for. */
  async queueItems({ type, id, includeSpecials = false } = {}) {
    await this.index.refresh();
    let list;
    const group = /** @type {any} */ (this.index.group(id));
    if (type === 'library' && this.libraries.some(library => library.id === id)) {
      const library = this.libraries.find(candidate => candidate.id === id);
      list = library?.type === 'shows' ? this.index.shows(id).flatMap(show => show.episodes) : this.index.list(id);
    } else if (type === 'show' && group && 'seasons' in group) list = group.episodes;
    else if (type === 'season' && group && !('seasons' in group)) list = group.episodes;
    else throw failure('Select a library, show or season', 404);
    if (!includeSpecials && type !== 'season') list = list.filter(entry => !entry.episode || entry.episode.seasonIndex);
    const items = [];
    for (const entry of list) {
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
  async artwork(id, kind = 'poster') {
    if (!this.art) throw failure('Artwork unavailable', 404);
    await this.index.refresh();
    const source = this.pictureSource(id, kind);
    if (!source) throw failure('Select a video from the library', 404);
    return this.art.picture(source.subject, kind, () => this.described(source.video));
  }
  async allows(id) {
    await this.index.refresh();
    return !!this.index.get(id) || !!this.index.group(id);
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
    const steps = entry.episode ? this.neighbors(entry) : {};
    const media = {
      title: entry.title,
      subtitle: entry.episode ? episodeLine(entry) : subtitle(entry),
      duration: info.duration,
      kind: this.kind,
      type: entry.episode ? 'episode' : 'movie',
      ...(entry.episode ? { previousId: steps.previous?.id, nextId: steps.next?.id } : {}),
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
  /** Stop scanning and making pictures; resolves once background work has ended and holds no file. */
  async close() {
    this.index.close();
    this.closed = true;
    clearTimeout(this.startup);
    await Promise.allSettled([this.art?.close(), this.warming]);
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
  const local = new LocalMedia(libraries, { pipeline, logger, artDirectory: config.localMedia.artDirectory });
  return { kind: 'local', root: local, identity: async () => LOCAL_SERVER, scopeFor: async () => local };
}

module.exports = { LocalMedia, localProvider, LOCAL_SERVER };
