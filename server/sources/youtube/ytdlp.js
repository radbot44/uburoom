'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { findOnPath, classifyHdr } = require('../../media-tools');
const { VIDEO_ID, parseYouTubeUrl, isAllowedThumbnailUrl } = require('./urls');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TRACK = /^[A-Za-z0-9_.-]{1,64}$/;
const CONTAINER_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
};
const MEDIA_EXTS = new Set(Object.keys(CONTAINER_MIME));
const DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TOOL_TIMEOUT_MS = 180000;
const MIN_EJS_VERSION = '2025.10.22';

function versionAtLeast(version, minimum) {
  const parts = String(version || '')
    .trim()
    .match(/^\d+(?:\.\d+){1,2}/)?.[0]
    ?.split('.')
    .map(Number);
  const minParts = String(minimum || '')
    .trim()
    .split('.')
    .map(Number);
  if (!parts || parts.some(n => !Number.isInteger(n))) return false;
  for (let i = 0; i < Math.max(parts.length, minParts.length); i++) {
    const a = parts[i] || 0;
    const b = minParts[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

function safeBaseName(name) {
  if (typeof name !== 'string' || !name) return '';
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') return '';
  return name;
}

async function safeCacheFile(cacheDir, filename) {
  if (!cacheDir) return null;
  const safe = safeBaseName(filename);
  if (!safe) return null;
  const dir = path.resolve(cacheDir);
  const file = path.resolve(dir, safe);
  if (path.dirname(file) !== dir) return null;
  try {
    const dirStat = await fsp.lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const fileStat = await fsp.lstat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    return { file, stat: fileStat };
  } catch {
    return null;
  }
}

/** Resolves a configured path or searches PATH for an executable binary. */
function resolveBinary(configured, defaultName, platform = process.platform, environment = process.env) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value) {
    if (!value.includes('/') && !value.includes('\\') && !value.startsWith('.')) {
      return findOnPath(value, environment, platform) || '';
    }
    try {
      if (!fs.statSync(value).isFile()) return '';
      if (platform !== 'win32') fs.accessSync(value, fs.constants.X_OK);
      return value;
    } catch {
      return '';
    }
  }
  return findOnPath(defaultName, environment, platform) || '';
}

function killChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {
      /* Child already exited. */
    }
  }, 1500);
  timer.unref?.();
}

function defaultSpawnRunner(children) {
  return (bin, args, { cwd, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, signal, maxStdoutBytes = MAX_STDOUT_BYTES } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }
      let child;
      try {
        child = spawn(bin, args, {
          cwd: cwd || undefined,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(Object.assign(new Error(`Could not start ${path.basename(bin)}: ${error.message}`), { status: 500 }));
        return;
      }
      children.add(child);

      const stdoutChunks = [];
      let stdoutLen = 0;
      const stderrChunks = [];
      let stderrLen = 0;
      let settled = false;
      let timer;

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        children.delete(child);
      };
      const finishError = err => {
        if (settled) return;
        settled = true;
        cleanup();
        killChild(child);
        reject(err);
      };
      const onAbort = () => {
        finishError(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finishError(Object.assign(new Error(`${path.basename(bin)} timed out`), { status: 504 }));
        }, timeoutMs);
        timer.unref?.();
      }

      child.stdout?.on('data', chunk => {
        stdoutLen += chunk.length;
        if (stdoutLen > maxStdoutBytes) {
          finishError(Object.assign(new Error(`${path.basename(bin)} output exceeded limit`), { status: 502 }));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', chunk => {
        if (stderrLen >= MAX_STDERR_BYTES) return;
        const room = MAX_STDERR_BYTES - stderrLen;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        stderrChunks.push(slice);
        stderrLen += slice.length;
      });
      child.on('error', error => {
        finishError(
          Object.assign(new Error(`${path.basename(bin)} failed to start: ${error.message}`), { status: 500 }),
        );
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
    });
}

function cleanYtDlpError(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('ERROR:')) return lines[i].slice(6).trim().slice(0, 240);
  }
  return lines.length ? lines[lines.length - 1].slice(0, 240) : '';
}

