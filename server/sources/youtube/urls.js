'use strict';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const WEB_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const ALLOWED_THUMBNAIL_HOSTS = /^((?:i\d?|s)\.ytimg\.com|yt\d?\.(?:ggpht|googleusercontent)\.com)$/i;

function badUrl(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Validates an external thumbnail URL so `artwork()` only ever contacts known YouTube image hosts. */
function isAllowedThumbnailUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    return ALLOWED_THUMBNAIL_HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeUrlInput(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) throw badUrl('Paste a YouTube video or playlist link');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw badUrl('Paste a valid YouTube link');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw badUrl('Paste an http or https YouTube link');
    return parsed;
  }
  const bareHost = /^(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be)\//i.test(trimmed);
  if (!bareHost) throw badUrl('Paste a valid YouTube link');
  try {
    return new URL('https://' + trimmed);
  } catch {
    throw badUrl('Paste a valid YouTube link');
  }
}

/**
 * Parses a YouTube video, Short, Live, Embed, or Playlist URL into validated IDs.
 * @param {string} raw
 * @returns {{ kind: 'video' | 'playlist', videoId?: string, playlistId?: string, canonicalUrl: string }}
 */
function parseYouTubeUrl(raw) {
  const parsed = normalizeUrlInput(raw);
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  const rawList = parsed.searchParams.get('list');
  const playlistId = rawList && PLAYLIST_ID.test(rawList) ? rawList : undefined;

  if (SHORT_HOSTS.has(host)) {
    const candidate = segments[0];
    if (!candidate || !VIDEO_ID.test(candidate)) throw badUrl('That YouTube link does not name a valid video');
    return {
      kind: 'video',
      videoId: candidate,
      ...(playlistId ? { playlistId } : {}),
      canonicalUrl: `https://www.youtube.com/watch?v=${candidate}`,
    };
  }

  if (!WEB_HOSTS.has(host)) throw badUrl('Paste a YouTube video or playlist link');

  const route = (segments[0] || '').toLowerCase();
  if (route === 'watch' || route === '') {
    const candidate = parsed.searchParams.get('v');
    if (candidate) {
      if (!VIDEO_ID.test(candidate)) throw badUrl('That YouTube link does not name a valid video');
      return {
        kind: 'video',
        videoId: candidate,
        ...(playlistId ? { playlistId } : {}),
        canonicalUrl: `https://www.youtube.com/watch?v=${candidate}`,
      };
    }
    if (playlistId) {
      return {
        kind: 'playlist',
        playlistId,
        canonicalUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
      };
    }
    throw badUrl('That YouTube link does not name a video or playlist');
  }

  if (route === 'playlist') {
    if (!playlistId) throw badUrl('That YouTube playlist link is missing a valid playlist ID');
    return {
      kind: 'playlist',
      playlistId,
      canonicalUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
    };
  }

  if (route === 'shorts' || route === 'live' || route === 'embed' || route === 'v' || route === 'e') {
    const candidate = segments[1];
    if (!candidate || !VIDEO_ID.test(candidate)) throw badUrl('That YouTube link does not name a valid video');
    return {
      kind: 'video',
      videoId: candidate,
      ...(playlistId ? { playlistId } : {}),
      canonicalUrl: `https://www.youtube.com/watch?v=${candidate}`,
    };
  }

  throw badUrl('Paste a YouTube video, Short, or playlist link');
}

module.exports = {
  VIDEO_ID,
  PLAYLIST_ID,
  parseYouTubeUrl,
  isAllowedThumbnailUrl,
};
