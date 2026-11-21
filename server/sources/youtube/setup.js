'use strict';

const path = require('node:path');
const { checkApiKey } = require('./api');
const { YouTubeSidecar } = require('./sidecar');

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

const CONTROL = /[\u0000-\u001f\u007f]/;

function cleanText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value))
    throw fail(`${label} must be text of up to ${max} characters`);
  return value.trim();
}

function normalizeUrl(raw) {
  const text = cleanText(raw, 500, 'Sidecar URL');
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw fail('Enter a sidecar URL like http://127.0.0.1:8780');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw fail('Sidecar URL must be http:// or https:// without credentials');
  }
  return text.replace(/\/+$/, '');
}

const steps = {
  /** Validates YouTube delivery mode, optional/required API key, and sidecar connection. */
  async configure(flow, data, { youtubeFetch = fetch, base } = {}) {
    const delivery =
      data.delivery === 'embed' ? 'embed' : data.delivery === 'sidecar' || !data.delivery ? 'sidecar' : null;
    if (!delivery) throw fail('Delivery mode must be sidecar or embed');

    const apiKey = cleanText(data.apiKey ?? data.api_key, 256, 'YouTube Data API key');
    const sidecarUrl = normalizeUrl(data.sidecarUrl ?? data.sidecar_url);
    const sidecarToken = cleanText(data.sidecarToken ?? data.sidecar_token, 512, 'Sidecar token');
    const cacheDirRaw = cleanText(data.cacheDirectory ?? data.cache_directory, 500, 'Cache directory');
    const cacheDirectory = cacheDirRaw && base ? path.resolve(base, cacheDirRaw) : cacheDirRaw;

    if (delivery === 'embed' && !apiKey) {
      throw fail('YouTube Data API v3 key is required for IFrame embed delivery');
    }
    if (delivery === 'sidecar' && !sidecarUrl) {
      throw fail('Sidecar URL is required for yt-dlp sidecar delivery');
    }

    let health = null;
    if (delivery === 'sidecar') {
      const sidecar = new YouTubeSidecar({ baseUrl: sidecarUrl, token: sidecarToken, fetch: youtubeFetch });
      try {
        health = await sidecar.health();
      } catch (error) {
        throw fail(error.message || 'Could not connect to the YouTube sidecar', error.status || 502);
      }
      if (!health?.ok) throw fail('YouTube sidecar reported it is not ready', 502);
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
        ...(sidecarUrl ? { sidecar_url: sidecarUrl } : {}),
        ...(sidecarToken ? { sidecar_token: sidecarToken } : {}),
        ...(cacheDirRaw ? { cache_directory: cacheDirectory } : {}),
      },
      identity: 'youtube',
      name: 'YouTube',
      libraries: [{ id: 'youtube', name: 'YouTube' }],
    };

    return {
      delivery,
      sidecarUrl,
      hasSidecarToken: !!sidecarToken,
      hasApiKey: !!apiKey,
      cacheDirectory: cacheDirRaw ? cacheDirectory : '',
      ...(health ? { ytdlp: health.ytdlp, ffmpeg: !!health.ffmpeg } : {}),
    };
  },
};

function entry(draft) {
  return { ...draft.entry };
}

/** Validates partial YouTube settings edits from Server Settings -> Sources while keeping untouched secrets. */
async function update(settings, { youtubeFetch = fetch, base } = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw fail('Send the YouTube source settings');

  const delivery =
    settings.delivery === undefined
      ? undefined
      : settings.delivery === 'embed' || settings.delivery === 'sidecar'
        ? settings.delivery
        : (() => {
            throw fail('Delivery mode must be sidecar or embed');
          })();

  const sidecarUrl =
    settings.sidecarUrl === undefined && settings.sidecar_url === undefined
      ? undefined
      : normalizeUrl(settings.sidecarUrl ?? settings.sidecar_url);
  const newApiKey = cleanText(settings.apiKey ?? settings.api_key, 256, 'YouTube Data API key');
  const clearApiKey = !!settings.clearApiKey;
  const newSidecarToken = cleanText(settings.sidecarToken ?? settings.sidecar_token, 512, 'Sidecar token');
  const clearSidecarToken = !!settings.clearSidecarToken;
  const cacheDirectory =
    settings.cacheDirectory === undefined && settings.cache_directory === undefined
      ? undefined
      : (() => {
          const raw = cleanText(settings.cacheDirectory ?? settings.cache_directory, 500, 'Cache directory');
          return raw && base ? path.resolve(base, raw) : '';
        })();

  if (newApiKey) {
    try {
      await checkApiKey({ apiKey: newApiKey, fetch: youtubeFetch });
    } catch (error) {
      throw fail(error.message || 'YouTube Data API key check failed', error.status || 400);
    }
  }

  return raw => {
    const nextDelivery = delivery ?? (raw.delivery || 'sidecar');
    const nextSidecarUrl = sidecarUrl !== undefined ? sidecarUrl : raw.sidecar_url || '';
    const nextApiKey = clearApiKey ? '' : newApiKey || raw.api_key || '';
    const nextSidecarToken = clearSidecarToken ? '' : newSidecarToken || raw.sidecar_token || '';
    const nextCacheDir = cacheDirectory !== undefined ? cacheDirectory : raw.cache_directory || '';

    if (nextDelivery === 'embed' && !nextApiKey) {
      throw fail('YouTube Data API v3 key is required for IFrame embed delivery');
    }
    if (nextDelivery === 'sidecar' && !nextSidecarUrl) {
      throw fail('Sidecar URL is required for yt-dlp sidecar delivery');
    }

    const updated = { ...raw, delivery: nextDelivery };
    for (const [key, val] of [
      ['api_key', nextApiKey],
      ['sidecar_url', nextSidecarUrl],
      ['sidecar_token', nextSidecarToken],
      ['cache_directory', nextCacheDir],
    ]) {
      if (val) updated[key] = val;
      else delete updated[key];
    }
    return updated;
  };
}

/** Never exposes `apiKey` or `sidecarToken` back to browser Server Settings UI. */
function summary(saved) {
  return {
    address: saved.delivery === 'embed' ? 'IFrame embed (API key)' : saved.sidecarUrl || 'YouTube',
    offered: null,
    delivery: saved.delivery || 'sidecar',
    sidecarUrl: saved.sidecarUrl || '',
    hasSidecarToken: !!saved.sidecarToken,
    hasApiKey: !!saved.apiKey,
    cacheDirectory: saved.cacheDirectory || '',
  };
}

module.exports = { steps, entry, update, summary, selectLibraries: false };
