'use strict';

const { isAllowedThumbnailUrl } = require('./urls');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const API_TIMEOUT_MS = 10000;

/** Converts an ISO-8601 duration string (e.g. `PT1H2M3S`) into seconds. */
function parseIsoDuration(iso) {
  if (typeof iso !== 'string' || !iso) return 0;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!match) return 0;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? Math.round(total) : 0;
}

function pickThumbnail(thumbnails) {
  if (!thumbnails || typeof thumbnails !== 'object') return undefined;
  for (const key of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = thumbnails[key]?.url;
    if (isAllowedThumbnailUrl(url)) return url;
  }
  return undefined;
}

function combinedSignal(signal, ms = API_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function apiGet(path, params, { apiKey, fetch = globalThis.fetch, signal } = {}) {
  if (!apiKey) throw Object.assign(new Error('YouTube Data API key is not configured'), { status: 400 });
  const url = new URL(YOUTUBE_API_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', apiKey);
  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: combinedSignal(signal),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    throw Object.assign(new Error('Could not reach YouTube Data API'), { status: 502 });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    const message =
      res.status === 400 || res.status === 403
        ? reason === 'quotaExceeded' || reason === 'dailyLimitExceeded'
          ? 'YouTube Data API quota exceeded'
          : 'YouTube Data API key was rejected'
        : res.status === 404
          ? 'YouTube video or playlist was not found'
          : `YouTube Data API error (${res.status})`;
    throw Object.assign(new Error(message), { status: res.status === 404 ? 404 : 502 });
  }
  return body || {};
}

function normalizeApiVideo(entry) {
  if (!entry?.id) return null;
  const snippet = entry.snippet || {};
  const details = entry.contentDetails || {};
  const status = entry.status || {};
  const duration = parseIsoDuration(details.duration);
  const year = snippet.publishedAt ? Number(String(snippet.publishedAt).slice(0, 4)) || undefined : undefined;
  const liveState = snippet.liveBroadcastContent;
  return {
    id: entry.id,
    title: snippet.title || 'YouTube video',
    channelTitle: snippet.channelTitle || '',
    channelId: snippet.channelId || '',
    duration,
    year,
    summary: snippet.description ? String(snippet.description).slice(0, 500) : '',
    thumbnailUrl: pickThumbnail(snippet.thumbnails),
    embeddable: status.embeddable !== false,
    privacyStatus: status.privacyStatus || 'public',
    isLive: liveState === 'live' || liveState === 'upcoming',
  };
}

/** Fetches snippet, duration, and embeddable status for up to any number of video IDs via YouTube Data API v3. */
async function fetchVideos(videoIds, { apiKey, fetch, signal } = {}) {
  const unique = [...new Set((videoIds || []).filter(Boolean))];
  const byId = new Map();
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await apiGet(
      '/videos',
      {
        part: 'snippet,contentDetails,status',
        id: chunk.join(','),
      },
      { apiKey, fetch, signal },
    );
    for (const entry of data.items || []) {
      const normalized = normalizeApiVideo(entry);
      if (normalized) byId.set(normalized.id, normalized);
    }
  }
  return byId;
}

/** Fetches playlist metadata and ordered video items (up to `limit`) via YouTube Data API v3. */
async function fetchPlaylist(playlistId, { apiKey, fetch, signal, limit = 50 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
  const head = await apiGet(
    '/playlists',
    {
      part: 'snippet,contentDetails',
      id: playlistId,
    },
    { apiKey, fetch, signal },
  );
  const playlist = head.items?.[0];
  if (!playlist) throw Object.assign(new Error('YouTube playlist was not found'), { status: 404 });

  const refs = [];
  let pageToken = '';
  while (refs.length < capped) {
    const page = await apiGet(
      '/playlistItems',
      {
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: Math.min(50, capped - refs.length),
        ...(pageToken ? { pageToken } : {}),
      },
      { apiKey, fetch, signal },
    );
    for (const entry of page.items || []) {
      const vid = entry.contentDetails?.videoId || entry.snippet?.resourceId?.videoId;
      if (vid && refs.length < capped) refs.push(vid);
    }
    pageToken = page.nextPageToken || '';
    if (!pageToken) break;
  }

  const details = refs.length ? await fetchVideos(refs, { apiKey, fetch, signal }) : new Map();
  const items = [];
  for (const vid of refs) {
    const v = details.get(vid);
    if (!v || v.isLive) continue;
    items.push(v);
  }

  return {
    id: playlist.id || playlistId,
    title: playlist.snippet?.title || 'YouTube playlist',
    channelTitle: playlist.snippet?.channelTitle || '',
    itemCount: playlist.contentDetails?.itemCount ?? items.length,
    thumbnailUrl: pickThumbnail(playlist.snippet?.thumbnails),
    items,
  };
}

/** Verifies a YouTube Data API v3 key using a minimal 1-quota-unit `videos.list` request. */
async function checkApiKey({ apiKey, fetch, signal } = {}) {
  await apiGet('/videos', { part: 'id', id: 'jNQXAC9IVRw' }, { apiKey, fetch, signal });
  return true;
}

/**
 * Fetches basic title, channel, and thumbnail metadata via YouTube's keyless oEmbed endpoint.
 * Duration is not provided by oEmbed (`durationUnknown: true`) and is learned when the embed player loads.
 */
async function fetchOEmbed(videoId, { fetch = globalThis.fetch, signal } = {}) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: combinedSignal(signal),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    throw Object.assign(new Error('Could not reach YouTube oEmbed'), { status: 502 });
  }
  if (!res.ok) {
    void res.body?.cancel?.().catch(() => {});
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('This video has embedding disabled or is private'), {
        status: 400,
        notEmbeddable: true,
      });
    }
    if (res.status === 404) {
      throw Object.assign(new Error('YouTube video is unavailable or private'), { status: 404 });
    }
    throw Object.assign(new Error(`YouTube oEmbed error (${res.status})`), { status: 502 });
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('YouTube oEmbed returned an invalid response'), { status: 502 });
  }
  return {
    id: videoId,
    title: String(body.title || 'YouTube video').slice(0, 200),
    channelTitle: String(body.author_name || '').slice(0, 120),
    thumbnailUrl: isAllowedThumbnailUrl(body.thumbnail_url) ? body.thumbnail_url : undefined,
    duration: 0,
    durationUnknown: true,
    hadUnknownDuration: true,
    embeddable: true,
    isLive: false,
  };
}

module.exports = {
  parseIsoDuration,
  pickThumbnail,
  fetchVideos,
  fetchPlaylist,
  checkApiKey,
  fetchOEmbed,
};
