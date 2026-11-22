'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SharedTask } = require('../../operation');
const { filmName, sortTitle, episodeName } = require('./names');

const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.webm', '.mov', '.avi', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv']);
/** Sidecar subtitle extensions and the codec each holds. */
const SIDECAR = { '.srt': 'subrip', '.vtt': 'webvtt', '.ass': 'ass', '.ssa': 'ssa', '.sup': 'pgs', '.sub': 'vobsub' };
/** Pictures beside a video, as media servers name them, by the kind each one is. */
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ART = {
  // `Film-poster.jpg` or `Film.jpg` beside it; in a film's own folder also `poster.jpg` and the rest.
  poster: { own: ['-poster', ''], shared: ['poster', 'folder', 'cover', 'movie'] },
  landscape: { own: ['-landscape', '-thumb'], shared: ['landscape', 'thumb'] },
  backdrop: { own: ['-fanart', '-backdrop', '-background'], shared: ['fanart', 'backdrop', 'background', 'art'] },
  logo: { own: ['-logo', '-clearlogo'], shared: ['logo', 'clearlogo'] },
};
/**
 * The picture files for one video, from the names already read in its folder.
 * @param {Map<string, string>} images Lowercased stem to file name.
 * @param {string} stem @param {boolean} alone @param {string} directory
 */
function artFiles(images, stem, alone, directory) {
  /** @type {{[kind: string]: string}} */
  const found = {};
  const lower = stem.toLowerCase();
  for (const [kind, names] of Object.entries(ART)) {
    const name = [...names.own.map(suffix => lower + suffix), ...(alone ? names.shared : [])].find(candidate =>
      images.has(candidate),
    );
    if (name) found[kind] = path.join(directory, images.get(name));
  }
  return found;
}
/**
 * An episode's names and place, from its file name and the folders above it inside the library (see names.js).
 * @param {string} libraryId @param {string} file @param {string} relative The folder, inside the library.
 */
function episodeEntry(libraryId, file, relative) {
  const folders = relative.split('/').filter(Boolean);
  const parsed = episodeName(file, folders);
  // One show per folder (or per name, for files at the top), whatever each file calls it.
  const key = (folders[0] || parsed.show + (parsed.year ? ' ' + parsed.year : '')).toLowerCase();
  const label = parsed.title || (parsed.episode !== undefined ? 'Episode ' + parsed.episode : title(file));
  return {
    title: label.slice(0, 200),
    sortTitle: label,
    year: 0,
    edition: '',
    episode: {
      show: showToken(libraryId, key),
      season: seasonToken(libraryId, key, parsed.season),
      seasonIndex: parsed.season,
      ...(parsed.episode !== undefined ? { index: parsed.episode } : {}),
      showTitle: parsed.show,
      showYear: parsed.year || 0,
      folder: folders[0] ? folders[0].toLowerCase() : '',
    },
  };
}
/**
 * A library's episodes as shows and seasons, each in playing order: seasons by number with Specials (season 0)
 * last, episodes by number and then name. Every show and season is also recorded in `groups`.
 * @param {string} libraryId @param {LocalEntry[]} episodes
 * @param {Map<string, {[kind: string]: string}>} folderArt @param {Map<string, any>} groups
 * @returns {LocalShow[]}
 */
function groupShows(libraryId, episodes, folderArt, groups) {
  /** @type {Map<string, any>} */
  const shows = new Map();
  for (const entry of episodes) {
    const place = /** @type {NonNullable<LocalEntry['episode']>} */ (entry.episode);
    let show = shows.get(place.show);
    if (!show) {
      show = {
        token: place.show,
        library: libraryId,
        title: place.showTitle,
        sortTitle: sortTitle(place.showTitle),
        year: place.showYear,
        art: (place.folder && folderArt.get(place.folder)) || {},
        seasons: new Map(),
        addedMs: 0,
      };
      shows.set(place.show, show);
    }
    show.year ||= place.showYear;
    let season = show.seasons.get(place.seasonIndex);
    if (!season) {
      season = {
        token: place.season,
        index: place.seasonIndex,
        title: place.seasonIndex ? 'Season ' + place.seasonIndex : 'Specials',
        show: show.token,
        episodes: [],
      };
      show.seasons.set(place.seasonIndex, season);
    }
    season.episodes.push(entry);
  }
  const byNumber = (a, b) =>
    (a.episode.index ?? Infinity) - (b.episode.index ?? Infinity) ||
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  const list = [...shows.values()].map(show => {
    const seasons = [...show.seasons.values()].sort((a, b) => (a.index || Infinity) - (b.index || Infinity));
    for (const season of seasons) {
      season.episodes.sort(byNumber);
      groups.set(season.token, season);
    }
    const value = { ...show, seasons, episodes: seasons.flatMap(season => season.episodes) };
    groups.set(show.token, value);
    return value;
  });
  return list.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle, undefined, { numeric: true, sensitivity: 'base' }));
}
const MAX_FILES = 20000,
  MAX_DEPTH = 12,
  RESCAN_MS = 60000,
  PROBES = 500;

