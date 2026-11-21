'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const setup = require('./setup');
const { youtubeProvider, YouTubeMedia } = require('./provider');
const { checkApiKey } = require('./api');
const { YouTubeCache } = require('./ytdlp');

const CONTROL = /[\u0000-\u001f\u007f]/;
const DELIVERIES = new Set(['auto', 'ytdlp', 'embed']);
const KNOWN_KEYS = new Set([
  'delivery',
  'api_key',
  'yt_dlp',
  'cache_directory',
  'max_cache_gb',
  'max_concurrent',
  'cookies_file',
  'po_token_url',
  'playlist_limit',
]);

function cleanOptionalText(value, max, label, id) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) {
    throw new Error(`sources ${id}: ${label} must be quoted text of up to ${max} characters`);
  }
  return value.trim();
}

function resolveMaybePath(value, base) {
  if (!value) return '';
  if (value.includes('/') || value.includes('\\') || value.startsWith('.')) return path.resolve(base, value);
  return value;
}

function validate(settings, context = {}) {
  const id = context.id || 'youtube';
  const base = context.base || process.cwd();
  const dataDir = context.dataDirectory || path.resolve(base, 'data');

  for (const key of Object.keys(settings)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`sources ${id}: unknown youtube setting "${key}"; check config.example.yaml`);
    }
  }

  const delivery = settings.delivery === undefined ? 'auto' : settings.delivery;
  if (typeof delivery !== 'string' || !DELIVERIES.has(delivery)) {
    throw new Error(`sources ${id}: youtube.delivery must be 'auto', 'ytdlp', or 'embed'`);
  }

  const apiKey = cleanOptionalText(settings.api_key, 256, 'youtube.api_key', id);
  const ytDlpRaw = cleanOptionalText(settings.yt_dlp, 500, 'youtube.yt_dlp', id);
  const cacheDirRaw = cleanOptionalText(settings.cache_directory, 500, 'youtube.cache_directory', id);
  const cookiesRaw = cleanOptionalText(settings.cookies_file, 500, 'youtube.cookies_file', id);
  const poTokenRaw = cleanOptionalText(settings.po_token_url, 500, 'youtube.po_token_url', id);

  let poTokenUrl = '';
  if (poTokenRaw) {
    let parsed;
    try {
      parsed = new URL(poTokenRaw);
    } catch {
      throw new Error(`sources ${id}: youtube.po_token_url must be a valid URL`);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      throw new Error(`sources ${id}: youtube.po_token_url must be http:// or https:// without credentials`);
    }
    poTokenUrl = poTokenRaw.replace(/\/+$/, '');
  }

  let maxCacheGb = 20;
  if (settings.max_cache_gb !== undefined) {
    const n = Number(settings.max_cache_gb);
    if (!Number.isFinite(n) || n < 0.1 || n > 2000) {
      throw new Error(`sources ${id}: youtube.max_cache_gb must be a number between 0.1 and 2000`);
    }
    maxCacheGb = n;
  }

  let maxConcurrent = 2;
  if (settings.max_concurrent !== undefined) {
    const n = Number(settings.max_concurrent);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      throw new Error(`sources ${id}: youtube.max_concurrent must be an integer between 1 and 4`);
    }
    maxConcurrent = n;
  }

  let playlistLimit = 50;
  if (settings.playlist_limit !== undefined) {
    const n = Number(settings.playlist_limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new Error(`sources ${id}: youtube.playlist_limit must be an integer between 1 and 200`);
    }
    playlistLimit = n;
  }

  return {
    delivery,
    apiKey,
    ytDlp: resolveMaybePath(ytDlpRaw, base),
    cacheDirectory: cacheDirRaw ? path.resolve(base, cacheDirRaw) : path.join(dataDir, 'youtube-cache'),
    maxCacheGb,
    maxConcurrent,
    cookiesFile: cookiesRaw ? path.resolve(base, cookiesRaw) : '',
    poTokenUrl,
    playlistLimit,
  };
}

function validateAll(entries) {
  if (entries.length > 1) {
    throw new Error('Only one youtube source may be configured');
  }
}

function create(entry, services) {
  return youtubeProvider({ source: entry, ...services });
}

