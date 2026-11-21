'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const { parseYouTubeUrl, isAllowedThumbnailUrl } = require('../server/sources/youtube/urls');
const { parseIsoDuration, fetchVideos, fetchPlaylist, checkApiKey } = require('../server/sources/youtube/api');
const { YouTubeCache, safeCacheFile, versionAtLeast } = require('../server/sources/youtube/ytdlp');
const { YouTubeMedia, YOUTUBE_SERVER } = require('../server/sources/youtube/provider');
const { validateSources } = require('../server/sources');
const { loadConfig } = require('../server/config');
const { checkSources } = require('../scripts/doctor');
const subtitles = require('../server/subtitles');
const { fixture } = require('./helpers/account-app');

const VIDEO_BYTES = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
const VTT_TEXT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nBuilt-in yt-dlp caption\n';
const SECRET_API_KEY = 'YT_SECRET_KEY_TEST_999';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeYoutubeRunner({
  failIds = new Set(),
  durationOffset = 0,
  delayMs = 15,
  missingYtDlp = false,
  version = '2026.02.01',
} = {}) {
  const calls = [];
  const downloads = [];

  const runner = async (bin, args, options = {}) => {
    calls.push({ bin, args: [...args], cwd: options.cwd });
    if (missingYtDlp) {
      throw Object.assign(new Error('yt-dlp not found'), { status: 500 });
    }
    if (bin.toLowerCase().includes('ffprobe')) {
      const targetFile = args[args.length - 1];
      const base = path.basename(targetFile, path.extname(targetFile));
      return {
        code: 0,
        stdout: JSON.stringify({
          format: { duration: String(42 + durationOffset) },
          streams: [
            { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
          file: base,
        }),
        stderr: '',
      };
    }

    if (args.includes('--version')) {
      return { code: 0, stdout: `${version}\n`, stderr: '' };
    }

    if (args.includes('--dump-single-json')) {
      const sep = args.indexOf('--');
      assert.ok(sep >= 0 && sep === args.length - 2, 'URL must follow -- separator');
      const url = args[sep + 1];
      if (url.includes('playlist?list=')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 'PLtest123',
            title: 'Builtin Playlist',
            channel: 'Playlist Owner',
            playlist_count: 3,
            thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }],
            entries: [
              { id: 'dQw4w9WgXcQ', title: 'Track One', uploader: 'Chan One', duration: 42 },
              { id: 'live1234567', title: 'Live Skip', is_live: true, duration: 0 },
              { id: 'jNQXAC9IVRw', title: 'Track Two', uploader: 'Jawed', duration: 19 },
            ],
          }),
          stderr: '',
        };
      }
      const vidMatch = /v=([A-Za-z0-9_-]{11})/.exec(url);
      const vid = vidMatch ? vidMatch[1] : 'dQw4w9WgXcQ';
      return {
        code: 0,
        stdout: JSON.stringify({
          id: vid,
          title: `Video ${vid}`,
          channel: 'Demo Creator',
          duration: 42,
          thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          upload_date: '20240301',
        }),
        stderr: '',
      };
    }

    if (args.includes('-o')) {
      const sep = args.indexOf('--');
      assert.ok(sep >= 0 && sep === args.length - 2, 'URL must follow -- separator');
      const url = args[sep + 1];
      const vidMatch = /v=([A-Za-z0-9_-]{11})/.exec(url);
      const vid = vidMatch ? vidMatch[1] : 'dQw4w9WgXcQ';
      downloads.push(vid);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (failIds.has(vid)) {
        return { code: 1, stdout: '', stderr: 'ERROR: Video unavailable\n' };
      }
      const stage = options.cwd;
      await fsp.writeFile(path.join(stage, `${vid}.mp4`), VIDEO_BYTES);
      await fsp.writeFile(path.join(stage, `${vid}.en.vtt`), VTT_TEXT, 'utf8');
      await fsp.writeFile(
        path.join(stage, `${vid}.info.json`),
        JSON.stringify({
          id: vid,
          title: `Video ${vid}`,
          channel: 'Demo Creator',
          duration: 42,
          thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          upload_date: '20240301',
        }),
        'utf8',
      );
      return { code: 0, stdout: '', stderr: '' };
    }

    return { code: 1, stdout: '', stderr: 'unexpected command' };
  };

  return { runner, calls, downloads };
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