/**
 * What a viewer names instead of a path: a bounded token of the library and the
 * path inside it. A token is only ever looked up in the index, never turned back
 * into a path, so nothing a client sends can reach outside a configured folder.
 */
function token(libraryId, relative, prefix = 'f') {
  return (
    prefix +
    createHash('sha256')
      .update(libraryId + '\n' + relative)
      .digest('base64url')
      .slice(0, 21)
  );
}
/** A show's or a season's token: from its library and name, so it lasts as long as their files' do. */
const showToken = (libraryId, key) => token(libraryId, 'show\n' + key, 'h');
const seasonToken = (libraryId, key, season) => token(libraryId, 'season\n' + key + '\n' + season, 'n');
function title(name) {
  const bare = name.replace(/\.[^.]+$/, '');
  return (/\s/.test(bare) ? bare : bare.replace(/[._]+/g, ' ')).trim().slice(0, 200) || name.slice(0, 200);
}
/**
 * What a video is called. With `parse_names`, release names read as a film's title, year
 * and edition (see names.js); otherwise the file name is the title. A name that parses to
 * nothing keeps its plain title.
 * @param {string} file @param {string} folder @param {boolean} alone @param {boolean} parse
 */
function named(file, folder, alone, parse) {
  const parsed = parse ? filmName(file, folder, alone) : { title: '' };
  const shown = parsed.title || title(file);
  return { title: shown, sortTitle: sortTitle(shown), year: parsed.year || 0, edition: parsed.edition || '' };
}

/**
 * The videos under the configured library folders, held in memory and rebuilt from
 * the disk; nothing about them is stored. Symbolic links are not followed. A library
 * may list several folders: a file is known by its place inside its folder, so a
 * folder can move to another drive and keep its queues and resume positions, and
 * when two folders hold a file at the same place the first listed is used.
 * In a `shows` library each video is an episode: `episode` says which show and season it is in.
 * @typedef {{token: string, library: string, relative: string, path: string, title: string, sortTitle: string,
 *   year: number, edition: string, folder: string, art: {[kind: string]: string}, addedMs?: number,
 *   episode?: {show: string, season: string, seasonIndex: number, index?: number, showTitle: string,
 *   showYear: number, folder: string}}} LocalEntry
 * @typedef {{token: string, index: number, title: string, show: string, episodes: LocalEntry[]}} LocalSeason
 * @typedef {{token: string, library: string, title: string, sortTitle: string, year: number,
 *   art: {[kind: string]: string}, seasons: LocalSeason[], episodes: LocalEntry[], addedMs: number}} LocalShow
 */