async function check(entry, { youtubeFetch = fetch, youtubeRunner, ffmpeg, ffprobe, platform } = {}) {
  const checks = [];
  const label = entry.name || entry.id;

  if (entry.delivery === 'ytdlp' || entry.delivery === 'auto') {
    const cache = new YouTubeCache({
      cacheDirectory: entry.cacheDirectory,
      ytDlpPath: entry.ytDlp,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      platform: platform || process.platform,
      runCommand: youtubeRunner,
    });
    const tools = await cache.checkTools();
    checks.push({
      category: 'Sources',
      name: `${label} yt-dlp`,
      status: !tools.ok ? (entry.delivery === 'auto' ? 'warn' : 'fail') : tools.outdated ? 'warn' : 'pass',
      message: !tools.ok
        ? entry.delivery === 'auto'
          ? 'yt-dlp not found; falling back to IFrame embed playback'
          : tools.error
        : tools.outdated
          ? `yt-dlp ${tools.ytdlp} is outdated for current YouTube extraction`
          : `yt-dlp ${tools.ytdlp} ready`,
      ...(!tools.ok
        ? {
            remediation:
              entry.delivery === 'auto'
                ? 'Install yt-dlp on PATH or set youtube.yt_dlp for cached full-sync playback.'
                : 'Install yt-dlp on PATH or set youtube.yt_dlp.',
          }
        : tools.outdated
          ? { remediation: 'Update yt-dlp (e.g. pip install -U "yt-dlp[default]" or yt-dlp -U).' }
          : {}),
    });
    checks.push({
      category: 'Sources',
      name: `${label} FFmpeg muxing`,
      status: tools.ffmpeg ? 'pass' : 'warn',
      message: tools.ffmpeg
        ? 'FFmpeg ready for high-bitrate video+audio downloads'
        : 'FFmpeg not found; falling back to single-stream MP4 downloads',
      ...(!tools.ffmpeg ? { remediation: 'Install FFmpeg on PATH or set tools.ffmpeg.' } : {}),
    });

    if (entry.cookiesFile) {
      try {
        const st = await fsp.stat(entry.cookiesFile);
        checks.push({
          category: 'Sources',
          name: `${label} cookies file`,
          status: st.isFile() ? 'pass' : 'fail',
          message: st.isFile() ? entry.cookiesFile : 'Configured cookies path is not a file',
        });
      } catch {
        checks.push({
          category: 'Sources',
          name: `${label} cookies file`,
          status: 'fail',
          message: `Cookies file not found: ${entry.cookiesFile}`,
        });
      }
    }

    if (entry.cacheDirectory) {
      try {
        const st = await fsp.lstat(entry.cacheDirectory);
        checks.push({
          category: 'Sources',
          name: `${label} cache directory`,
          status: st.isDirectory() && !st.isSymbolicLink() ? 'pass' : 'warn',
          message: st.isDirectory() ? entry.cacheDirectory : 'Cache path is not a plain directory',
        });
      } catch {
        checks.push({
          category: 'Sources',
          name: `${label} cache directory`,
          status: 'pass',
          message: `Will be created on first download: ${entry.cacheDirectory}`,
        });
      }
    }
  }

  if (entry.apiKey) {
    try {
      await checkApiKey({ apiKey: entry.apiKey, fetch: youtubeFetch });
      checks.push({
        category: 'Sources',
        name: `${label} API key`,
        status: 'pass',
        message: 'YouTube Data API v3 key verified',
      });
    } catch (error) {
      checks.push({
        category: 'Sources',
        name: `${label} API key`,
        status: entry.delivery === 'embed' ? 'fail' : 'warn',
        message: error.message || 'YouTube Data API key check failed',
        remediation: 'Verify youtube.api_key in the Google Cloud Console.',
      });
    }
  } else if (entry.delivery === 'embed') {
    checks.push({
      category: 'Sources',
      name: `${label} IFrame embed`,
      status: 'pass',
      message:
        'IFrame embed ready (using keyless oEmbed; add youtube.api_key for playlists and exact upfront durations)',
    });
  }

  return checks;
}

async function libraries(entry) {
  return [{ id: 'youtube', name: entry.name || 'YouTube', type: 'link' }];
}

module.exports = { validate, validateAll, create, check, libraries, setup, YouTubeMedia };