function yearFromUploadDate(raw) {
  if (typeof raw === 'string' && raw.length >= 4 && /^\d{4}/.test(raw)) return Number(raw.slice(0, 4));
  return undefined;
}

function normalizeSubTag(name, videoId) {
  const prefix = `${videoId}.`;
  const stem = name.slice(0, -4);
  const raw = stem.startsWith(prefix) ? stem.slice(prefix.length) : stem;
  const trackId = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64) || 'und';
  const language = trackId.split('.')[0].slice(0, 16) || 'und';
  return { trackId, language };
}

function entryToVideoMeta(raw, fallbackId = '') {
  const id = String(raw?.id || fallbackId || '');
  const duration = Number(raw?.duration || 0);
  const isLive = !!raw?.is_live || raw?.live_status === 'is_live' || raw?.live_status === 'is_upcoming';
  const thumb = typeof raw?.thumbnail === 'string' && isAllowedThumbnailUrl(raw.thumbnail) ? raw.thumbnail : undefined;
  return {
    id,
    status: 'ready',
    title: typeof raw?.title === 'string' && raw.title ? raw.title : 'YouTube video',
    channelTitle: typeof (raw?.channel || raw?.uploader) === 'string' ? raw.channel || raw.uploader : '',
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    thumbnailUrl: thumb,
    description: typeof raw?.description === 'string' ? raw.description.slice(0, 500) : '',
    year: yearFromUploadDate(raw?.upload_date),
    isLive,
  };
}

/**
 * Built-in rolling-cache `yt-dlp` runner with bounded concurrency, coalesced downloads,
 * WebVTT subtitles, and automatic LRU eviction under `cacheDirectory`.
 */
class YouTubeCache {
  constructor({
    cacheDirectory,
    maxCacheBytes = DEFAULT_MAX_CACHE_BYTES,
    maxConcurrent = 2,
    ytDlpPath = '',
    ffmpegPath = '',
    ffprobePath = '',
    cookiesFile = '',
    poTokenUrl = '',
    platform = process.platform,
    environment = process.env,
    runCommand,
    logger,
  } = {}) {
    if (!cacheDirectory) throw new Error('YouTube cacheDirectory is required');
    this.cacheDirectory = path.resolve(cacheDirectory);
    this.tmpDirectory = path.join(this.cacheDirectory, '_tmp');
    this.maxCacheBytes = Math.max(0, Number(maxCacheBytes) || 0);
    this.maxConcurrent = Math.max(1, Math.min(Number(maxConcurrent) || 2, 4));
    this.ytDlpPathConfig = ytDlpPath || '';
    this.ffmpegPathConfig = ffmpegPath || '';
    this.ffprobePathConfig = ffprobePath || '';
    this.cookiesFile = cookiesFile || '';
    this.poTokenUrl = poTokenUrl || '';
    this.platform = platform;
    this.environment = environment;
    this.logger = logger;

    this.children = new Set();
    this.hasCustomRunner = typeof runCommand === 'function';
    this.runCommand = runCommand || defaultSpawnRunner(this.children);

    this.ready = new Map();
    this.jobs = new Map();
    this.active = new Map();
    this.leases = new Map();
    this.metaTimers = new Map();
    this.queue = [];
    this.initPromise = null;
    this.runtimePromise = null;
    this.ytdlpVersion = '';
    this.supportsJsRuntimes = false;
    this.closed = false;
    this.tick = Date.now();
  }

  nextTick() {
    this.tick = Math.max(this.tick + 1, Date.now());
    return this.tick;
  }

  resolveYtDlp({ allowMockFallback = true } = {}) {
    const found = resolveBinary(this.ytDlpPathConfig, 'yt-dlp', this.platform, this.environment);
    if (found) return found;
    if (allowMockFallback && this.hasCustomRunner && !this.ytDlpPathConfig) return 'yt-dlp';
    return '';
  }