class LocalIndex {
  /**
   * @param {{id: string, name: string, paths: string[], parseNames?: boolean, type?: 'movies'|'shows'}[]} libraries
   * @param {{logger?: any, now?: () => number}} [options]
   */
  constructor(libraries, { logger, now = Date.now } = {}) {
    this.libraries = libraries;
    this.logger = logger;
    this.now = now;
    /** @type {(() => void) | undefined} Told after each scan, so pictures can be made for new files. */
    this.onScanned = undefined;
    /** @type {Map<string, LocalEntry>} */
    this.entries = new Map();
    /** @type {Map<string, LocalEntry[]>} */
    this.byLibrary = new Map();
    /** @type {Map<string, LocalShow[]>} The shows of each `shows` library, in title order. */
    this.showsByLibrary = new Map();
    /** @type {Map<string, LocalShow | LocalSeason>} Every show and season by token. */
    this.groups = new Map();
    this.scannedAt = -Infinity;
    /** @type {Map<string, {size: number, mtimeMs: number, info: any}>} */
    this.probes = new Map();
    this.closing = new AbortController();
  }
  /** Bring the index up to date with the disk, at most once a minute; concurrent callers share one scan. */
  async refresh(force = false) {
    if (!force && this.now() - this.scannedAt < RESCAN_MS) return;
    if (!this.scanning) {
      // One person leaving the library must not cancel the scan everyone else is waiting for.
      this.scanning = new SharedTask(signal => this.scan(AbortSignal.any([signal, this.closing.signal])), {
        timeoutMs: 120000,
        idleMs: 60000,
      });
      const task = this.scanning;
      task.promise
        .catch(() => {})
        .finally(() => {
          if (this.scanning === task) this.scanning = undefined;
        });
    }
    await this.scanning.join();
  }
  async scan(signal) {
    const entries = new Map(),
      byLibrary = new Map(),
      showsByLibrary = new Map(),
      groups = new Map();
    for (const library of this.libraries) {
      const found = [];
      const shows = library.type === 'shows';
      /** @type {Map<string, {[kind: string]: string}>} The pictures in each show's own folder. */
      const showFolderArt = new Map();
      let repeated = 0;
      // Folders are walked in the order listed, so the first one holding a place keeps it.
      const pending = library.paths.map(folder => ({ directory: folder, relative: '', depth: 0 })).reverse();
      while (pending.length && found.length < MAX_FILES) {
        signal?.throwIfAborted();
        const { directory, relative, depth } = pending.pop();
        let rows;
        try {
          rows = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (!depth)
            this.logger?.warn('Local', `Library "${library.name}" could not read ${directory} (${error.code})`);
          continue;
        }
        const folders = [];
        const isVideo = row => row.isFile() && !row.isSymbolicLink() && VIDEO.has(path.extname(row.name).toLowerCase());
        // A folder holding one video may name it: `Heat (1995)/movie.mkv`.
        const alone = rows.filter(isVideo).length === 1,
          own = depth ? path.basename(directory) : '';
        const images = new Map(
          rows
            .filter(row => row.isFile() && !row.isSymbolicLink() && IMAGE.has(path.extname(row.name).toLowerCase()))
            .map(row => [row.name.slice(0, -path.extname(row.name).length).toLowerCase(), row.name]),
        );
        // A show's own folder is the first one inside the library: `Show/poster.jpg`, `Show/fanart.jpg`.
        if (shows && depth === 1) {
          const key = relative.toLowerCase();
          const prev = showFolderArt.get(key);
          const next = artFiles(images, '', true, directory);
          showFolderArt.set(key, prev ? { ...next, ...prev } : next);
        }
        for (const row of rows) {
          if (row.name.startsWith('.') || row.isSymbolicLink()) continue;
          const inside = relative ? relative + '/' + row.name : row.name;
          if (row.isDirectory()) {
            if (depth < MAX_DEPTH)
              folders.push({ directory: path.join(directory, row.name), relative: inside, depth: depth + 1 });
          } else if (isVideo(row) && found.length < MAX_FILES) {
            const id = token(library.id, inside);
            if (entries.has(id)) {
              repeated++;
              continue;
            }
            const entry = {
              token: id,
              library: library.id,
              relative: inside,
              path: path.join(directory, row.name),
              ...(shows
                ? episodeEntry(library.id, row.name, relative)
                : named(row.name, own, alone, library.parseNames !== false)),
              // The folder's own picture names count only in a film's own folder, not at the top of a library.
              art: artFiles(
                images,
                row.name.slice(0, -path.extname(row.name).length),
                !shows && alone && depth > 0,
                directory,
              ),
              folder: relative.split('/').filter(Boolean).join(' / ').slice(0, 200),
            };
            entries.set(id, entry);
            found.push(entry);
          }
        }
        // Finish one folder before starting the next listed one.
        pending.push(...folders.reverse());
      }
      if (repeated)
        this.logger?.warn(
          'Local',
          `Library "${library.name}" has ${repeated} files at the same place in two folders; the first folder listed is used`,
        );
      found.sort(
        (a, b) =>
          a.sortTitle.localeCompare(b.sortTitle, undefined, { numeric: true, sensitivity: 'base' }) || a.year - b.year,
      );
      byLibrary.set(library.id, found);
      if (shows) showsByLibrary.set(library.id, groupShows(library.id, found, showFolderArt, groups));
    }
    await this.dated(entries, signal);
    // A show was added when its newest episode was.
    for (const list of showsByLibrary.values())
      for (const show of list) show.addedMs = Math.max(0, ...show.episodes.map(entry => entry.addedMs || 0));
    this.entries = entries;
    this.byLibrary = byLibrary;
    this.showsByLibrary = showsByLibrary;
    this.groups = groups;
    this.scannedAt = this.now();
    for (const key of this.probes.keys()) if (!entries.has(key)) this.probes.delete(key);
    this.onScanned?.();
  }
  /**
   * When each video was added: its file's creation time (on Windows, when it was copied there), or its
   * modified time where there is none. Read once per file; a rescan keeps what it already knows.
   * @param {Map<string, LocalEntry>} entries
   */
  async dated(entries, signal) {
    const unknown = [];
    for (const entry of entries.values()) {
      const known = this.entries.get(entry.token);
      if (known?.path === entry.path && known.addedMs) entry.addedMs = known.addedMs;
      else unknown.push(entry);
    }
    for (let at = 0; at < unknown.length; at += 32) {
      signal?.throwIfAborted();
      await Promise.all(
        unknown.slice(at, at + 32).map(async entry => {
          const stat = await fs.stat(entry.path).catch(() => undefined);
          entry.addedMs = stat?.birthtimeMs || stat?.mtimeMs || 0;
        }),
      );
    }
  }
  /** Every video in every library, newest first. @returns {LocalEntry[]} */
  newest() {
    return [...this.entries.values()].sort((a, b) => (b.addedMs || 0) - (a.addedMs || 0));
  }
  /** A show or season by token. @returns {LocalShow | LocalSeason | undefined} */
  group(id) {
    return typeof id === 'string' ? this.groups.get(id) : undefined;
  }
  /** @returns {LocalShow[]} */
  shows(libraryId) {
    return this.showsByLibrary.get(libraryId) || [];
  }
  /** @returns {LocalEntry | undefined} */
  get(id) {
    return typeof id === 'string' ? this.entries.get(id) : undefined;
  }
  /** @returns {LocalEntry[]} */
  list(libraryId) {
    return this.byLibrary.get(libraryId) || [];
  }
  /** What FFprobe already said about an entry, if anything, without reading the disk. */
  known(entry) {
    return this.probes.get(entry.token)?.info;
  }
  /**
   * The file's streams, duration and chapters, remembered until the file changes.
   * @param {LocalEntry} entry @param {{size: number, mtimeMs: number}} stat
   * @param {(file: string) => Promise<any>} probe
   */
  async probe(entry, stat, probe) {
    const saved = this.probes.get(entry.token);
    if (saved && saved.size === stat.size && saved.mtimeMs === stat.mtimeMs) return saved.info;
    const info = await probe(entry.path);
    this.probes.delete(entry.token);
    this.probes.set(entry.token, { size: stat.size, mtimeMs: stat.mtimeMs, info });
    while (this.probes.size > PROBES) this.probes.delete(this.probes.keys().next().value);
    return info;
  }
  /**
   * Subtitle files beside a video that share its name: `Film.srt`, `Film.en.srt`,
   * `Film.en.forced.ass`. A VobSub `.sub` counts only with its `.idx`.
   * @param {LocalEntry} entry
   */
  async sidecars(entry) {
    const directory = path.dirname(entry.path),
      stem = path.basename(entry.path).replace(/\.[^.]+$/, '');
    let names;
    try {
      names = (await fs.readdir(directory, { withFileTypes: true }))
        .filter(row => row.isFile() && !row.isSymbolicLink())
        .map(row => row.name);
    } catch {
      return [];
    }
    const present = new Set(names.map(name => name.toLowerCase()));
    const found = [];
    for (const name of names.sort()) {
      const extension = path.extname(name).toLowerCase(),
        codec = SIDECAR[extension];
      if (!codec || !name.toLowerCase().startsWith(stem.toLowerCase() + '.')) continue;
      const bare = name.slice(0, -extension.length);
      const index =
        codec === 'vobsub' ? names.find(other => other.toLowerCase() === bare.toLowerCase() + '.idx') : undefined;
      if (codec === 'vobsub' && !present.has(bare.toLowerCase() + '.idx')) continue;
      const tags = bare
        .slice(stem.length)
        .split('.')
        .filter(Boolean)
        .map(tag => tag.toLowerCase());
      const flags = new Set(tags.filter(tag => ['forced', 'sdh', 'cc', 'hi', 'default'].includes(tag)));
      const language = tags.find(tag => !flags.has(tag) && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(tag));
      found.push({
        codec,
        language,
        forced: flags.has('forced'),
        sdh: flags.has('sdh') || flags.has('cc') || flags.has('hi'),
        file: path.join(directory, name),
        index: index && path.join(directory, index),
      });
      if (found.length >= 32) break;
    }
    return found;
  }
  close() {
    this.closing.abort();
  }
}

module.exports = { LocalIndex, token, VIDEO, SIDECAR };
