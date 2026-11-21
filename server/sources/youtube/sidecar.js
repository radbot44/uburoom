'use strict';

const { isAllowedThumbnailUrl } = require('./urls');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TRACK = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_POLL_MS = 450;
const DEFAULT_PREPARE_TIMEOUT_MS = 115000;
const REQUEST_TIMEOUT_MS = 15000;
const METADATA_TIMEOUT_MS = 30000;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const timer = setTimeout(onDone, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    function onDone() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function combinedSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeBaseName(name) {
  if (typeof name !== 'string' || !name) return '';
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') return '';
  return name;
}

function normalizeSubtitle(entry) {
  if (!entry || typeof entry.id !== 'string' || !SAFE_TRACK.test(entry.id)) return null;
  return {
    id: entry.id,
    language: typeof entry.language === 'string' && entry.language ? entry.language : 'und',
    label: typeof entry.label === 'string' && entry.label ? entry.label : entry.language || 'Subtitles',
    format: 'vtt',
  };
}

function normalizeSidecarVideo(raw) {
  if (!raw || typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return null;
  const duration = Number(raw.duration);
  const size = Number(raw.size);
  const mtimeMs = Number(raw.mtimeMs);
  return {
    id: raw.id,
    status: raw.status || 'ready',
    title: typeof raw.title === 'string' && raw.title ? raw.title : 'YouTube video',
    channelTitle: typeof raw.channelTitle === 'string' ? raw.channelTitle : '',
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    filename: safeBaseName(raw.filename),
    container: typeof raw.container === 'string' ? raw.container : 'mp4',
    videoCodec: typeof raw.videoCodec === 'string' ? raw.videoCodec : undefined,
    audioCodec: typeof raw.audioCodec === 'string' ? raw.audioCodec : undefined,
    width: Number.isFinite(Number(raw.width)) ? Number(raw.width) : undefined,
    height: Number.isFinite(Number(raw.height)) ? Number(raw.height) : undefined,
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : Date.now(),
    thumbnailUrl: isAllowedThumbnailUrl(raw.thumbnailUrl) ? raw.thumbnailUrl : undefined,
    description: typeof raw.description === 'string' ? raw.description : '',
    year: Number.isFinite(Number(raw.year)) ? Number(raw.year) : undefined,
    isLive: !!raw.isLive,
    subtitles: Array.isArray(raw.subtitles) ? raw.subtitles.map(normalizeSubtitle).filter(Boolean) : [],
    error: typeof raw.error === 'string' ? raw.error : undefined,
  };
}

/**
 * HTTP client for Uburoom's optional `sidecars/yt-dlp` caching service.
 */
class YouTubeSidecar {
  constructor({ baseUrl, token = '', fetch = globalThis.fetch } = {}) {
    if (!baseUrl) throw new Error('YouTube sidecar URL is not configured');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token || '';
    this.fetch = fetch;
  }

  headers(extra = {}) {
    const out = { ...extra };
    if (this.token) out.Authorization = `Bearer ${this.token}`;
    return out;
  }

  async callJson(method, path, { body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const init = {
      method,
      headers: this.headers(
        body !== undefined
          ? { 'Content-Type': 'application/json', Accept: 'application/json' }
          : { Accept: 'application/json' },
      ),
      signal: combinedSignal(signal, timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, init);
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      throw Object.assign(new Error('YouTube sidecar is unreachable'), { status: 502 });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        data?.error ||
        (res.status === 401 || res.status === 403
          ? 'YouTube sidecar rejected authentication'
          : `YouTube sidecar error (${res.status})`);
      throw Object.assign(new Error(msg), { status: res.status === 404 ? 404 : res.status === 400 ? 400 : 502 });
    }
    return data || {};
  }

  async health(signal) {
    return this.callJson('GET', '/health', { signal, timeoutMs: 5000 });
  }

  async recent(limit = 30, signal) {
    const capped = Math.max(1, Math.min(Number(limit) || 30, 100));
    const data = await this.callJson('GET', `/recent?limit=${capped}`, { signal });
    return Array.isArray(data.items) ? data.items.map(normalizeSidecarVideo).filter(Boolean) : [];
  }

  async metadata(url, { limit = 50, signal } = {}) {
    const data = await this.callJson('POST', '/metadata', {
      body: { url, limit },
      signal,
      timeoutMs: METADATA_TIMEOUT_MS,
    });
    if (data.kind === 'playlist') {
      return {
        kind: 'playlist',
        id: data.id,
        title: data.title || 'YouTube playlist',
        channelTitle: data.channelTitle || '',
        itemCount: Number(data.itemCount) || (Array.isArray(data.items) ? data.items.length : 0),
        thumbnailUrl: isAllowedThumbnailUrl(data.thumbnailUrl) ? data.thumbnailUrl : undefined,
        items: Array.isArray(data.items) ? data.items.map(normalizeSidecarVideo).filter(Boolean) : [],
      };
    }
    const video = normalizeSidecarVideo(data.video || data);
    if (!video) throw Object.assign(new Error('YouTube sidecar returned invalid video metadata'), { status: 502 });
    return { kind: 'video', video };
  }

  async warm(items, signal) {
    const valid = (items || []).filter(item => item?.id && SAFE_ID.test(item.id));
    if (!valid.length) return;
    await this.callJson('POST', '/warm', {
      body: { items: valid.map(item => ({ id: item.id, url: item.url })) },
      signal,
    });
  }

  async status(id, signal) {
    if (!SAFE_ID.test(id || '')) throw Object.assign(new Error('Invalid video ID'), { status: 400 });
    const data = await this.callJson('GET', `/status/${encodeURIComponent(id)}`, { signal });
    return normalizeSidecarVideo(data);
  }

  async prepare(id, { url, signal, timeoutMs = DEFAULT_PREPARE_TIMEOUT_MS } = {}) {
    if (!SAFE_ID.test(id || '')) throw Object.assign(new Error('Invalid video ID'), { status: 400 });
    const deadline = Date.now() + timeoutMs;
    let info = normalizeSidecarVideo(
      await this.callJson('POST', '/prepare', {
        body: { id, url: url || `https://www.youtube.com/watch?v=${id}` },
        signal,
        timeoutMs: METADATA_TIMEOUT_MS,
      }),
    );
    while (info && info.status === 'preparing') {
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('YouTube video download timed out; try again shortly'), { status: 504 });
      }
      await sleep(DEFAULT_POLL_MS, signal);
      info = await this.status(id, signal);
    }
    if (!info) throw Object.assign(new Error('YouTube video was not cached by sidecar'), { status: 502 });
    if (info.status === 'failed') {
      throw Object.assign(new Error(info.error || 'YouTube sidecar could not download this video'), { status: 502 });
    }
    return info;
  }

  async openResource(resource, options = {}) {
    if (!resource || !SAFE_ID.test(resource.id || ''))
      throw Object.assign(new Error('Invalid media resource'), { status: 400 });
    let path;
    if (resource.kind === 'media') {
      path = `/files/${encodeURIComponent(resource.id)}`;
    } else if (resource.kind === 'subtitle') {
      if (!SAFE_TRACK.test(resource.trackId || ''))
        throw Object.assign(new Error('Invalid subtitle track'), { status: 400 });
      path = `/subtitles/${encodeURIComponent(resource.id)}/${encodeURIComponent(resource.trackId)}`;
    } else {
      throw Object.assign(new Error('Unknown sidecar resource type'), { status: 400 });
    }
    const extra = {};
    for (const [k, v] of Object.entries(options.headers || {})) {
      if (k.toLowerCase() === 'range' || k.toLowerCase() === 'accept') extra[k] = v;
    }
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method: options.method || 'GET',
        headers: this.headers(extra),
        signal: options.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
      throw Object.assign(new Error('Could not read YouTube media from sidecar'), { status: 502 });
    }
    if (!res.ok && res.status !== 206) {
      void res.body?.cancel?.().catch(() => {});
      const msg =
        res.status === 404
          ? 'Cached YouTube file is no longer present in sidecar'
          : `Sidecar media error (${res.status})`;
      throw Object.assign(new Error(msg), { status: res.status === 404 ? 404 : 502 });
    }
    return res;
  }
}

module.exports = {
  YouTubeSidecar,
  normalizeSidecarVideo,
  safeBaseName,
  SAFE_ID,
  SAFE_TRACK,
};