test('validateSources enforces built-in ytdlp defaults, embed api_key, bounds, and single-source limit', () => {
  const ytdlpDefault = validateSources([{ id: 'youtube', type: 'youtube' }], {
    base: path.resolve('c:/tmp-base'),
    dataDirectory: path.resolve('c:/tmp-base/data'),
    platform: process.platform,
  });
  assert.equal(ytdlpDefault[0].delivery, 'ytdlp');
  assert.equal(ytdlpDefault[0].maxCacheGb, 20);
  assert.equal(ytdlpDefault[0].maxConcurrent, 2);
  assert.equal(ytdlpDefault[0].cacheDirectory, path.resolve('c:/tmp-base/data', 'youtube-cache'));
  assert.equal(ytdlpDefault[0].apiKey, '');

  const embedOk = validateSources([{ id: 'yt', type: 'youtube', delivery: 'embed', api_key: 'AIza123' }]);
  assert.equal(embedOk[0].delivery, 'embed');
  assert.equal(embedOk[0].apiKey, 'AIza123');

  assert.throws(
    () => validateSources([{ id: 'yt', type: 'youtube', sidecar_url: 'http://127.0.0.1:8780' }]),
    /unknown youtube setting/,
  );
  assert.throws(() => validateSources([{ id: 'yt', type: 'youtube', delivery: 'embed' }]), /api_key is required/);
  assert.throws(() => validateSources([{ id: 'yt', type: 'youtube', max_cache_gb: 0.01 }]), /max_cache_gb/);
  assert.throws(() => validateSources([{ id: 'yt', type: 'youtube', max_concurrent: 9 }]), /max_concurrent/);
  assert.throws(
    () => validateSources([{ id: 'yt', type: 'youtube', po_token_url: 'http://user:pass@127.0.0.1:4416' }]),
    /without credentials/,
  );
  assert.throws(
    () =>
      validateSources([
        { id: 'yt1', type: 'youtube' },
        { id: 'yt2', type: 'youtube' },
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

test('YouTubeCache coalesces downloads, probes media, evicts LRU items, and blocks traversal/symlinks', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-yt-lru-'));
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-yt-outside-'));
  t.after(() =>
    Promise.all([fsp.rm(dir, { recursive: true, force: true }), fsp.rm(outsideDir, { recursive: true, force: true })]),
  );

  const yt = makeYoutubeRunner({ delayMs: 25, durationOffset: 0.75 });
  // One cached entry (~122 bytes including VTT) fits in 180 bytes; two exceed 180 and evict LRU.
  const cache = new YouTubeCache({
    cacheDirectory: dir,
    maxCacheBytes: 180,
    maxConcurrent: 2,
    runCommand: yt.runner,
  });
  t.after(() => cache.close());

  const tools = await cache.checkTools();
  assert.equal(tools.ok, true);
  assert.equal(tools.ytdlp, '2026.02.01');

  // Coalesced concurrent prepare calls download once.
  const [r1, r2] = await Promise.all([cache.prepare('dQw4w9WgXcQ'), cache.prepare('dQw4w9WgXcQ')]);
  assert.equal(r1.filename, 'dQw4w9WgXcQ.mp4');
  assert.equal(r2.filename, 'dQw4w9WgXcQ.mp4');
  assert.equal(yt.downloads.filter(id => id === 'dQw4w9WgXcQ').length, 1);

  // Preparing a second video triggers LRU eviction of the first (including its .vtt and .meta.json).
  await cache.prepare('jNQXAC9IVRw');
  assert.equal(fs.existsSync(path.join(dir, 'dQw4w9WgXcQ.mp4')), false);
  assert.equal(fs.existsSync(path.join(dir, 'dQw4w9WgXcQ.en.vtt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'dQw4w9WgXcQ.meta.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'jNQXAC9IVRw.mp4')), true);

  // Path traversal and symlinks in cacheDirectory are refused.
  await fsp.writeFile(path.join(outsideDir, 'secret.mp4'), 'OUTSIDE');
  assert.equal(await safeCacheFile(dir, '../secret.mp4'), null);
  const linkPath = path.join(dir, 'LINK0000001.mp4');
  let symlinkCreated = false;
  try {
    await fsp.symlink(path.join(outsideDir, 'secret.mp4'), linkPath);
    symlinkCreated = true;
  } catch {
    /* Windows without developer mode may disallow file symlinks. */
  }
  if (symlinkCreated) {
    assert.equal(await safeCacheFile(dir, 'LINK0000001.mp4'), null);
  }
});

test('YouTubeMedia prepares disk downloads, serves Range & VTT subtitles, and refuses embed delivery', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-yt-media-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const logs = [];
  const testLogger = {
    info: (tag, msg) => logs.push({ level: 'info', tag, msg }),
    warn: (tag, msg) => logs.push({ level: 'warn', tag, msg }),
  };
  const yt = makeYoutubeRunner({ durationOffset: 0.75, failIds: new Set(['FAIL0000001']) });
  const provider = new YouTubeMedia({
    delivery: 'ytdlp',
    cacheDirectory: dir,
    pipeline: { release: async () => {} },
    fetch: makeYoutubeFetch(),
    runCommand: yt.runner,
    logger: testLogger,
  });
  t.after(() => provider.close());

  // Built-in ytdlp resolve works without Data API key and passes --js-runtimes for modern yt-dlp.
  const resolved = await provider.resolveUrl('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(resolved.kind, 'video');
  assert.equal(resolved.item.id, 'dQw4w9WgXcQ');
  assert.equal(resolved.item.type, 'movie');
  assert.equal(resolved.item.duration, 42);
  const metaCall = yt.calls.find(c => c.args.includes('--dump-single-json'));
  assert.ok(metaCall.args.includes('--js-runtimes'));
  assert.ok(metaCall.args.includes(`node:${process.execPath}`));

  // Playlist fallback via yt-dlp drops live entries.
  const pl = await provider.resolveUrl('https://www.youtube.com/playlist?list=PLtest123');
  assert.equal(pl.kind, 'playlist');
  assert.deepEqual(
    pl.items.map(i => i.id),
    ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
  );

  // Prepare populates disk cache, passes --js-runtimes, logs completion, and serves byte ranges & subtitles.
  const { media } = await provider.source('dQw4w9WgXcQ', undefined, { subtitleId: 'x0', browserSubtitles: true });
  const dlCall = yt.calls.find(c => c.args.includes('-o'));
  assert.ok(dlCall.args.includes('--js-runtimes'));
  assert.ok(dlCall.args.includes(`node:${process.execPath}`));
  assert.ok(logs.some(l => l.level === 'info' && l.tag === 'YouTube' && l.msg.includes('Cached dQw4w9WgXcQ')));

  // Failed download logs warning with details.
  await assert.rejects(() => provider.source('FAIL0000001'), { status: 502 });
  assert.ok(logs.some(l => l.level === 'warn' && l.tag === 'YouTube' && l.msg.includes('FAIL0000001')));

  // Older yt-dlp (< 2025.10.22) omits --js-runtimes and reports outdated warning in doctor check().
  assert.equal(versionAtLeast('2025.10.22', '2025.10.22'), true);
  assert.equal(versionAtLeast('2025.07.21', '2025.10.22'), false);
  const oldYt = makeYoutubeRunner({ version: '2025.07.21' });
  const oldCache = new YouTubeCache({ cacheDirectory: path.join(dir, 'old'), runCommand: oldYt.runner });
  t.after(() => oldCache.close());
  const oldTools = await oldCache.checkTools();
  assert.equal(oldTools.outdated, true);
  await oldCache.metadata('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(oldYt.calls.find(c => c.args.includes('--dump-single-json')).args.includes('--js-runtimes'), false);
  const oldChecks = await require('../server/sources/youtube').check(
    validateSources([{ id: 'youtube', type: 'youtube', cache_directory: path.join(dir, 'old') }])[0],
    { youtubeRunner: oldYt.runner },
  );
  assert.equal(oldChecks[0].status, 'warn');
  assert.match(oldChecks[0].message, /outdated/i);
  assert.equal(media.durationTolerance, 2);
  assert.equal(media.tracks.subtitles.length, 1);
  assert.equal(media.tracks.subtitles[0].delivery, 'text');
  assert.equal(await provider.filePath(media), path.resolve(dir, 'dQw4w9WgXcQ.mp4'));

  const diskRangeRes = await provider.request(media.sourceStart, { headers: { Range: 'bytes=2-7' } });
  assert.equal(diskRangeRes.status, 206);
  assert.equal(await diskRangeRes.text(), '234567');

  await assert.rejects(() => provider.request(media.sourceStart, { headers: { Range: 'bytes=999-1000' } }), {
    status: 416,
  });

  const cues = await subtitles.load(media, new AbortController().signal);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Built-in yt-dlp caption');

  const art = await provider.artwork('dQw4w9WgXcQ');
  assert.equal(art.type, 'image/png');
  assert.equal(art.bytes.subarray(1, 4).toString(), 'PNG');

  // Embed delivery validates metadata (and embeddable flag) and refuses playback truthfully until Stage 3.
  const embedProvider = new YouTubeMedia({
    delivery: 'embed',
    apiKey: SECRET_API_KEY,
    pipeline: { release: async () => {} },
    fetch: makeYoutubeFetch({ nonEmbeddableIds: new Set(['NOEMBED1234']) }),
  });
  await assert.rejects(() => embedProvider.resolveUrl('https://youtu.be/NOEMBED1234'), { status: 400 });
  await assert.rejects(() => embedProvider.source('dQw4w9WgXcQ'), { status: 501 });
});

test('library.resolve, playlist bulk queue, warmQueue, streaming, and Source Settings work without leaking secrets', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-yt-app-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.yaml');
  const yt = makeYoutubeRunner({ durationOffset: 0.75 });
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
        delivery: 'ytdlp',
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
    { youtubeFetch: makeYoutubeFetch(), youtubeRunner: yt.runner },
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
  assert.doesNotMatch(JSON.stringify(resolvedVideo.body), new RegExp(SECRET_API_KEY));

  const resolvedPlaylist = await host.request(
    '/api/watch/library/resolve?server=youtube&url=' +
      encodeURIComponent('https://www.youtube.com/playlist?list=PLtest123'),
  );
  assert.equal(resolvedPlaylist.status, 200);
  assert.equal(resolvedPlaylist.body.kind, 'playlist');
  assert.equal(resolvedPlaylist.body.items.length, 2);

  // Create a room, join with direct quality, and bulk-queue playlist; verify warmQueue and HTTP Range streaming.
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
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(yt.downloads.includes('dQw4w9WgXcQ'));
  assert.ok(yt.downloads.includes('jNQXAC9IVRw'), 'warmQueue pre-warmed queued next video onto disk');

  const loadedState = (await host.request(`/api/watch/rooms/${roomId}?viewer=${viewerId}&quality=direct`)).body;
  assert.equal(loadedState.title, 'Video dQw4w9WgXcQ');
  assert.ok(loadedState.mediaUrl, 'viewer receives media stream URL');
  assert.ok(Math.abs(loadedState.state.duration - 42.75) < 0.01);

  const streamRange = await host.request(loadedState.mediaUrl, undefined, { Range: 'bytes=0-7' });
  assert.equal(streamRange.status, 206);
  assert.equal(streamRange.body, '01234567');

  const cachedBrowse = await host.request('/api/watch/library?server=youtube&section=youtube&q=Video');
  assert.equal(cachedBrowse.status, 200);
  assert.equal(cachedBrowse.body.source, 'link');
  assert.ok(cachedBrowse.body.items.some(i => i.id === 'dQw4w9WgXcQ'));

  // Verify doctor checks recognize configured YouTube source shape.
  const youtubeModule = require('../server/sources/youtube');
  const ytChecks = await youtubeModule.check(
    validateSources([{ id: 'youtube', type: 'youtube' }], {
      base: dir,
      dataDirectory: path.join(dir, 'data'),
    })[0],
    { youtubeFetch: makeYoutubeFetch(), youtubeRunner: yt.runner },
  );
  assert.equal(ytChecks[0].category, 'Sources');
  assert.equal(ytChecks[0].status, 'pass');
  assert.equal(typeof checkSources, 'function');

  // Operator Sources API never exposes API key and preserves untouched key on edit.
  const list1 = await host.request('/api/operator/sources');
  assert.equal(list1.status, 200);
  assert.doesNotMatch(JSON.stringify(list1.body), new RegExp(SECRET_API_KEY));
  const ytSummary = list1.body.sources.find(s => s.id === 'youtube');
  assert.equal(ytSummary.delivery, 'ytdlp');
  assert.equal(ytSummary.hasApiKey, true);

  const edited = await host.post('/api/operator/sources', {
    revision: list1.body.revision,
    action: 'update',
    id: 'youtube',
    name: 'Room YouTube',
    settings: { delivery: 'ytdlp', maxCacheGb: 30 },
  });
  assert.equal(edited.status, 200);
  assert.doesNotMatch(JSON.stringify(edited.body), new RegExp(SECRET_API_KEY));
  const onDisk1 = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(onDisk1.sources[0].name, 'Room YouTube');
  assert.equal(onDisk1.sources[0].max_cache_gb, 30);
  assert.equal(onDisk1.sources[0].api_key, SECRET_API_KEY);

  // Explicit clear removes saved API key.
  const cleared = await host.post('/api/operator/sources', {
    revision: edited.body.revision,
    action: 'update',
    id: 'youtube',
    name: 'Room YouTube',
    settings: { delivery: 'ytdlp', maxCacheGb: 20, clearApiKey: true },
  });
  assert.equal(cleared.status, 200);
  const onDisk2 = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(onDisk2.sources[0].api_key, undefined);
  assert.equal(onDisk2.sources[0].max_cache_gb, undefined);

  // Operator setup flow probes tools, configures built-in yt-dlp cache, and re-adds source cleanly.
  const removed = await host.post('/api/operator/sources', {
    revision: cleared.body.revision,
    action: 'remove',
    id: 'youtube',
  });
  assert.equal(removed.status, 200);
  const opened = await host.post('/api/operator/sources/setup', { type: 'youtube' });
  assert.equal(opened.status, 200);

  const probed = await host.post('/api/operator/sources/setup/step', {
    flow: opened.body.flow,
    step: 'probe',
  });
  assert.equal(probed.status, 200);
  assert.equal(probed.body.ok, true);
  assert.equal(probed.body.ytdlp, '2026.02.01');

  const configured = await host.post('/api/operator/sources/setup/step', {
    flow: opened.body.flow,
    step: 'configure',
    delivery: 'ytdlp',
    maxCacheGb: 15,
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.ready, true);

  const readded = await host.post('/api/operator/sources', {
    revision: removed.body.revision,
    action: 'add',
    flow: opened.body.flow,
    name: 'Built-in YouTube',
    libraries: [],
  });
  assert.equal(readded.status, 200);
  const onDisk3 = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(onDisk3.sources[0], {
    id: 'built-in-youtube',
    type: 'youtube',
    name: 'Built-in YouTube',
    delivery: 'ytdlp',
    max_cache_gb: 15,
  });
});
