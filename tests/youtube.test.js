'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const { parseYouTubeUrl, isAllowedThumbnailUrl } = require('../server/sources/youtube/urls');
const { parseIsoDuration, fetchVideos, fetchPlaylist, checkApiKey } = require('../server/sources/youtube/api');
const { YouTubeMedia, YOUTUBE_SERVER } = require('../server/sources/youtube/provider');
const { validateSources } = require('../server/sources');
const { loadConfig } = require('../server/config');
const { checkSources } = require('../scripts/doctor');
const subtitles = require('../server/subtitles');
const { fixture } = require('./helpers/account-app');

const VIDEO_BYTES = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
const VTT_TEXT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nSidecar caption line\n';
const SECRET_API_KEY = 'YT_SECRET_KEY_TEST_999';
const SECRET_SIDECAR_TOKEN = 'SIDECAR_SECRET_TOKEN_999';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function startStubSidecar(t, { token = '', failPrepareIds = new Set(), durationOffset = 0 } = {}) {
  const ready = new Set();
  const requests = [];
  const warmCalls = [];
  let preparePollCount = 0;

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) : {};

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            ytdlp: '2026.02.01',
            ffmpeg: true,
            cache: { files: ready.size, bytes: 0, maxBytes: 100000 },
          }),
        );
        return;
      }
      if (url.pathname === '/recent') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [...ready].map(id => ({
              id,
              status: 'ready',
              title: `Cached ${id}`,
              channelTitle: 'Cached Channel',
              duration: 42,
              size: VIDEO_BYTES.length,
              filename: `${id}.mp4`,
              container: 'mp4',
              videoCodec: 'h264',
              audioCodec: 'aac',
              mtimeMs: 1700000000000,
              thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            })),
          }),
        );
        return;
      }
      if (url.pathname === '/metadata' && req.method === 'POST') {
        if (String(body.url).includes('playlist?list=')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              kind: 'playlist',
              id: 'PLtest123',
              title: 'Sidecar Playlist',
              channelTitle: 'Playlist Owner',
              itemCount: 2,
              items: [
                {
                  id: 'dQw4w9WgXcQ',
                  title: 'Track One',
                  channelTitle: 'Chan One',
                  duration: 42,
                  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
                },
                {
                  id: 'jNQXAC9IVRw',
                  title: 'Track Two',
                  channelTitle: 'Jawed',
                  duration: 19,
                  thumbnailUrl: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
                },
              ],
            }),
          );
          return;
        }
        const match = /v=([A-Za-z0-9_-]{11})/.exec(String(body.url || ''));
        const vid = match ? match[1] : 'dQw4w9WgXcQ';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            kind: 'video',
            video: {
              id: vid,
              title: `Video ${vid}`,
              channelTitle: 'Demo Creator',
              duration: 42,
              thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            },
          }),
        );
        return;
      }
      if (url.pathname === '/warm' && req.method === 'POST') {
        warmCalls.push(body.items || []);
        for (const item of body.items || []) ready.add(item.id);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queued: (body.items || []).map(x => x.id) }));
        return;
      }
      if (url.pathname === '/prepare' && req.method === 'POST') {
        const id = body.id;
        if (failPrepareIds.has(id)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, status: 'failed', error: 'Video blocked' }));
          return;
        }
        if (!ready.has(id)) {
          preparePollCount++;
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, status: 'preparing' }));
          setTimeout(() => ready.add(id), 40).unref?.();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            status: 'ready',
            title: `Video ${id}`,
            channelTitle: 'Demo Creator',
            duration: 42 + durationOffset,
            size: VIDEO_BYTES.length,
            filename: `${id}.mp4`,
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            width: 1280,
            height: 720,
            mtimeMs: 1700000000000,
            thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            subtitles: [{ id: 'en', language: 'en', label: 'EN', format: 'vtt' }],
          }),
        );
        return;
      }
      if (url.pathname.startsWith('/status/')) {
        const id = decodeURIComponent(url.pathname.slice('/status/'.length));
        if (!ready.has(id)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, status: 'preparing' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            status: 'ready',
            title: `Video ${id}`,
            channelTitle: 'Demo Creator',
            duration: 42 + durationOffset,
            size: VIDEO_BYTES.length,
            filename: `${id}.mp4`,
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            width: 1280,
            height: 720,
            mtimeMs: 1700000000000,
            thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            subtitles: [{ id: 'en', language: 'en', label: 'EN', format: 'vtt' }],
          }),
        );
        return;
      }
      if (url.pathname.startsWith('/files/')) {
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          const start = Number(m[1]);
          const end = m[2] ? Math.min(VIDEO_BYTES.length - 1, Number(m[2])) : VIDEO_BYTES.length - 1;
          const slice = VIDEO_BYTES.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${VIDEO_BYTES.length}`,
            'Accept-Ranges': 'bytes',
          });
          res.end(req.method === 'HEAD' ? undefined : slice);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(VIDEO_BYTES.length),
          'Accept-Ranges': 'bytes',
        });
        res.end(req.method === 'HEAD' ? undefined : VIDEO_BYTES);
        return;
      }
      if (url.pathname.startsWith('/subtitles/')) {
        res.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(VTT_TEXT)),
        });
        res.end(req.method === 'HEAD' ? undefined : VTT_TEXT);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => srv.close());
  const port = srv.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    warmCalls,
    getPreparePolls: () => preparePollCount,
    markReady: id => ready.add(id),
  };
}

function makeYoutubeFetch({ apiKey = SECRET_API_KEY, rejectKey = false, nonEmbeddableIds = new Set() } = {}) {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'www.googleapis.com') {
      if (rejectKey || url.searchParams.get('key') !== apiKey) {
        return jsonResponse({ error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 403);
      }
      if (url.pathname.endsWith('/videos')) {
        const ids = (url.searchParams.get('id') || '').split(',').filter(Boolean);
        return jsonResponse({
          items: ids.map(id => ({
            id,
            snippet: {
              title: `API Title ${id}`,
              channelTitle: 'API Channel',
              publishedAt: '2024-03-01T00:00:00Z',
              thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
              liveBroadcastContent: 'none',
            },
            contentDetails: { duration: 'PT42S' },
            status: { embeddable: !nonEmbeddableIds.has(id), privacyStatus: 'public' },
          })),
        });
      }
      if (url.pathname.endsWith('/playlists')) {
        const id = url.searchParams.get('id');
        return jsonResponse({
          items: [
            {
              id,
              snippet: {
                title: 'API Playlist Title',
                channelTitle: 'Playlist Channel',
                thumbnails: { high: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' } },
              },
              contentDetails: { itemCount: 2 },
            },
          ],
        });
      }
      if (url.pathname.endsWith('/playlistItems')) {
        return jsonResponse({
          items: [{ contentDetails: { videoId: 'dQw4w9WgXcQ' } }, { contentDetails: { videoId: 'jNQXAC9IVRw' } }],
        });
      }
    }
    if (url.hostname === 'i.ytimg.com') {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return new Response(pngHeader, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    return fetch(input, init);
  };
}

test('parseYouTubeUrl and isAllowedThumbnailUrl accept valid YouTube URLs and reject SSRF/non-YouTube inputs', () => {
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), {
    kind: 'video',
    videoId: 'dQw4w9WgXcQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  assert.deepEqual(parseYouTubeUrl('https://youtu.be/jNQXAC9IVRw?t=5'), {
    kind: 'video',
    videoId: 'jNQXAC9IVRw',
    canonicalUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  });
  assert.deepEqual(parseYouTubeUrl('m.youtube.com/shorts/abcdefghijk'), {
    kind: 'video',
    videoId: 'abcdefghijk',
    canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123'), {
    kind: 'video',
    videoId: 'dQw4w9WgXcQ',
    playlistId: 'PLtest123',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/playlist?list=PLtest123'), {
    kind: 'playlist',
    playlistId: 'PLtest123',
    canonicalUrl: 'https://www.youtube.com/playlist?list=PLtest123',
  });

  for (const bad of [
    '',
    'https://vimeo.com/123456',
    'http://127.0.0.1:8780/health',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://www.youtube.com/@handle',
    'https://www.youtube.com/watch?v=short',
  ]) {
    assert.throws(() => parseYouTubeUrl(bad), { status: 400 });
  }

  assert.equal(isAllowedThumbnailUrl('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'), true);
  assert.equal(isAllowedThumbnailUrl('https://yt3.ggpht.com/avatar'), true);
  assert.equal(isAllowedThumbnailUrl('http://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'), false);
  assert.equal(isAllowedThumbnailUrl('https://user@i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'), false);
  assert.equal(isAllowedThumbnailUrl('https://evil.invalid/pic.jpg'), false);
});

test('validateSources enforces YouTube sidecar/embed requirements and single-source limit', () => {
  const sidecarOnly = validateSources([
    { id: 'youtube', type: 'youtube', delivery: 'sidecar', sidecar_url: 'http://127.0.0.1:8780/' },
  ]);
  assert.equal(sidecarOnly[0].delivery, 'sidecar');
  assert.equal(sidecarOnly[0].sidecarUrl, 'http://127.0.0.1:8780');
  assert.equal(sidecarOnly[0].apiKey, '');

  const embedOk = validateSources([{ id: 'yt', type: 'youtube', delivery: 'embed', api_key: 'AIza123' }]);
  assert.equal(embedOk[0].delivery, 'embed');
  assert.equal(embedOk[0].apiKey, 'AIza123');

  assert.throws(() => validateSources([{ id: 'yt', type: 'youtube', delivery: 'sidecar' }]), /sidecar_url is required/);
  assert.throws(() => validateSources([{ id: 'yt', type: 'youtube', delivery: 'embed' }]), /api_key is required/);
  assert.throws(
    () => validateSources([{ id: 'yt', type: 'youtube', sidecar_url: 'http://user:pass@127.0.0.1:8780' }]),
    /without credentials/,
  );
  assert.throws(
    () =>
      validateSources([
        { id: 'yt1', type: 'youtube', sidecar_url: 'http://127.0.0.1:8780' },
        { id: 'yt2', type: 'youtube', sidecar_url: 'http://127.0.0.1:8781' },
      ]),
    /Only one youtube source/,
  );
});

test('YouTube Data API helper parses durations, batches video calls, and hides API keys on failure', async () => {
  assert.equal(parseIsoDuration('PT4M13S'), 253);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration(''), 0);

  let videoCalls = 0;
  const fetcher = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith('/videos')) videoCalls++;
    return makeYoutubeFetch()(input, init);
  };
  const manyIds = Array.from({ length: 52 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  const result = await fetchVideos(manyIds, { apiKey: SECRET_API_KEY, fetch: fetcher });
  assert.equal(videoCalls, 2);
  assert.equal(result.size, 52);

  const pl = await fetchPlaylist('PLtest123', { apiKey: SECRET_API_KEY, fetch: makeYoutubeFetch() });
  assert.equal(pl.title, 'API Playlist Title');
  assert.deepEqual(
    pl.items.map(i => i.id),
    ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
  );

  await assert.rejects(
    () => checkApiKey({ apiKey: SECRET_API_KEY, fetch: makeYoutubeFetch({ rejectKey: true }) }),
    err => {
      assert.equal(err.message.includes(SECRET_API_KEY), false);
      assert.match(err.message, /rejected/i);
      return true;
    },
  );
});

test('YouTubeMedia prepares sidecar downloads, enforces cache_directory containment, loads VTT subtitles, and refuses embed delivery', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-yt-cache-'));
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-yt-outside-'));
  t.after(() =>
    Promise.all([fsp.rm(dir, { recursive: true, force: true }), fsp.rm(outsideDir, { recursive: true, force: true })]),
  );

  const sidecar = await startStubSidecar(t, { token: SECRET_SIDECAR_TOKEN, durationOffset: 0.75 });
  const provider = new YouTubeMedia({
    delivery: 'sidecar',
    sidecarUrl: sidecar.baseUrl,
    sidecarToken: SECRET_SIDECAR_TOKEN,
    cacheDirectory: dir,
    pipeline: { release: async () => {} },
    fetch: makeYoutubeFetch(),
  });

  // Sidecar-only resolve (no Data API key needed).
  const resolved = await provider.resolveUrl('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(resolved.kind, 'video');
  assert.equal(resolved.item.id, 'dQw4w9WgXcQ');
  assert.equal(resolved.item.type, 'movie');
  assert.equal(resolved.item.duration, 42);

  // Prepare triggers /prepare + /status poll until ready, with tolerant duration margin.
  const { media } = await provider.source('dQw4w9WgXcQ', undefined, { subtitleId: 'x0', browserSubtitles: true });
  assert.equal(media.durationTolerance, 2);
  assert.equal(media.tracks.subtitles.length, 1);
  assert.equal(media.tracks.subtitles[0].delivery, 'text');
  assert.ok(sidecar.getPreparePolls() >= 1);

  // Without local file yet, request falls back to HTTP sidecar with Range header.
  assert.equal(await provider.filePath(media), undefined);
  const httpRangeRes = await provider.request(media.sourceStart, { headers: { Range: 'bytes=2-7' } });
  assert.equal(httpRangeRes.status, 206);
  assert.equal(await httpRangeRes.text(), '234567');

  // With a safe regular file in cacheDirectory, filePath() resolves and reads directly from disk.
  const localFile = path.join(dir, 'dQw4w9WgXcQ.mp4');
  await fsp.writeFile(localFile, Buffer.from('LOCALDISK0123456789'));
  assert.equal(await provider.filePath(media), path.resolve(localFile));
  const diskRes = await provider.request(media.sourceStart, { headers: { Range: 'bytes=5-8' } });
  assert.equal(diskRes.status, 206);
  assert.equal(await diskRes.text(), 'DISK');

  // Path traversal and symlinks in cacheDirectory are refused by filePath().
  await fsp.writeFile(path.join(outsideDir, 'secret.mp4'), 'OUTSIDE');
  assert.equal(await provider.filePath({ filename: '../secret.mp4' }), undefined);
  const linkPath = path.join(dir, 'LINK0000001.mp4');
  let symlinkCreated = false;
  try {
    await fsp.symlink(path.join(outsideDir, 'secret.mp4'), linkPath);
    symlinkCreated = true;
  } catch {
    /* Windows without developer mode may disallow file symlinks. */
  }
  if (symlinkCreated) {
    assert.equal(await provider.filePath({ filename: 'LINK0000001.mp4' }), undefined);
  }

  // WebVTT subtitle loading via server/subtitles.js
  const cues = await subtitles.load(media, new AbortController().signal);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Sidecar caption line');

  // Artwork proxy returns verified image bytes.
  const art = await provider.artwork('dQw4w9WgXcQ');
  assert.equal(art.type, 'image/png');
  assert.equal(art.bytes.subarray(1, 4).toString(), 'PNG');

  // Embed delivery validates metadata (and checks embeddable) and refuses playback truthfully until Stage 3.
  const embedProvider = new YouTubeMedia({
    delivery: 'embed',
    apiKey: SECRET_API_KEY,
    pipeline: { release: async () => {} },
    fetch: makeYoutubeFetch({ nonEmbeddableIds: new Set(['NOEMBED1234']) }),
  });
  await assert.rejects(() => embedProvider.resolveUrl('https://youtu.be/NOEMBED1234'), { status: 400 });
  await assert.rejects(() => embedProvider.source('dQw4w9WgXcQ'), { status: 501 });
});

test('library.resolve, playlist bulk queue, warmQueue, and operator Source Settings round-trip cleanly without leaking secrets', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-yt-app-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.yaml');
  const sidecar = await startStubSidecar(t, { token: SECRET_SIDECAR_TOKEN, durationOffset: 0.75 });
  const initialConfig = {
    access: { password: true },
    secrets: { server_password: 'fixture-private-password' },
    operator: { identities: ['discord:100000000000000001'] },
    discord: {
      client_id: '100000000000000010',
      client_secret: 'fixture-private-client-secret',
      owner_id: '100000000000000001',
    },
    sources: [
      {
        id: 'youtube',
        type: 'youtube',
        name: 'YouTube',
        delivery: 'sidecar',
        sidecar_url: sidecar.baseUrl,
        sidecar_token: SECRET_SIDECAR_TOKEN,
        api_key: SECRET_API_KEY,
      },
    ],
  };
  await fsp.writeFile(configFile, YAML.stringify(initialConfig), 'utf8');

  const f = await fixture(
    t,
    undefined,
    {
      ...loadConfig(configFile),
      accountFile: undefined,
      credentialKeyFile: undefined,
      guildId: 'guild',
      channels: ['commands'],
    },
    { youtubeFetch: makeYoutubeFetch() },
  );

  // Unauthenticated client cannot resolve links.
  const anon = f.browser();
  const unauthRes = await anon.request(
    '/api/watch/library/resolve?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'),
  );
  assert.ok([401, 403].includes(unauthRes.status));

  // Authenticated viewer can list YouTube home card, resolve links & playlists, and queue bulk playlist.
  const host = f.browser();
  await host.discord('host');

  const home = await host.request('/api/watch/library');
  assert.equal(home.status, 200);
  const ytCard = home.body.items.find(s => s.serverId === YOUTUBE_SERVER);
  assert.equal(ytCard.source, 'link');
  assert.equal(ytCard.serverKind, 'youtube');

  const resolvedVideo = await host.request(
    '/api/watch/library/resolve?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'),
  );
  assert.equal(resolvedVideo.status, 200);
  assert.equal(resolvedVideo.body.item.serverId, YOUTUBE_SERVER);
  assert.doesNotMatch(JSON.stringify(resolvedVideo.body), new RegExp(`${SECRET_API_KEY}|${SECRET_SIDECAR_TOKEN}`));

  const resolvedPlaylist = await host.request(
    '/api/watch/library/resolve?server=youtube&url=' +
      encodeURIComponent('https://www.youtube.com/playlist?list=PLtest123'),
  );
  assert.equal(resolvedPlaylist.status, 200);
  assert.equal(resolvedPlaylist.body.kind, 'playlist');
  assert.equal(resolvedPlaylist.body.items.length, 2);

  // Create a room, join as viewer, and bulk-queue the YouTube playlist; verify /warm and 0.75s duration tolerance.
  const created = await host.post('/api/watch/rooms', { name: 'YouTube Room' });
  assert.equal(created.status, 201);
  const roomId = created.body.id;

  const viewerId = randomUUID();
  const initialState = (await host.request(`/api/watch/rooms/${roomId}?viewer=${viewerId}&quality=direct`)).body;
  const bulkRes = await host.post(`/api/watch/rooms/${roomId}/command`, {
    viewerId,
    epoch: initialState.epoch,
    expiresAt: Date.now() + 2500,
    command: {
      action: 'queue.bulk',
      args: {
        type: 'playlist',
        mediaId: 'PLtest123',
        serverId: YOUTUBE_SERVER,
        unfinished: false,
        includeSpecials: false,
      },
    },
  });
  assert.equal(bulkRes.status, 200);
  assert.equal(bulkRes.body.status, 'applied', bulkRes.body.message);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(sidecar.warmCalls.length >= 1);

  // Verify room playback transition accepted the 0.75s difference between API duration (42s) and sidecar probe (42.75s).
  const loadedState = (await host.request(`/api/watch/rooms/${roomId}?viewer=${viewerId}&quality=direct`)).body;
  assert.equal(loadedState.title, 'Video dQw4w9WgXcQ');
  assert.ok(loadedState.mediaUrl, 'viewer receives media stream URL');
  assert.ok(Math.abs(loadedState.state.duration - 42.75) < 0.01);

  const streamRange = await host.request(loadedState.mediaUrl, undefined, { Range: 'bytes=0-7' });
  assert.equal(streamRange.status, 206);
  assert.equal(streamRange.body, '01234567');

  const cachedBrowse = await host.request('/api/watch/library?server=youtube&section=youtube&q=Cached');
  assert.equal(cachedBrowse.status, 200);
  assert.equal(cachedBrowse.body.source, 'link');
  assert.ok(cachedBrowse.body.items.some(i => i.id === 'dQw4w9WgXcQ'));

  // Verify doctor source checks recognize configured YouTube source shape.
  const youtubeModule = require('../server/sources/youtube');
  const ytChecks = await youtubeModule.check(
    validateSources([
      { id: 'youtube', type: 'youtube', sidecar_url: sidecar.baseUrl, sidecar_token: SECRET_SIDECAR_TOKEN },
    ])[0],
    { youtubeFetch: makeYoutubeFetch() },
  );
  assert.equal(ytChecks[0].category, 'Sources');
  assert.equal(ytChecks[0].status, 'pass');
  assert.equal(typeof checkSources, 'function');

  // Operator Sources API never exposes secrets and preserves untouched secrets on edit.
  const list1 = await host.request('/api/operator/sources');
  assert.equal(list1.status, 200);
  assert.doesNotMatch(JSON.stringify(list1.body), new RegExp(`${SECRET_API_KEY}|${SECRET_SIDECAR_TOKEN}`));
  const ytSummary = list1.body.sources.find(s => s.id === 'youtube');
  assert.equal(ytSummary.hasApiKey, true);
  assert.equal(ytSummary.hasSidecarToken, true);

  const edited = await host.post('/api/operator/sources', {
    revision: list1.body.revision,
    action: 'update',
    id: 'youtube',
    name: 'Room YouTube',
    settings: { delivery: 'sidecar', sidecarUrl: sidecar.baseUrl },
  });
  assert.equal(edited.status, 200);
  assert.doesNotMatch(JSON.stringify(edited.body), new RegExp(`${SECRET_API_KEY}|${SECRET_SIDECAR_TOKEN}`));
  const onDisk1 = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(onDisk1.sources[0].name, 'Room YouTube');
  assert.equal(onDisk1.sources[0].api_key, SECRET_API_KEY);
  assert.equal(onDisk1.sources[0].sidecar_token, SECRET_SIDECAR_TOKEN);

  // Explicit clear removes saved API key without losing sidecar_token.
  const cleared = await host.post('/api/operator/sources', {
    revision: edited.body.revision,
    action: 'update',
    id: 'youtube',
    name: 'Room YouTube',
    settings: { delivery: 'sidecar', sidecarUrl: sidecar.baseUrl, clearApiKey: true },
  });
  assert.equal(cleared.status, 200);
  const onDisk2 = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(onDisk2.sources[0].api_key, undefined);
  assert.equal(onDisk2.sources[0].sidecar_token, SECRET_SIDECAR_TOKEN);

  // Operator setup flow can remove and re-add YouTube through `/api/operator/sources/setup`.
  const removed = await host.post('/api/operator/sources', {
    revision: cleared.body.revision,
    action: 'remove',
    id: 'youtube',
  });
  assert.equal(removed.status, 200);
  const opened = await host.post('/api/operator/sources/setup', { type: 'youtube' });
  assert.equal(opened.status, 200);
  const configured = await host.post('/api/operator/sources/setup/step', {
    flow: opened.body.flow,
    step: 'configure',
    delivery: 'sidecar',
    sidecarUrl: sidecar.baseUrl,
    sidecarToken: SECRET_SIDECAR_TOKEN,
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.ready, true);
  assert.doesNotMatch(JSON.stringify(configured.body), new RegExp(SECRET_SIDECAR_TOKEN));
  const readded = await host.post('/api/operator/sources', {
    revision: removed.body.revision,
    action: 'add',
    flow: opened.body.flow,
    name: 'Fresh YouTube',
    libraries: [],
  });
  assert.equal(readded.status, 200);
  assert.equal(YAML.parse(fs.readFileSync(configFile, 'utf8')).sources[0].sidecar_token, SECRET_SIDECAR_TOKEN);
});
