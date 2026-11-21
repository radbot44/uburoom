'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const setup = require('./setup');
const { youtubeProvider, YouTubeMedia } = require('./provider');
const { checkApiKey } = require('./api');
const { YouTubeSidecar } = require('./sidecar');

const CONTROL = /[\u0000-\u001f\u007f]/;
const DELIVERIES = new Set(['sidecar', 'embed']);

function cleanOptionalText(value, max, label, id) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) {
    throw new Error(`sources ${id}: ${label} must be quoted text of up to ${max} characters`);
  }
  return value.trim();
}

function validate(settings, context = {}) {
  const id = context.id || 'youtube';
  const base = context.base || process.cwd();
  const delivery = settings.delivery === undefined ? 'sidecar' : settings.delivery;
  if (typeof delivery !== 'string' || !DELIVERIES.has(delivery)) {
    throw new Error(`sources ${id}: youtube.delivery must be 'sidecar' or 'embed'`);
  }

  const apiKey = cleanOptionalText(settings.api_key, 256, 'youtube.api_key', id);
  const sidecarUrlRaw = cleanOptionalText(settings.sidecar_url, 500, 'youtube.sidecar_url', id);
  const sidecarToken = cleanOptionalText(settings.sidecar_token, 512, 'youtube.sidecar_token', id);
  const cacheDirRaw = cleanOptionalText(settings.cache_directory, 500, 'youtube.cache_directory', id);

  let sidecarUrl = '';
  if (sidecarUrlRaw) {
    let parsed;
    try {
      parsed = new URL(sidecarUrlRaw);
    } catch {
      throw new Error(`sources ${id}: youtube.sidecar_url must be a valid URL`);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      throw new Error(`sources ${id}: youtube.sidecar_url must be http:// or https:// without credentials`);
    }
    sidecarUrl = sidecarUrlRaw.replace(/\/+$/, '');
  }

  if (delivery === 'embed' && !apiKey) {
    throw new Error(`sources ${id}: youtube.api_key is required when delivery is 'embed'`);
  }
  if (delivery === 'sidecar' && !sidecarUrl) {
    throw new Error(`sources ${id}: youtube.sidecar_url is required when delivery is 'sidecar'`);
  }

  let playlistLimit = 50;
  if (settings.playlist_limit !== undefined) {
    const n = Number(settings.playlist_limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new Error(`sources ${id}: youtube.playlist_limit must be an integer between 1 and 200`);
    }
    playlistLimit = n;
  }

  const cacheDirectory = cacheDirRaw ? path.resolve(base, cacheDirRaw) : '';
  return { delivery, apiKey, sidecarUrl, sidecarToken, cacheDirectory, playlistLimit };
}

function validateAll(entries) {
  if (entries.length > 1) {
    throw new Error('Only one youtube source may be configured');
  }
}

function create(entry, services) {
  return youtubeProvider({ source: entry, ...services });
}

async function check(entry, { youtubeFetch = fetch } = {}) {
  const checks = [];
  const label = entry.name || entry.id;
  if (entry.delivery === 'sidecar') {
    if (!entry.sidecarUrl) {
      checks.push({
        category: 'Sources',
        name: `${label} sidecar`,
        status: 'fail',
        message: 'Sidecar URL is not set',
        remediation: 'Set sidecar_url in config.yaml or Server settings.',
      });
    } else {
      try {
        const health = await new YouTubeSidecar({
          baseUrl: entry.sidecarUrl,
          token: entry.sidecarToken,
          fetch: youtubeFetch,
        }).health();
        checks.push({
          category: 'Sources',
          name: `${label} sidecar`,
          status: health?.ok ? 'pass' : 'fail',
          message: health?.ok
            ? `Sidecar ready${health.ytdlp ? ` (yt-dlp ${health.ytdlp})` : ''}`
            : 'Sidecar reported unhealthy',
          ...(!health?.ok ? { remediation: 'Check the YouTube yt-dlp sidecar process and logs.' } : {}),
        });
      } catch (error) {
        checks.push({
          category: 'Sources',
          name: `${label} sidecar`,
          status: 'fail',
          message: error.message || 'Sidecar unreachable',
          remediation: 'Start the yt-dlp sidecar service and verify sidecar_url and sidecar_token.',
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
      name: `${label} API key`,
      status: 'fail',
      message: 'YouTube Data API key is missing',
      remediation: 'Set youtube.api_key for embed delivery.',
    });
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
        status: 'warn',
        message: `Cache directory does not exist yet: ${entry.cacheDirectory}`,
      });
    }
  }
  return checks;
}

async function libraries(entry) {
  return [{ id: 'youtube', name: entry.name || 'YouTube', type: 'link' }];
}

module.exports = { validate, validateAll, create, check, libraries, setup, YouTubeMedia };
