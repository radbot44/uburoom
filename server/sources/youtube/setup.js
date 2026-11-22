'use strict';

const os = require('node:os');
const path = require('node:path');
const { checkApiKey } = require('./api');
const { YouTubeCache } = require('./ytdlp');

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

const CONTROL = /[\u0000-\u001f\u007f]/;

function cleanText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value))
    throw fail(`${label} must be text of up to ${max} characters`);
  return value.trim();
}

function resolveMaybePath(value, base) {
  if (!value) return '';
  if (base && (value.includes('/') || value.includes('\\') || value.startsWith('.'))) return path.resolve(base, value);
  return value;
}

function normalizeUrl(raw, label) {
  const text = cleanText(raw, 500, label);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw fail(`Enter a valid ${label} like http://127.0.0.1:4416`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw fail(`${label} must be http:// or https:// without credentials`);
  }
  return text.replace(/\/+$/, '');
}

function parseMaxCacheGb(raw, fallback = 20) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.1 || n > 2000) throw fail('Cache limit must be between 0.1 and 2000 GB');
  return n;
}

function parseMaxConcurrent(raw, fallback = 2) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw fail('Max concurrent downloads must be between 1 and 4');
  return n;
}

const steps = {
  /** Probes installed `yt-dlp`, `ffmpeg`, and `ffprobe` binaries on this host. */
  async probe(_flow, data = {}, { youtubeRunner, ffmpeg, ffprobe, base, platform } = {}) {
    const ytDlpRaw = cleanText(data.ytDlp ?? data.yt_dlp, 500, 'yt-dlp path');
    const ytDlpPath = resolveMaybePath(ytDlpRaw, base);
    const cacheDir = path.join(base || os.tmpdir(), 'data', 'youtube-cache');
    const cache = new YouTubeCache({
      cacheDirectory: cacheDir,
      ytDlpPath,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      platform: platform || process.platform,
      runCommand: youtubeRunner,
    });
    const info = await cache.checkTools();
    return {
      ok: info.ok,
      ytdlp: info.ytdlp,
      ytDlpPath: info.ytDlpPath,
      ffmpeg: info.ffmpeg,
      ffprobe: info.ffprobe,
      error: info.error,
    };
  },

  /** Validates YouTube delivery mode, installed tools, and optional Data API key. */
  async configure(flow, data, { youtubeFetch = fetch, youtubeRunner, ffmpeg, ffprobe, base, platform } = {}) {
    const rawDelivery = data.delivery ?? 'auto';
    const delivery = ['auto', 'ytdlp', 'embed'].includes(rawDelivery) ? rawDelivery : null;
    if (!delivery) throw fail('Delivery mode must be auto, ytdlp, or embed');

    const apiKey = cleanText(data.apiKey ?? data.api_key, 256, 'YouTube Data API key');
    const ytDlpRaw = cleanText(data.ytDlp ?? data.yt_dlp, 500, 'yt-dlp path');
    const ytDlp = resolveMaybePath(ytDlpRaw, base);
    const cacheDirRaw = cleanText(data.cacheDirectory ?? data.cache_directory, 500, 'Cache directory');
    const cacheDirectory = cacheDirRaw && base ? path.resolve(base, cacheDirRaw) : cacheDirRaw;
    const maxCacheGb = parseMaxCacheGb(data.maxCacheGb ?? data.max_cache_gb, 20);
    const maxConcurrent = parseMaxConcurrent(data.maxConcurrent ?? data.max_concurrent, 2);
    const cookiesRaw = cleanText(data.cookiesFile ?? data.cookies_file, 500, 'Cookies file');
    const cookiesFile = cookiesRaw && base ? path.resolve(base, cookiesRaw) : cookiesRaw;
    const poTokenUrl = normalizeUrl(data.poTokenUrl ?? data.po_token_url, 'PO token URL');

    let toolsInfo = null;
    if (delivery === 'ytdlp' || delivery === 'auto') {
      const checkDir = cacheDirectory || path.join(base || os.tmpdir(), 'data', 'youtube-cache');
      const probe = new YouTubeCache({
        cacheDirectory: checkDir,
        ytDlpPath: ytDlp,
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
        platform: platform || process.platform,
        runCommand: youtubeRunner,
      });
      toolsInfo = await probe.checkTools();
      if (!toolsInfo.ok && (delivery === 'ytdlp' || ytDlpRaw)) {
        throw fail(toolsInfo.error || 'yt-dlp was not found on this server');
      }
    }

    if (apiKey) {
      try {
        await checkApiKey({ apiKey, fetch: youtubeFetch });
      } catch (error) {
        throw fail(error.message || 'YouTube Data API key check failed', error.status || 400);
      }
    }

    flow.draft = {
      entry: {
        delivery,
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(ytDlpRaw ? { yt_dlp: ytDlp } : {}),
        ...(cacheDirRaw ? { cache_directory: cacheDirectory } : {}),
        ...(maxCacheGb !== 20 ? { max_cache_gb: maxCacheGb } : {}),
        ...(maxConcurrent !== 2 ? { max_concurrent: maxConcurrent } : {}),
        ...(cookiesRaw ? { cookies_file: cookiesFile } : {}),
        ...(poTokenUrl ? { po_token_url: poTokenUrl } : {}),
      },
      identity: 'youtube',
      name: 'YouTube',
      libraries: [{ id: 'youtube', name: 'YouTube' }],
    };

    return {
      delivery,
      ytDlp: ytDlpRaw ? ytDlp : '',
      cacheDirectory: cacheDirRaw ? cacheDirectory : '',
      maxCacheGb,
      maxConcurrent,
      cookiesFile: cookiesRaw ? cookiesFile : '',
      poTokenUrl,
      hasApiKey: !!apiKey,
      ...(toolsInfo ? { ytdlp: toolsInfo.ytdlp, ffmpeg: toolsInfo.ffmpeg, ffprobe: toolsInfo.ffprobe } : {}),
    };
  },
};

