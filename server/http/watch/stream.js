'use strict';
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomBytes } = require('node:crypto');
const { PlaybackError, CHUNK, AUDIO_LEAD, AUDIO_MIME } = require('../../av1');
const Playback = require('../../../web/playback-policy');
const Subtitles = require('../../subtitles');
const SubtitleResources = require('../../subtitle-resources');

/** The media proxy: manifests, chunks, captions and subtitles served to a holder of a grant. */
function mediaStream({ config, watch, json, grants, validCaptionGrant, validGrant }) {
  function resource(media, url) {
    const target = watch.plex.url(url).href;
    for (const [key, value] of media.resources) if (value === target) return key;
    if (media.resources.size > 20000) throw new Error('Too many media resources');
    const key = randomBytes(12).toString('hex');
    media.resources.set(key, target);
    return key;
  }
  function rewriteManifest(text, upstream, media, grantId) {
    const resolve = value => {
      if (media.directHls) {
        const source = watch.plex.url(new URL(value, upstream).href);
        const target = new URL(source.pathname + source.search, media.directHls.origin);
        return Playback.directHlsUrl(target.href, { ...media.directHls, session: media.transcodeId });
      }
      return `/api/watch/media/${grantId}/${resource(media, new URL(value, upstream).href)}`;
    };
    return text
      .split(/\r?\n/)
      .map(line =>
        !line.trim()
          ? line
          : line.startsWith('#')
            ? line.replace(/URI="([^"\r\n]+)"/g, (_, value) => `URI="${resolve(value)}"`)
            : resolve(line.trim()),
      )
      .join('\n');
  }
  async function stream(req, res, grant, key, url) {
    if (key.startsWith('subtitle-')) {
      const match = /^subtitle-([a-f0-9-]{36})(?:\/(data|index|window|font-\d{1,2}))?$/.exec(key);
      if (!match || !(await validCaptionGrant(grant, match[1])))
        return json(res, 403, { error: 'Subtitle selection changed or access expired.' });
      const currentMedia = () => grant.room.viewers.get(grant.viewerId)?.media;
      const controller = new AbortController(),
        cancel = () => controller.abort();
      res.on('close', cancel);
      const check = setInterval(async () => {
        try {
          if (!(await validCaptionGrant(grant, match[1]))) controller.abort();
        } catch {
          controller.abort();
        }
      }, 1000);
      try {
        const media = currentMedia();
        const windowed =
          ['pgs', 'cues'].includes(media?.selection?.subtitle?.delivery) && !media?.selection?.subtitle?.external;
        if (!match[2] && windowed) {
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          res.setHeader('Cache-Control', 'no-store');
          const base = `/api/watch/media/${grant.id}/subtitle-${match[1]}/`;
          return json(res, 200, {
            format: media.selection.subtitle.delivery,
            data: base + 'data',
            window: base + 'window',
            fonts: [],
          });
        }
        if (match[2] === 'window' && windowed) {
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          const atMs = url?.searchParams?.has('atMs') ? Number(url.searchParams.get('atMs')) : 0;
          const beforeMs = url?.searchParams?.has('beforeMs') ? Number(url.searchParams.get('beforeMs')) : 15000;
          const afterMs = url?.searchParams?.has('afterMs') ? Number(url.searchParams.get('afterMs')) : 60000;
          const win = await SubtitleResources.window(media.plexContext || watch.plex, media, {
            atMs,
            beforeMs,
            afterMs,
            signal: controller.signal,
          });
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': win.data.length,
            'Cache-Control': 'no-store',
            'X-Subtitle-Start-Ms': String(win.startMs),
            'X-Subtitle-End-Ms': String(win.endMs),
            'X-Subtitle-Cues': String(win.cues),
          });
          return res.end(req.method === 'HEAD' ? undefined : win.data);
        }
        if (
          match[2] === 'data' &&
          media?.selection?.subtitle?.delivery === 'pgs' &&
          !media?.selection?.subtitle?.external
        ) {
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          req.setTimeout?.(0);
          res.setTimeout?.(0);
          await SubtitleResources.pipe(media.plexContext || watch.plex, media, req, res, controller.signal);
          return;
        }
        const result = await SubtitleResources.load(media.plexContext || watch.plex, media, controller.signal);
        if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
          return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
        res.setHeader('Cache-Control', 'no-store');
        if (!match[2]) {
          const base = `/api/watch/media/${grant.id}/subtitle-${match[1]}/`;
          return json(res, 200, {
            format: result.format,
            fileName: result.fileName,
            data: base + 'data',
            ...(result.assets.has('index') ? { index: base + 'index' } : {}),
            fonts: [...result.assets.keys()].filter(k => k.startsWith('font-')).map(k => base + k),
          });
        }
        const data = result.assets.get(match[2]);
        if (!data) return json(res, 404, { error: 'Subtitle resource unavailable.' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
        return res.end(req.method === 'HEAD' ? undefined : data);
      } catch (error) {
        if (!res.headersSent && !res.destroyed)
          json(res, 503, {
            error: error instanceof PlaybackError ? error.message : 'Subtitles could not load. Try burn-in.',
          });
        else if (!res.destroyed) res.destroy();
      } finally {
        clearInterval(check);
        res.off('close', cancel);
      }
      return;
    }
    if (key.startsWith('captions-')) {
      const match = /^captions-([a-f0-9-]{36})$/.exec(key);
      if (!match || !(await validCaptionGrant(grant, match[1])))
        return json(res, 403, { error: 'Subtitle selection changed or access expired.' });
      const abort = new AbortController(),
        cancel = () => abort.abort();
      res.on('close', cancel);
      const check = setInterval(async () => {
        try {
          if (!(await validCaptionGrant(grant, match[1]))) abort.abort();
        } catch {
          abort.abort();
        }
      }, 2000);
      try {
        const media = grant.room.viewers.get(grant.viewerId)?.media;
        const cues = await Subtitles.load(media.plexContext || watch.plex, media, abort.signal);
        if (abort.signal.aborted || !(await validCaptionGrant(grant, match[1])))
          return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
        json(res, 200, { cues });
      } catch (error) {
        if (!res.destroyed)
          json(res, 503, { error: error instanceof PlaybackError ? error.message : 'Subtitles could not load.' });
      } finally {
        clearInterval(check);
        res.off('close', cancel);
      }
      return;
    }
    if (!(await validGrant(grant))) return json(res, 403, { error: 'Viewing access expired or was revoked' });
    const media = grant.media;
    if (media.bootstrapFallback) return json(res, 409, { error: 'Your selected quality is still preparing.' });
    // A direct output never serves video through this process, even if a client
    // tries a stale or manually constructed resource URL. Its start is text only.
    if (media.directHls && key === 'start' && !media.initialManifest)
      return json(res, 409, { error: 'Direct Plex playlist unavailable' });
    if (media.directHls && key !== 'start') return json(res, 409, { error: 'Use the direct Plex media route' });
    if (Playback.localFormat(media.format)) {
      if (key === 'start')
        return json(res, 200, {
          format: media.format,
          mime: Playback.LOCAL_CODECS[media.format],
          audioMime: AUDIO_MIME,
          chunkSeconds: CHUNK,
          audioLead: AUDIO_LEAD,
          duration: media.duration,
          buffer: Playback.BUFFER,
        });
      const match = /^chunk-(video|audio)-(\d{1,9})$/.exec(key),
        index = Number(match?.[2]);
      // The authoritative timeline selects source time. The grant cannot be used
      // as an arbitrary transcoding API, even by an authenticated viewer.
      const window = Playback.chunkWindow(watch.position(grant.room), media.duration);
      if (!match || index < window.first || index > window.last)
        return json(res, 403, { error: 'Chunk is outside the shared playback window' });
      const abort = new AbortController();
      const cancel = () => abort.abort();
      res.on('close', cancel);
      const check = setInterval(async () => {
        try {
          if (!(await validGrant(grant))) abort.abort();
        } catch {
          abort.abort();
        }
      }, 2000);
      try {
        const background = req.headers['x-uburoom-prefetch'] === '1';
        const chunk = await watch.plex.av1.chunk(media.av1Lease, index, abort.signal, {
            urgent: !background && Math.abs(index - Math.floor(watch.position(grant.room) / CHUNK)) <= 1,
            background,
          }),
          bytes = chunk[match[1]];
        if (abort.signal.aborted || !(await validGrant(grant))) return;
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': bytes.length });
        if (req.method === 'HEAD') res.end();
        else await pipeline(Readable.from([bytes]), res);
      } catch (error) {
        if (!res.headersSent && !res.destroyed)
          json(res, 503, { error: error instanceof PlaybackError ? error.message : 'Local video conversion failed' });
        else res.destroy();
      } finally {
        clearInterval(check);
        res.off('close', cancel);
      }
      return;
    }
    if (media.kind === 'demo') {
      if (key !== 'start') return json(res, 404, { error: 'Media unavailable' });
      const size = media.size || (media.size = (await fs.promises.stat(media.file)).size),
        range = req.headers.range;
      let start = 0,
        end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
      }
      const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') return res.end();
      const source = fs.createReadStream(media.file, { start, end });
      const check = setInterval(async () => {
        try {
          if (!(await validGrant(grant))) source.destroy();
        } catch {
          source.destroy();
        }
      }, 2000);
      try {
        await pipeline(source, res);
      } catch {
        res.destroy();
      } finally {
        clearInterval(check);
      }
      return;
    }
    const target = key === 'start' ? media.start : media.resources.get(key);
    if (!target) return json(res, 404, { error: 'Media unavailable' });
    if (key === 'start' && media.initialManifest) {
      // Repeated master loads must keep the captured session. Reissuing start
      // after restoring Plex's audio preference could select another track.
      let text;
      try {
        text = rewriteManifest(media.initialManifest, target, media, grant.id);
      } catch {
        return json(res, 409, { error: 'Plex playlist could not use the selected delivery route' });
      }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(req.method === 'HEAD' ? undefined : text);
    }
    const abort = new AbortController();
    let response;
    const timer = setTimeout(() => abort.abort(), 12000);
    const disconnect = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', disconnect);
    try {
      // The grant's own source access is checked before cached or producer bytes.
      response =
        (media.plexContext || watch.plex).hlsPool?.response(media.hlsLease, target, req.method, req.headers.range) ||
        (await (media.hlsContext || media.plexContext || watch.plex).request(target, {
          method: req.method,
          signal: abort.signal,
          streaming: true,
          headers: {
            Accept: '*/*',
            ...(media.transcodeId ? { 'X-Plex-Client-Identifier': media.transcodeId } : {}),
            ...(req.headers.range ? { Range: req.headers.range } : {}),
          },
        }));
      if (!(await validGrant(grant))) {
        abort.abort();
        void response.body?.cancel().catch(() => {});
        return json(res, 403, { error: 'Viewing access was revoked' });
      }
      const type = response.headers.get('content-type') || 'application/octet-stream';
      if (req.method !== 'HEAD' && (new URL(target).pathname.endsWith('.m3u8') || /mpegurl/i.test(type))) {
        const text = await response.text().finally(() => clearTimeout(timer));
        if (text.length > 2e6) throw new Error('Manifest too large');
        if (!(await validGrant(grant))) {
          abort.abort();
          void response.body?.cancel().catch(() => {});
          return json(res, 403, { error: 'Viewing access was revoked' });
        }
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(rewriteManifest(text, target, media, grant.id));
      }
      clearTimeout(timer);
      const headers = { 'Content-Type': type };
      for (const name of ['content-length', 'content-range', 'accept-ranges'])
        if (response.headers.has(name)) headers[name] = response.headers.get(name);
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD') return res.end();
      const check = setInterval(async () => {
        try {
          if (!(await validGrant(grant))) abort.abort();
        } catch {
          abort.abort();
        }
      }, 2000);
      try {
        await pipeline(Readable.fromWeb(response.body), res);
      } finally {
        clearInterval(check);
      }
    } catch (error) {
      if (!res.headersSent)
        json(
          res,
          media.transcodeId &&
            ([404, 410].includes(error.status) || (media.hlsLease && [401, 403].includes(error.status)))
            ? 410
            : 502,
          { error: 'Plex playback failed; try a different quality or check server access' },
        );
      else res.destroy();
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
    }
  }
  return { stream, rewriteManifest };
}
module.exports = { mediaStream };