  resolveFfmpeg() {
    return resolveBinary(this.ffmpegPathConfig, 'ffmpeg', this.platform, this.environment);
  }

  resolveFfprobe() {
    const direct = resolveBinary(this.ffprobePathConfig, 'ffprobe', this.platform, this.environment);
    if (direct) return direct;
    const ffmpeg = this.resolveFfmpeg();
    if (!ffmpeg) return '';
    const sibling = path.join(path.dirname(ffmpeg), this.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    return resolveBinary(sibling, 'ffprobe', this.platform, this.environment);
  }

  baseYtDlpArgs({ includeJsRuntime = false } = {}) {
    const args = ['--no-config', '--no-call-home', '--no-update'];
    if (includeJsRuntime && this.supportsJsRuntimes && process.execPath) {
      args.push('--js-runtimes', `node:${process.execPath}`);
    }
    if (this.cookiesFile) args.push('--cookies', this.cookiesFile);
    if (this.poTokenUrl) args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${this.poTokenUrl}`);
    return args;
  }

  async detectRuntime(ytDlp, signal) {
    if (this.ytdlpVersion) return this.ytdlpVersion;
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        try {
          const res = await this.runCommand(ytDlp, ['--version'], { timeoutMs: 5000, signal });
          if (res.code === 0) {
            const ver = (res.stdout || '').trim().split(/\r?\n/)[0]?.slice(0, 40) || '';
            if (ver) {
              this.ytdlpVersion = ver;
              this.supportsJsRuntimes = versionAtLeast(ver, MIN_EJS_VERSION);
              return ver;
            }
          }
        } catch {
          /* Probe failures are surfaced by command execution or checkTools(). */
        } finally {
          this.runtimePromise = null;
        }
        return '';
      })();
    }
    return this.runtimePromise;
  }

  metaPath(videoId) {
    return path.join(this.cacheDirectory, `${videoId}.meta.json`);
  }

  async writeMeta(record) {
    const target = this.metaPath(record.id);
    const tmp = path.join(this.cacheDirectory, `.${record.id}.${randomUUID().slice(0, 8)}.meta.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(record), 'utf8');
    await fsp.rename(tmp, target);
  }