function entry(draft) {
  return { ...draft.entry };
}

/** Validates partial YouTube settings edits from Server Settings -> Sources while keeping untouched secrets. */
async function update(
  settings,
  { youtubeFetch = fetch, youtubeRunner, ffmpeg, ffprobe, base, platform, current } = {},
) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw fail('Send the YouTube source settings');

  const delivery =
    settings.delivery === undefined
      ? undefined
      : ['auto', 'ytdlp', 'embed'].includes(settings.delivery)
        ? settings.delivery
        : (() => {
            throw fail('Delivery mode must be auto, ytdlp, or embed');
          })();

  const ytDlpSupplied = settings.ytDlp !== undefined || settings.yt_dlp !== undefined;
  const ytDlp = ytDlpSupplied
    ? resolveMaybePath(cleanText(settings.ytDlp ?? settings.yt_dlp, 500, 'yt-dlp path'), base)
    : undefined;
  const cacheDirectory =
    settings.cacheDirectory === undefined && settings.cache_directory === undefined
      ? undefined
      : (() => {
          const raw = cleanText(settings.cacheDirectory ?? settings.cache_directory, 500, 'Cache directory');
          return raw && base ? path.resolve(base, raw) : '';
        })();
  const maxCacheGb =
    settings.maxCacheGb === undefined && settings.max_cache_gb === undefined
      ? undefined
      : parseMaxCacheGb(settings.maxCacheGb ?? settings.max_cache_gb, 20);
  const maxConcurrent =
    settings.maxConcurrent === undefined && settings.max_concurrent === undefined
      ? undefined
      : parseMaxConcurrent(settings.maxConcurrent ?? settings.max_concurrent, 2);
  const cookiesFile =
    settings.cookiesFile === undefined && settings.cookies_file === undefined
      ? undefined
      : (() => {
          const raw = cleanText(settings.cookiesFile ?? settings.cookies_file, 500, 'Cookies file');
          return raw && base ? path.resolve(base, raw) : '';
        })();
  const poTokenUrl =
    settings.poTokenUrl === undefined && settings.po_token_url === undefined
      ? undefined
      : normalizeUrl(settings.poTokenUrl ?? settings.po_token_url, 'PO token URL');

  const newApiKey = cleanText(settings.apiKey ?? settings.api_key, 256, 'YouTube Data API key');
  const clearApiKey = !!settings.clearApiKey;

  const probeYtDlp = ytDlp !== undefined ? ytDlp : (current?.ytDlp ?? current?.yt_dlp ?? '');
  if (delivery === 'ytdlp' || !!probeYtDlp || !!ytDlp) {
    const checkDir =
      cacheDirectory ||
      current?.cacheDirectory ||
      current?.cache_directory ||
      path.join(base || os.tmpdir(), 'data', 'youtube-cache');
    const probe = new YouTubeCache({
      cacheDirectory: checkDir,
      ytDlpPath: probeYtDlp,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      platform: platform || process.platform,
      runCommand: youtubeRunner,
    });
    const tools = await probe.checkTools();
    if (!tools.ok) throw fail(tools.error || 'yt-dlp was not found on this server');
  }

  if (newApiKey) {
    try {
      await checkApiKey({ apiKey: newApiKey, fetch: youtubeFetch });
    } catch (error) {
      throw fail(error.message || 'YouTube Data API key check failed', error.status || 400);
    }
  }

  return raw => {
    const nextDelivery = delivery ?? (raw.delivery || 'auto');
    const nextApiKey = clearApiKey ? '' : newApiKey || raw.api_key || '';
    const nextYtDlp = ytDlp !== undefined ? ytDlp : raw.yt_dlp || '';
    const nextCacheDir = cacheDirectory !== undefined ? cacheDirectory : raw.cache_directory || '';
    const nextMaxGb = maxCacheGb !== undefined ? maxCacheGb : (raw.max_cache_gb ?? 20);
    const nextMaxConcurrent = maxConcurrent !== undefined ? maxConcurrent : (raw.max_concurrent ?? 2);
    const nextCookies = cookiesFile !== undefined ? cookiesFile : raw.cookies_file || '';
    const nextPoToken = poTokenUrl !== undefined ? poTokenUrl : raw.po_token_url || '';

    const updated = { ...raw, delivery: nextDelivery };
    for (const [key, val] of [
      ['api_key', nextApiKey],
      ['yt_dlp', nextYtDlp],
      ['cache_directory', nextCacheDir],
      ['cookies_file', nextCookies],
      ['po_token_url', nextPoToken],
    ]) {
      if (val) updated[key] = val;
      else delete updated[key];
    }
    if (nextMaxGb !== 20) updated.max_cache_gb = nextMaxGb;
    else delete updated.max_cache_gb;
    if (nextMaxConcurrent !== 2) updated.max_concurrent = nextMaxConcurrent;
    else delete updated.max_concurrent;
    return updated;
  };
}

/** Never exposes `apiKey` back to browser Server Settings UI. */
function summary(saved) {
  const delivery = saved.delivery || 'auto';
  return {
    address:
      delivery === 'embed'
        ? saved.apiKey
          ? 'IFrame embed (API key)'
          : 'IFrame embed (oEmbed)'
        : delivery === 'ytdlp'
          ? 'Built-in yt-dlp cache'
          : 'Auto (yt-dlp cache + IFrame fallback)',
    offered: null,
    delivery,
    ytDlp: saved.ytDlp || '',
    cacheDirectory: saved.cacheDirectory || '',
    maxCacheGb: saved.maxCacheGb ?? 20,
    maxConcurrent: saved.maxConcurrent ?? 2,
    cookiesFile: saved.cookiesFile || '',
    poTokenUrl: saved.poTokenUrl || '',
    hasApiKey: !!saved.apiKey,
  };
}

module.exports = { steps, entry, update, summary, selectLibraries: false };
