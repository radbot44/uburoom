'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SharedTask } = require('../operation');

const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.webm', '.mov', '.avi', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv']);
/** Sidecar subtitle extensions and the codec each holds. */
const SIDECAR = { '.srt': 'subrip', '.vtt': 'webvtt', '.ass': 'ass', '.ssa': 'ssa', '.sup': 'pgs', '.sub': 'vobsub' };
const MAX_FILES = 20000,
  MAX_DEPTH = 12,
  RESCAN_MS = 60000,
  PROBES = 500;

/**
 * What a viewer names instead of a path: a bounded token of the library and the
 * path inside it. A token is only ever looked up in the index, never turned back
 * into a path, so nothing a client sends can reach outside a configured folder.
 */
function token(libraryId, relative) {
  return (
    'f' +
    createHash('sha256')
      .update(libraryId + '\n' + relative)
      .digest('base64url')
      .slice(0, 21)
  );
}
function title(name) {
  const bare = name.replace(/\.[^.]+$/, '');
  return (/\s/.test(bare) ? bare : bare.replace(/[._]+/g, ' ')).trim().slice(0, 200) || name.slice(0, 200);
}

/**
 * The videos under the configured library folders, held in memory and rebuilt from
 * the disk; nothing about them is stored. Symbolic links are not followed.
 * @typedef {{token: string, library: string, relative: string, path: string, title: string, folder: string}} LocalEntry
 */
class LocalIndex {
  /** @param {{id: string, name: string, path: string}[]} libraries @param {{logger?: any, now?: () => number}} [options] */
  constructor(libraries, { logger, now = Date.now } = {}) {
    this.libraries = libraries;
    this.logger = logger;
    this.now = now;
    /** @type {Map<string, LocalEntry>} */
    this.entries = new Map();
    /** @type {Map<string, LocalEntry[]>} */
    this.byLibrary = new Map();
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
      byLibrary = new Map();
    for (const library of this.libraries) {
      const found = [];
      const pending = [{ directory: library.path, relative: '', depth: 0 }];
      while (pending.length && found.length < MAX_FILES) {
        signal?.throwIfAborted();
        const { directory, relative, depth } = pending.pop();
        let rows;
        try {
          rows = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (!depth) this.logger?.warn('Local', `Library "${library.name}" could not be read (${error.code})`);
          continue;
        }
        for (const row of rows) {
          if (row.name.startsWith('.') || row.isSymbolicLink()) continue;
          const inside = relative ? relative + '/' + row.name : row.name;
          if (row.isDirectory()) {
            if (depth < MAX_DEPTH)
              pending.push({ directory: path.join(directory, row.name), relative: inside, depth: depth + 1 });
          } else if (row.isFile() && VIDEO.has(path.extname(row.name).toLowerCase()) && found.length < MAX_FILES) {
            const id = token(library.id, inside);
            const entry = {
              token: id,
              library: library.id,
              relative: inside,
              path: path.join(directory, row.name),
              title: title(row.name),
              folder: relative.split('/').filter(Boolean).join(' / ').slice(0, 200),
            };
            entries.set(id, entry);
            found.push(entry);
          }
        }
      }
      found.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
      byLibrary.set(library.id, found);
    }
    this.entries = entries;
    this.byLibrary = byLibrary;
    this.scannedAt = this.now();
    for (const key of this.probes.keys()) if (!entries.has(key)) this.probes.delete(key);
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
