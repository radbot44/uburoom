'use strict';
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomBytes } = require('node:crypto');
const { PlaybackError } = require('../../errors');
const { CHUNK, AUDIO_LEAD, AUDIO_MIME } = require('../../av1');
const Playback = require('../../../shared/playback-policy.mjs');
const Subtitles = require('../../subtitles');
const SubtitleResources = require('../../subtitle-resources');

/** The media proxy: manifests, chunks, captions and subtitles served to a holder of a grant. */
function mediaStream({ config, watch, json, grants, validCaptionGrant, validGrant }) {
  function resource(media, url) {
    const target = (media.hlsProvider || media.provider).url(url).href;
    for (const [key, value] of media.resources) if (value === target) return key;
    if (media.resources.size > 20000) throw new Error('Too many media resources');
    const key = randomBytes(12).toString('hex');
    media.resources.set(key, target);
    return key;
  }
  function rewriteManifest(text, upstream, media, grantId) {
    const resolve = value => {
      if (media.directHls) {
        const source = media.provider.url(new URL(value, upstream).href);
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
  function bindGrantAbort(res, grant) {
    const controller = new AbortController();
    let clientClosed = false;
    const onClientClose = () => {
      clientClosed = true;
      controller.abort();
    };
    const onGrantAbort = () => controller.abort();
    res.on('close', onClientClose);
    if (grant.abort?.signal.aborted) controller.abort();
    else grant.abort?.signal.addEventListener('abort', onGrantAbort, { once: true });
    return {
      signal: controller.signal,
      clientClosed: () => clientClosed,
      cleanup: () => {
        res.off('close', onClientClose);
        grant.abort?.signal.removeEventListener('abort', onGrantAbort);
      },
    };
  }
  async function stream(req, res, grant, key, url) {
    if (key.startsWith('subtitle-')) {
      const match = /^subtitle-([a-f0-9-]{36})(?:\/(data|index|window|font-\d{1,2}))?$/.exec(key);
      if (!match || !(await validCaptionGrant(grant, match[1])))
        return json(res, 403, { error: 'Subtitle selection changed or access expired.' });
      const currentMedia = () => grant.room.viewers.get(grant.viewerId)?.media;
      const scope = bindGrantAbort(res, grant);
      try {
        const media = currentMedia();
        const windowed =
          ['pgs', 'cues'].includes(media?.selection?.subtitle?.delivery) && !media?.selection?.subtitle?.external;
        if (!match[2] && windowed) {
          if (scope.signal.aborted || !(await validCaptionGrant(grant, match[1])))
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
          if (scope.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          const atMs = url?.searchParams?.has('atMs') ? Number(url.searchParams.get('atMs')) : 0;
          const beforeMs = url?.searchParams?.has('beforeMs') ? Number(url.searchParams.get('beforeMs')) : 15000;
          const afterMs = url?.searchParams?.has('afterMs') ? Number(url.searchParams.get('afterMs')) : 60000;
          const win = await SubtitleResources.window(watch.pipeline.av1, media, {
            atMs,
            beforeMs,
            afterMs,
            signal: scope.signal,
          });
          if (scope.signal.aborted || !(await validCaptionGrant(grant, match[1])))
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
          if (scope.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          req.setTimeout?.(0);
          res.setTimeout?.(0);
          await SubtitleResources.pipe(watch.pipeline.av1, media, req, res, scope.signal);
          return;
        }
        const result = await SubtitleResources.load(watch.pipeline.av1, media, scope.signal);
        if (scope.signal.aborted || !(await validCaptionGrant(grant, match[1])))
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
        if (!res.headersSent && !res.destroyed) {
          if (grant.abort?.signal.aborted && !scope.clientClosed())
            json(res, 403, { error: 'Subtitle selection changed or access expired.' });
          else
            json(res, 503, {
              error: error instanceof PlaybackError ? error.message : 'Subtitles could not load. Try burn-in.',
            });
        } else if (!res.destroyed) res.destroy();
      } finally {
        scope.cleanup();
      }
      return;
    }
    if (key.startsWith('captions-')) {
      const match = /^captions-([a-f0-9-]{36})$/.exec(key);
      if (!match || !(await validCaptionGrant(grant, match[1])))
        return json(res, 403, { error: 'Subtitle selection changed or access expired.' });
      const scope = bindGrantAbort(res, grant);
      try {
        const media = grant.room.viewers.get(grant.viewerId)?.media;
        const cues = await Subtitles.load(media, scope.signal);
        if (scope.signal.aborted || !(await validCaptionGrant(grant, match[1])))
          return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
        json(res, 200, { cues });
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          if (grant.abort?.signal.aborted && !scope.clientClosed())
            json(res, 403, { error: 'Subtitle selection changed or access expired.' });
          else json(res, 503, { error: error instanceof PlaybackError ? error.message : 'Subtitles could not load.' });
        } else if (!res.destroyed) res.destroy();
      } finally {
        scope.cleanup();
      }
      return;
    }
    if (!(await validGrant(grant))) return json(res, 403, { error: 'Viewing access expired or was revoked' });
    const media = grant.media;
    if (media.bootstrapFallback) return json(res, 409, { error: 'Your selected quality is still preparing.' });
    // A direct output never serves video through this process, even if a client
    // tries a stale or manually constructed resource URL. Its start is text only.
    if (media.directHls && key === 'start' && !media.initialManifest)
      return json(res, 409, { error: 'Direct playlist unavailable' });
    if (media.directHls && key !== 'start') return json(res, 409, { error: 'Use the direct media route' });
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
      const scope = bindGrantAbort(res, grant);
      try {
        const background = req.headers['x-uburoom-prefetch'] === '1';
        const chunk = await watch.pipeline.av1.chunk(media.av1Lease, index, scope.signal, {
            urgent: !background && Math.abs(index - Math.floor(watch.position(grant.room) / CHUNK)) <= 1,
            background,
          }),
          bytes = chunk[match[1]];
        if (scope.signal.aborted || !(await validGrant(grant))) {
          if (!scope.clientClosed() && !res.headersSent && !res.destroyed)
            return json(res, 403, { error: 'Viewing access expired or was revoked' });
          if (!res.destroyed) res.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': bytes.length });
        if (req.method === 'HEAD') res.end();
        else await pipeline(Readable.from([bytes]), res);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          if (grant.abort?.signal.aborted && !scope.clientClosed())
            json(res, 403, { error: 'Viewing access expired or was revoked' });
          else
            json(res, 503, { error: error instanceof PlaybackError ? error.message : 'Local video conversion failed' });
        } else if (!res.destroyed) res.destroy();
      } finally {
        scope.cleanup();
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
      const onGrantAbort = () => source.destroy();
      if (grant.abort?.signal.aborted) source.destroy();
      else grant.abort?.signal.addEventListener('abort', onGrantAbort, { once: true });
      try {
        await pipeline(source, res);
      } catch {
        if (!res.destroyed) res.destroy();
      } finally {
        grant.abort?.signal.removeEventListener('abort', onGrantAbort);
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
        return json(res, 409, { error: 'The playlist could not use the selected delivery route' });
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
    const onGrantAbort = () => abort.abort();
    res.on('close', disconnect);
    if (grant.abort?.signal.aborted) abort.abort();
    else grant.abort?.signal.addEventListener('abort', onGrantAbort, { once: true });
    try {
      // The grant's own source access is checked before cached or producer bytes.
      response =
        watch.pipeline.hlsPool.response(media.hlsLease, target, req.method, req.headers.range) ||
        (await (media.hlsProvider || media.provider).request(target, {
          method: req.method,
          signal: abort.signal,
          streaming: true,
          headers: {
            Accept: '*/*',
            ...(media.hlsProvider || media.provider).sessionHeaders?.(media),
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
      await pipeline(Readable.fromWeb(response.body), res, { signal: abort.signal });
    } catch (error) {
      if (!res.headersSent)
        json(
          res,
          grant.abort?.signal.aborted
            ? 403
            : media.transcodeId &&
                ([404, 410].includes(error.status) || (media.hlsLease && [401, 403].includes(error.status)))
              ? 410
              : 502,
          {
            error: grant.abort?.signal.aborted
              ? 'Viewing access was revoked'
              : 'Playback failed; try a different quality or check server access',
          },
        );
      else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
      grant.abort?.signal.removeEventListener('abort', onGrantAbort);
    }
  }
  return { stream, rewriteManifest };
}
module.exports = { mediaStream };