  acquire(videoId) {
    if (!videoId) return () => {};
    this.leases.set(videoId, (this.leases.get(videoId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.leases.get(videoId) || 0) - 1;
      if (next > 0) this.leases.set(videoId, next);
      else this.leases.delete(videoId);
    };
  }

  touchRecord(record) {
    record.lastUsedMs = this.nextTick();
    if (this.closed || this.metaTimers.has(record.id)) return;
    const timer = setTimeout(() => {
      this.metaTimers.delete(record.id);
      if (this.closed || this.ready.get(record.id) !== record) return;
      void this.writeMeta(record).catch(() => {});
    }, 5000);
    timer.unref?.();
    this.metaTimers.set(record.id, timer);
  }

  async ensureReady() {
    if (this.closed) throw Object.assign(new Error('YouTube cache is closed'), { status: 503 });
    if (!this.initPromise) {
      this.initPromise = this.loadExisting().catch(error => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  async loadExisting() {
    await fsp.mkdir(this.cacheDirectory, { recursive: true });
    await fsp.rm(this.tmpDirectory, { recursive: true, force: true });
    await fsp.mkdir(this.tmpDirectory, { recursive: true });

    let entries;
    try {
      entries = await fsp.readdir(this.cacheDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
      const metaFile = path.join(this.cacheDirectory, entry.name);
      try {
        const data = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
        const vid = String(data?.id || '');
        if (!VIDEO_ID.test(vid)) continue;
        const safe = await safeCacheFile(this.cacheDirectory, data.filename);
        if (!safe) {
          await fsp.unlink(metaFile).catch(() => {});
          continue;
        }
        data.size = safe.stat.size;
        data.status = 'ready';
        if (!Number.isFinite(data.lastUsedMs)) data.lastUsedMs = data.mtimeMs || safe.stat.mtimeMs || Date.now();
        this.ready.set(vid, data);
      } catch {
        /* Ignore corrupt metadata files on startup. */
      }
    }
  }

  async entryBytes(record) {
    let total = Number(record.size || 0);
    for (const sub of record.subtitles || []) {
      const safe = await safeCacheFile(this.cacheDirectory, sub.file);
      if (safe) total += safe.stat.size;
    }
    return total;
  }

  async cacheStats() {
    await this.ensureReady();
    let bytes = 0;
    for (const rec of this.ready.values()) bytes += await this.entryBytes(rec);
    return { files: this.ready.size, bytes, maxBytes: this.maxCacheBytes };
  }

  async evictIfNeeded(protect = new Set()) {
    if (this.maxCacheBytes <= 0) return;
    let total = 0;
    const sizes = new Map();
    for (const rec of this.ready.values()) {
      const bytes = await this.entryBytes(rec);
      sizes.set(rec.id, bytes);
      total += bytes;
    }
    if (total <= this.maxCacheBytes) return;

    const candidates = [...this.ready.values()]
      .filter(
        rec =>
          !protect.has(rec.id) && !this.active.has(rec.id) && !this.jobs.has(rec.id) && !(this.leases.get(rec.id) > 0),
      )
      .sort((a, b) => Number(a.lastUsedMs || a.mtimeMs || 0) - Number(b.lastUsedMs || b.mtimeMs || 0));

    for (const rec of candidates) {
      if (total <= this.maxCacheBytes) break;
      const primary = safeBaseName(rec.filename) ? path.join(this.cacheDirectory, rec.filename) : '';
      if (primary) {
        try {
          await fsp.unlink(primary);
        } catch (error) {
          if (error?.code !== 'ENOENT') continue;
        }
      }
      const bytes = sizes.get(rec.id) || 0;
      total -= bytes;
      const timer = this.metaTimers.get(rec.id);
      if (timer) {
        clearTimeout(timer);
        this.metaTimers.delete(rec.id);
      }
      this.ready.delete(rec.id);
      const files = [
        ...(rec.subtitles || []).map(s => (safeBaseName(s.file) ? path.join(this.cacheDirectory, s.file) : '')),
        this.metaPath(rec.id),
      ].filter(Boolean);
      for (const file of files) await fsp.unlink(file).catch(() => {});
    }
  }

  async checkTools({ signal } = {}) {
    const ytDlpPath = this.resolveYtDlp();
    const ffmpegPath = this.resolveFfmpeg();
    const ffprobePath = this.resolveFfprobe();
    if (!ytDlpPath) {
      return {
        ok: false,
        ytdlp: null,
        ytDlpPath: '',
        ffmpeg: !!ffmpegPath,
        ffprobe: !!ffprobePath,
        ffmpegPath,
        ffprobePath,
        cacheDirectory: this.cacheDirectory,
        error: this.ytDlpPathConfig
          ? `Configured yt-dlp executable was not found at ${this.ytDlpPathConfig}`
          : 'yt-dlp was not found on PATH; install yt-dlp or set yt_dlp in Advanced options',
      };
    }
    try {
      const res = await this.runCommand(ytDlpPath, ['--version'], { timeoutMs: 5000, signal });
      if (res.code !== 0) {
        return {
          ok: false,
          ytdlp: null,
          ytDlpPath,
          ffmpeg: !!ffmpegPath,
          ffprobe: !!ffprobePath,
          ffmpegPath,
          ffprobePath,
          cacheDirectory: this.cacheDirectory,
          error: cleanYtDlpError(res.stderr) || 'yt-dlp exited with an error',
        };
      }
      const ytdlp = (res.stdout || '').trim().split(/\r?\n/)[0]?.slice(0, 40) || 'unknown';
      this.ytdlpVersion = ytdlp;
      this.supportsJsRuntimes = versionAtLeast(ytdlp, MIN_EJS_VERSION);
      return {
        ok: true,
        ytdlp,
        outdated: !this.supportsJsRuntimes,
        ytDlpPath,
        ffmpeg: !!ffmpegPath,
        ffprobe: !!ffprobePath,
        ffmpegPath,
        ffprobePath,
        cacheDirectory: this.cacheDirectory,
      };
    } catch (error) {
      return {
        ok: false,
        ytdlp: null,
        ytDlpPath,
        ffmpeg: !!ffmpegPath,
        ffprobe: !!ffprobePath,
        ffmpegPath,
        ffprobePath,
        cacheDirectory: this.cacheDirectory,
        error: error.message || 'Could not run yt-dlp',
      };
    }
  }

  async recent(limit = 30) {
    await this.ensureReady();
    const capped = Math.max(1, Math.min(Number(limit) || 30, 100));
    return [...this.ready.values()]
      .sort((a, b) => Number(b.lastUsedMs || b.mtimeMs || 0) - Number(a.lastUsedMs || a.mtimeMs || 0))
      .slice(0, capped);
  }

  async metadata(rawUrl, { limit = 50, signal } = {}) {
    const parsed = parseYouTubeUrl(rawUrl);
    const ytDlp = this.resolveYtDlp();
    if (!ytDlp) throw Object.assign(new Error('yt-dlp was not found on this server'), { status: 500 });
    await this.detectRuntime(ytDlp, signal);
    const capped = Math.max(1, Math.min(Number(limit) || 50, 200));

    if (parsed.kind === 'video') {
      const args = [
        ...this.baseYtDlpArgs({ includeJsRuntime: true }),
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
        '--',
        parsed.canonicalUrl,
      ];
      const res = await this.runCommand(ytDlp, args, { timeoutMs: 30000, signal });
      if (res.code !== 0) {
        const msg = cleanYtDlpError(res.stderr) || 'Could not read YouTube video info';
        this.logger?.warn?.(
          'YouTube',
          `Metadata failed for ${parsed.canonicalUrl} (exit ${res.code}, yt-dlp ${this.ytdlpVersion || 'unknown'}): ${msg}`,
        );
        throw Object.assign(new Error(msg), { status: 502 });
      }
      const raw = JSON.parse(res.stdout);
      return { kind: 'video', video: entryToVideoMeta(raw, parsed.videoId) };
    }

    const args = [
      ...this.baseYtDlpArgs({ includeJsRuntime: true }),
      '--dump-single-json',
      '--flat-playlist',
      '--playlist-end',
      String(capped),
      '--',
      parsed.canonicalUrl,
    ];
    const res = await this.runCommand(ytDlp, args, { timeoutMs: 45000, signal });
    if (res.code !== 0) {
      const msg = cleanYtDlpError(res.stderr) || 'Could not read YouTube playlist';
      this.logger?.warn?.(
        'YouTube',
        `Playlist metadata failed for ${parsed.canonicalUrl} (exit ${res.code}, yt-dlp ${this.ytdlpVersion || 'unknown'}): ${msg}`,
      );
      throw Object.assign(new Error(msg), { status: 502 });
    }
    const raw = JSON.parse(res.stdout);
    const items = [];
    for (const entry of raw?.entries || []) {
      if (!entry || typeof entry !== 'object') continue;
      const vid = String(entry.id || '');
      if (!VIDEO_ID.test(vid)) continue;
      const item = entryToVideoMeta(entry, vid);
      if (item.isLive || !(item.duration > 0)) continue;
      items.push(item);
    }
    const thumbs = Array.isArray(raw?.thumbnails) ? raw.thumbnails : [];
    const lastThumb = thumbs.length ? thumbs[thumbs.length - 1]?.url : undefined;
    return {
      kind: 'playlist',
      id: String(raw?.id || parsed.playlistId),
      title: raw?.title || 'YouTube playlist',
      channelTitle: raw?.channel || raw?.uploader || '',
      itemCount: Number(raw?.playlist_count) || items.length,
      thumbnailUrl: isAllowedThumbnailUrl(lastThumb) ? lastThumb : undefined,
      items,
    };
  }

  async prepare(videoId, { signal } = {}) {
    if (!VIDEO_ID.test(videoId || '')) throw Object.assign(new Error('Invalid video ID'), { status: 400 });
    await this.ensureReady();

    const cached = this.ready.get(videoId);
    if (cached) {
      const safe = await safeCacheFile(this.cacheDirectory, cached.filename);
      if (safe) {
        if (!Array.isArray(cached.streams)) {
          const probed = await this.probeMedia(safe.file);
          Object.assign(cached, probed, ...(Array.isArray(probed.streams) ? [] : [{ streams: [] }]));
          await this.writeMeta(cached).catch(() => {});
        }
        this.touchRecord(cached);
        return cached;
      }
      this.ready.delete(videoId);
      await fsp.unlink(this.metaPath(videoId)).catch(() => {});
    }

    const jobPromise = this.enqueueJob(videoId, 1);
    if (!signal) return jobPromise;

    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }
      const onAbort = () => reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      jobPromise.then(
        val => {
          signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        err => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  async warm(items) {
    if (this.closed) return;
    await this.ensureReady();
    for (const entry of (items || []).slice(0, 3)) {
      const id = entry?.id;
      if (!VIDEO_ID.test(id || '')) continue;
      if (this.ready.has(id) || this.jobs.has(id)) continue;
      void this.enqueueJob(id, 0).catch(error => {
        if (!this.closed) this.logger?.warn?.('YouTubeWarm', error?.message || String(error));
      });
    }
  }

  enqueueJob(videoId, priority) {
    const existing = this.jobs.get(videoId);
    if (existing) {
      if (priority > existing.priority) {
        existing.priority = priority;
        const queued = this.queue.find(item => item.videoId === videoId);
        if (queued) queued.priority = priority;
      }
      return existing.promise;
    }

    let resolveJob, rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const entry = {
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      priority,
      resolve: resolveJob,
      reject: rejectJob,
    };
    this.jobs.set(videoId, { promise, priority, reject: rejectJob });
    this.queue.push(entry);
    this.pumpQueue();
    return promise;
  }

  pumpQueue() {
    if (this.closed) return;
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      let bestIndex = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i].priority > this.queue[bestIndex].priority) bestIndex = i;
      }
      const [item] = this.queue.splice(bestIndex, 1);
      const task = this.downloadVideo(item.videoId, item.canonicalUrl)
        .then(
          record => item.resolve(record),
          error => item.reject(error),
        )
        .finally(() => {
          this.active.delete(item.videoId);
          this.jobs.delete(item.videoId);
          this.pumpQueue();
        });
      this.active.set(item.videoId, task);
    }
  }

  async probeMedia(mediaFile) {
    const ffprobe = this.resolveFfprobe();
    if (!ffprobe) return {};
    try {
      const res = await this.runCommand(
        ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mediaFile],
        { timeoutMs: 15000 },
      );
      if (res.code !== 0) return {};
      const data = JSON.parse(res.stdout);
      const rawStreams = Array.isArray(data?.streams) ? data.streams : [];
      const video = rawStreams.find(s => s.codec_type === 'video');
      const audio = rawStreams.find(s => s.codec_type === 'audio');
      const duration = Number(data?.format?.duration || 0);
      const bitrateRaw = Number(data?.format?.bit_rate || 0);
      const hdr = classifyHdr(video);
      const bitDepth = Number(video?.bits_per_raw_sample) || (hdr.hdr ? 10 : 8);
      const streams = [];
      for (const s of rawStreams) {
        if ((s.codec_type !== 'audio' && s.codec_type !== 'subtitle') || !Number.isSafeInteger(s.index)) continue;
        const lang = typeof s.tags?.language === 'string' ? s.tags.language.trim() : undefined;
        const title = typeof s.tags?.title === 'string' ? s.tags.title.trim() : undefined;
        streams.push({
          index: s.index,
          codec_type: s.codec_type,
          codec_name: s.codec_name ? String(s.codec_name) : undefined,
          channels: Number.isFinite(Number(s.channels)) ? Number(s.channels) : undefined,
          ...(lang ? { language: lang } : {}),
          ...(title ? { title } : {}),
          default: s.disposition?.default === 1,
          forced: s.disposition?.forced === 1,
          sdh: s.disposition?.hearing_impaired === 1,
          commentary: s.disposition?.comment === 1,
          description: s.disposition?.visual_impaired === 1,
        });
      }
      return {
        ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
        ...(Number.isFinite(bitrateRaw) && bitrateRaw > 0 ? { bitrate: Math.round(bitrateRaw / 1000) } : {}),
        ...(video?.codec_name ? { videoCodec: String(video.codec_name) } : {}),
        ...(audio?.codec_name ? { audioCodec: String(audio.codec_name) } : {}),
        ...(video?.width ? { width: Number(video.width) } : {}),
        ...(video?.height ? { height: Number(video.height) } : {}),
        hdr: {
          hdr: hdr.hdr,
          kind: hdr.kind,
          label: hdr.label,
          doviProfile: hdr.doviProfile ?? null,
        },
        bitDepth,
        streams,
      };
    } catch {
      return {};
    }
  }

  async downloadVideo(videoId, canonicalUrl) {
    if (this.closed) throw Object.assign(new Error('YouTube cache is closing'), { status: 503 });
    const ytDlp = this.resolveYtDlp();
    if (!ytDlp) {
      throw Object.assign(new Error('yt-dlp was not found on this server; install yt-dlp or set yt_dlp'), {
        status: 500,
      });
    }
    await this.detectRuntime(ytDlp);
    this.logger?.info?.('YouTube', `Downloading ${videoId} (yt-dlp ${this.ytdlpVersion || 'unknown'})`);
    const ffmpeg = this.resolveFfmpeg();
    const stage = path.join(this.tmpDirectory, `${videoId}-${randomUUID().slice(0, 8)}`);
    await fsp.mkdir(stage, { recursive: true });
    try {
      const outTemplate = path.join(stage, `${videoId}.%(ext)s`);
      const formatArgs = ffmpeg
        ? [
            '--ffmpeg-location',
            path.dirname(ffmpeg),
            '--merge-output-format',
            'mp4',
            '--format',
            'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/bv*+ba/b',
          ]
        : ['--format', 'b[ext=mp4]/b'];
      const args = [
        ...this.baseYtDlpArgs({ includeJsRuntime: true }),
        '--no-playlist',
        '--write-info-json',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'en.*,en',
        '--sub-format',
        'vtt',
        ...formatArgs,
        '-o',
        outTemplate,
        '--',
        canonicalUrl,
      ];
      const res = await this.runCommand(ytDlp, args, { cwd: stage, timeoutMs: 110000 });
      if (this.closed) throw Object.assign(new Error('YouTube cache closed during download'), { status: 503 });
      if (res.code !== 0) {
        const msg = cleanYtDlpError(res.stderr) || 'yt-dlp failed to download this video';
        this.logger?.warn?.(
          'YouTube',
          `Download failed for ${videoId} (exit ${res.code}, yt-dlp ${this.ytdlpVersion || 'unknown'}): ${msg}`,
        );
        throw Object.assign(new Error(msg), { status: 502 });
      }

      const stageFiles = await fsp.readdir(stage, { withFileTypes: true });
      const mediaEntry = stageFiles.find(e => e.isFile() && MEDIA_EXTS.has(path.extname(e.name).toLowerCase()));
      if (!mediaEntry) throw Object.assign(new Error('yt-dlp did not produce a video file'), { status: 502 });

      const infoFile = path.join(stage, `${videoId}.info.json`);
      let rawInfo = {};
      try {
        rawInfo = JSON.parse(await fsp.readFile(infoFile, 'utf8'));
      } catch {
        /* Metadata fallback stays minimal if info.json was omitted. */
      }
      const meta = entryToVideoMeta(rawInfo, videoId);
      if (meta.isLive)
        throw Object.assign(new Error('Live streams and upcoming premieres are not supported'), { status: 400 });

      const ext = path.extname(mediaEntry.name).toLowerCase();
      const destFilename = `${videoId}${ext}`;
      const destMedia = path.join(this.cacheDirectory, destFilename);
      await fsp.rename(path.join(stage, mediaEntry.name), destMedia);

      const subtitles = [];
      const vttEntries = stageFiles
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.vtt'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const vttEntry of vttEntries) {
        const { trackId, language } = normalizeSubTag(vttEntry.name, videoId);
        const subFilename = `${videoId}.${trackId}.vtt`;
        await fsp.rename(path.join(stage, vttEntry.name), path.join(this.cacheDirectory, subFilename));
        subtitles.push({ id: trackId, language, label: language.toUpperCase(), file: subFilename });
      }

      const probed = await this.probeMedia(destMedia);
      const stat = await fsp.stat(destMedia);
      const ts = this.nextTick();
      const record = {
        ...meta,
        ...probed,
        status: 'ready',
        filename: destFilename,
        container: ext.slice(1),
        size: stat.size,
        mtimeMs: stat.mtimeMs || ts,
        lastUsedMs: ts,
        subtitles,
      };
      await this.writeMeta(record);
      this.ready.set(videoId, record);
      this.logger?.info?.(
        'YouTube',
        `Cached ${videoId} (${destFilename}, ${Math.round(stat.size / 1024)} KB, ${Math.round(record.duration || 0)}s)`,
      );
      await this.evictIfNeeded(new Set([videoId]));
      return record;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async resolveMediaFile(videoId) {
    if (!VIDEO_ID.test(videoId || '')) return null;
    await this.ensureReady();
    const rec = this.ready.get(videoId);
    if (!rec) return null;
    const safe = await safeCacheFile(this.cacheDirectory, rec.filename);
    if (!safe) {
      this.ready.delete(videoId);
      await fsp.unlink(this.metaPath(videoId)).catch(() => {});
      return null;
    }
    this.touchRecord(rec);
    const ext = path.extname(safe.file).toLowerCase();
    return {
      file: safe.file,
      stat: safe.stat,
      contentType: CONTAINER_MIME[ext] || 'video/mp4',
      record: rec,
    };
  }

  async resolveSubtitleFile(videoId, trackId) {
    if (!VIDEO_ID.test(videoId || '') || !SAFE_TRACK.test(trackId || '')) return null;
    await this.ensureReady();
    const rec = this.ready.get(videoId);
    if (!rec) return null;
    const sub = (rec.subtitles || []).find(s => s.id === trackId);
    if (!sub) return null;
    const safe = await safeCacheFile(this.cacheDirectory, sub.file);
    return safe ? safe.file : null;
  }

  async close() {
    this.closed = true;
    for (const timer of this.metaTimers.values()) clearTimeout(timer);
    this.metaTimers.clear();
    const cancelled = Object.assign(new Error('YouTube source shutting down'), { status: 503 });
    while (this.queue.length) {
      const queued = this.queue.shift();
      queued.reject(cancelled);
    }
    for (const child of [...this.children]) killChild(child);
    await Promise.allSettled([...this.active.values()]);
    await fsp.rm(this.tmpDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  YouTubeCache,
  resolveBinary,
  versionAtLeast,
  safeBaseName,
  safeCacheFile,
  SAFE_ID,
  SAFE_TRACK,
  CONTAINER_MIME,
  DEFAULT_MAX_CACHE_BYTES,
  MIN_EJS_VERSION,
};
