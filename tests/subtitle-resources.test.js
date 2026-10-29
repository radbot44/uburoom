'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackError } = require('../server/av1');
const SubtitleResources = require('../server/subtitle-resources');

test('classifyExtractionError maps error messages and instances to standard PlaybackError', () => {
  const { classifyExtractionError } = SubtitleResources;

  // Timed out case
  const errTimeout = classifyExtractionError(new Error('Process timed out after 30s'));
  assert.ok(errTimeout instanceof PlaybackError);
  assert.equal(errTimeout.message, 'Subtitle extraction timed out. Try Plex burn-in.');

  // Exceeded limit case
  const errExceeded = classifyExtractionError(new Error('Subtitle font exceeded the supported limit.'));
  assert.ok(errExceeded instanceof PlaybackError);
  assert.equal(errExceeded.message, 'Subtitle resource or fonts exceeded the supported limits. Try Plex burn-in.');

  const errExceed = classifyExtractionError(new Error('Data size exceed max capacity'));
  assert.ok(errExceed instanceof PlaybackError);
  assert.equal(errExceed.message, 'Subtitle resource or fonts exceeded the supported limits. Try Plex burn-in.');

  // No usable data case
  const errNoData = classifyExtractionError(new Error('Subtitle extraction produced no usable data.'));
  assert.ok(errNoData instanceof PlaybackError);
  assert.equal(errNoData.message, 'Subtitle extraction produced no usable data. Try Plex burn-in.');

  // Failed case
  const errFailed = classifyExtractionError(new Error('Extraction failed during demux'));
  assert.ok(errFailed instanceof PlaybackError);
  assert.equal(errFailed.message, 'Subtitle extraction failed during media demuxing. Try Plex burn-in.');

  // Already PlaybackError instance
  const originalPbError = new PlaybackError('Custom playback error');
  const errSame = classifyExtractionError(originalPbError);
  assert.strictEqual(errSame, originalPbError);

  // Fallbacks: unknown error, empty error, null, undefined
  const errGeneric = classifyExtractionError(new Error('Uncategorized network error'));
  assert.ok(errGeneric instanceof PlaybackError);
  assert.equal(errGeneric.message, 'Original subtitles could not be extracted. Try Plex burn-in.');

  const errNull = classifyExtractionError(null);
  assert.ok(errNull instanceof PlaybackError);
  assert.equal(errNull.message, 'Original subtitles could not be extracted. Try Plex burn-in.');

  const errUndefined = classifyExtractionError(undefined);
  assert.ok(errUndefined instanceof PlaybackError);
  assert.equal(errUndefined.message, 'Original subtitles could not be extracted. Try Plex burn-in.');
});

test('clear resets media.subtitleAssets and operates safely on any media object', () => {
  const { clear } = SubtitleResources;
  const media = { subtitleAssets: new Map([['data', Buffer.from('test')]]) };

  clear(media);
  assert.equal(media.subtitleAssets, undefined);

  // Clearing again should be safe and non-throwing
  assert.doesNotThrow(() => clear(media));
  assert.equal(media.subtitleAssets, undefined);
});

test('read streams subtitle data and enforces response status and size limits', async () => {
  const { read, LIMIT } = SubtitleResources;
  assert.equal(LIMIT, 64 * 1024 * 1024);

  const signal = new AbortController().signal;

  // Non-ok response throws PlaybackError
  await assert.rejects(
    read({ ok: false }, signal),
    err => err instanceof PlaybackError && err.message.includes('unavailable')
  );

  // Successful read with async iterable body
  async function* createStream(chunks) {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  }

  const okResponse = {
    ok: true,
    body: createStream(['hello ', 'world'])
  };

  const buffer = await read(okResponse, signal);
  assert.equal(buffer.toString('utf8'), 'hello world');

  // Exceeding limit throws PlaybackError and cancels body
  let canceled = false;
  const oversizedResponse = {
    ok: true,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(10);
        yield Buffer.alloc(10);
      },
      cancel: async () => {
        canceled = true;
      }
    }
  };

  await assert.rejects(
    read(oversizedResponse, signal, 15),
    err => err instanceof PlaybackError && err.message.includes('exceeds the supported size')
  );
  assert.equal(canceled, true);

  // Aborted signal throws when reading stream
  const controller = new AbortController();
  controller.abort();
  const abortedResponse = {
    ok: true,
    body: createStream(['chunk1', 'chunk2'])
  };

  await assert.rejects(
    read(abortedResponse, controller.signal),
    err => err.name === 'AbortError'
  );
});

test('pipe streams PGS chunks progressively with a 300s idle timeout and caches completed output', async () => {
  const { pipe, clear, transfer } = SubtitleResources;
  const streamedOptions = [];
  const plex = {
    av1: {
      ffmpeg: 'ffmpeg',
      input: async (source, signal, fn) => fn('http://127.0.0.1:12345/cap'),
      stream: async (binary, args, signal, onChunk, options) => {
        streamedOptions.push(options);
        onChunk(Buffer.from('PG-CHUNK-1'));
        onChunk(Buffer.from('PG-CHUNK-2'));
      }
    }
  };
  const media = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: '11111111-2222-3333-4444-555555555555',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 23, index: 4, streamType: 3, codec: 'pgs' }] }] }] }
  };
  const written = [];
  let statusCode = 0;
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(code) { statusCode = code; this.headersSent = true; },
    write(chunk) { written.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) written.push(Buffer.from(chunk)); this.writableEnded = true; },
    on() {},
    off() {}
  };
  await pipe(plex, media, { method: 'GET' }, res, new AbortController().signal);
  assert.equal(statusCode, 200);
  assert.equal(Buffer.concat(written).toString('utf8'), 'PG-CHUNK-1PG-CHUNK-2');
  assert.equal(streamedOptions.length, 1);
  assert.equal(streamedOptions[0].idleTimeout, 300000);

  // Quality/stream replacement with the same source and subtitle track preserves captionVersion and cached bytes
  const replacement = {
    sourceKey: media.sourceKey,
    principal: media.principal,
    captionVersion: '99999999-8888-7777-6666-555555555555',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: media.source
  };
  assert.equal(transfer(media, replacement), true);
  assert.equal(replacement.captionVersion, '11111111-2222-3333-4444-555555555555');
  assert.equal(media.subtitleAbort, undefined);
  clear(media);

  const cachedWritten = [];
  const cachedRes = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) { cachedWritten.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) cachedWritten.push(Buffer.from(chunk)); this.writableEnded = true; },
    on() {},
    off() {}
  };
  await pipe(plex, replacement, { method: 'GET' }, cachedRes, new AbortController().signal);
  assert.equal(Buffer.concat(cachedWritten).toString('utf8'), 'PG-CHUNK-1PG-CHUNK-2');
  assert.equal(streamedOptions.length, 1);
  clear(replacement);
});

test('window retrieves bounded subtitle intervals, counts cues, and caches results', async () => {
  const { window, clear, transfer } = SubtitleResources;
  const ffmpegRuns = [];

  // Create a valid dummy PGS display set: PCS (0x16) + END (0x80)
  const pcs = Buffer.alloc(13 + 4);
  pcs[0] = 0x50; pcs[1] = 0x47; // 'PG'
  pcs.writeUInt32BE(90000 * 10, 2); // PTS: 10s
  pcs.writeUInt32BE(90000 * 10, 6); // DTS: 10s
  pcs[10] = 0x16; // PCS
  pcs.writeUInt16BE(4, 11); // size: 4

  const end = Buffer.alloc(13);
  end[0] = 0x50; end[1] = 0x47;
  end.writeUInt32BE(90000 * 10, 2);
  end.writeUInt32BE(90000 * 10, 6);
  end[10] = 0x80; // END
  end.writeUInt16BE(0, 11);

  const mockSupData = Buffer.concat([pcs, end]);

  const plex = {
    av1: {
      ffmpeg: 'ffmpeg',
      input: async (source, signal, fn) => fn('http://127.0.0.1:12345/source'),
      run: async (binary, args, signal, timeout, maxOutput) => {
        ffmpegRuns.push(args);
        return mockSupData;
      }
    }
  };

  const media = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 23, index: 4, streamType: 3, codec: 'pgs' }] }] }] }
  };

  // 1. Initial window request at 10s (atMs: 10000, beforeMs: 5000, afterMs: 20000)
  const result = await window(plex, media, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(result.format, 'pgs');
  assert.equal(result.startMs, 5000); // 10s - 5s
  assert.equal(result.endMs, 30000); // 5s + (5s + 20s)
  assert.equal(result.cues, 1);
  assert.equal(result.data.length, mockSupData.length);
  assert.equal(ffmpegRuns.length, 1);

  // Verify FFmpeg args included -ss, -t, and -copyts
  const runArgs = ffmpegRuns[0];
  const ssIdx = runArgs.indexOf('-ss');
  assert.ok(ssIdx >= 0);
  assert.equal(runArgs[ssIdx + 1], '5');
  const tIdx = runArgs.indexOf('-t');
  assert.ok(tIdx >= 0);
  assert.equal(runArgs[tIdx + 1], '25');
  assert.ok(runArgs.includes('-copyts'));

  // 2. Repeat request within the same interval uses windowCache without running FFmpeg
  const cachedResult = await window(plex, media, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(cachedResult.data, mockSupData);
  assert.equal(ffmpegRuns.length, 1); // No new run!

  // 3. Request contained inside existing coverage also uses windowCache with superset bounds
  const innerResult = await window(plex, media, { atMs: 12000, beforeMs: 2000, afterMs: 5000 });
  assert.equal(innerResult.data, mockSupData);
  assert.equal(innerResult.startMs, 5000); // returns superset startMs
  assert.equal(innerResult.endMs, 30000);  // returns superset endMs
  assert.equal(ffmpegRuns.length, 1); // Still 1

  // 3b. Request with explicit beforeMs: 0 is honored and not coerced to 15000
  const zeroBefore = await window(plex, media, { atMs: 40000, beforeMs: 0, afterMs: 20000 });
  assert.equal(zeroBefore.startMs, 40000);
  assert.equal(zeroBefore.endMs, 60000);
  assert.equal(ffmpegRuns.length, 2);
  const zeroArgs = ffmpegRuns[1];
  const ssZero = zeroArgs.indexOf('-ss');
  assert.equal(zeroArgs[ssZero + 1], '40'); // at 40s - 0s = 40s (not 25s!)

  // 4. Quality transfer preserves windowCache
  const replacement = {
    sourceKey: media.sourceKey,
    principal: media.principal,
    captionVersion: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: media.source
  };
  assert.equal(transfer(media, replacement), true);
  assert.ok(replacement.windowCache instanceof Map);
  assert.ok(replacement.windowCache.size > 0);

  // 5. Clear cleans up windowCache
  clear(replacement);
  assert.equal(replacement.windowCache.size, 0);

  // 6. ASS subtitle windowing: extracts -f ass and counts Dialogue lines
  const assText = '[Script Info]\nTitle: Test\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:10.00,0:00:15.00,Default,,0,0,0,,Line 1\nDialogue: 0,0:00:16.00,0:00:20.00,Default,,0,0,0,,Line 2\n';
  const mockAssData = Buffer.from(assText, 'utf8');
  const assMedia = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: '22222222-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '24', index: 5, delivery: 'ass', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 24, index: 5, streamType: 3, codec: 'ass' }] }] }] }
  };
  plex.av1.run = async (binary, args) => {
    ffmpegRuns.push(args);
    return mockAssData;
  };
  const assResult = await window(plex, assMedia, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(assResult.format, 'ass');
  assert.equal(assResult.cues, 2);
  const assRunArgs = ffmpegRuns[ffmpegRuns.length - 1];
  const fIdxAss = assRunArgs.indexOf('-f');
  assert.ok(fIdxAss >= 0);
  assert.equal(assRunArgs[fIdxAss + 1], 'ass');

  // 7. VobSub subtitle windowing: extracts -f matroska and detects content
  const mockVobsubData = Buffer.alloc(600, 0x11);
  const vobsubMedia = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: '33333333-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '25', index: 6, delivery: 'vobsub', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 25, index: 6, streamType: 3, codec: 'vobsub' }] }] }] }
  };
  plex.av1.run = async (binary, args) => {
    ffmpegRuns.push(args);
    return mockVobsubData;
  };
  const vobsubResult = await window(plex, vobsubMedia, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(vobsubResult.format, 'vobsub');
  assert.equal(vobsubResult.cues, 1);
  const vobsubRunArgs = ffmpegRuns[ffmpegRuns.length - 1];
  const fIdxVobsub = vobsubRunArgs.indexOf('-f');
  assert.ok(fIdxVobsub >= 0);
  assert.equal(vobsubRunArgs[fIdxVobsub + 1], 'matroska');
});

test('uburoomSubtitleWindows parses "0" header correctly, overlaps lookahead by 5s, and merges intervals', async () => {
  const { uburoomSubtitleWindows } = require('../web/watch-subtitles');

  const appends = [];
  const renderer = {
    append: async bytes => appends.push(bytes),
    destroy: () => {}
  };

  const originalFetch = global.fetch;
  try {
    let requestedUrls = [];
    global.fetch = async (url) => {
      requestedUrls.push(url);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'x-subtitle-start-ms': '0',
          'x-subtitle-end-ms': '60000',
          'x-subtitle-cues': '5'
        }
      });
    };

    let syncCount = 0;
    const windows = new uburoomSubtitleWindows(renderer, 'https://example.com/sub/window', () => { syncCount++; });

    // Fetch at target 50000ms: with '0' header, startMs must be 0 (not 35000)
    windows.fetch(50000, false);
    await new Promise(r => setTimeout(r, 20));

    assert.equal(windows.intervals.length, 1);
    assert.equal(windows.intervals[0].startMs, 0, '"0" header parsed as 0 instead of fallback 35000');
    assert.equal(windows.intervals[0].endMs, 60000);
    assert.equal(windows.intervals[0].cues, 5);
    assert.equal(syncCount, 1);
    assert.equal(windows.isCovered(25000), true);

    // Lookahead test: at time 45s (45000ms), 45000+20000=65000 is not covered by [0, 60000]
    // check(45) should trigger fetch(45000 + 30000) = fetch(75000) (overlapping lookahead)
    requestedUrls = [];
    global.fetch = async (url) => {
      requestedUrls.push(url);
      return new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: {
          'x-subtitle-start-ms': '55000',
          'x-subtitle-end-ms': '135000',
          'x-subtitle-cues': '3'
        }
      });
    };

    windows.check(45);
    assert.ok(requestedUrls.length > 0);
    assert.ok(requestedUrls[0].includes('atMs=75000'), 'Lookahead fetches at targetMs + 30000ms for 5s overlap');

    await new Promise(r => setTimeout(r, 20));
    // Interval [0, 60000] and [55000, 135000] overlap and must merge into [0, 135000]
    assert.equal(windows.intervals.length, 1);
    assert.equal(windows.intervals[0].startMs, 0);
    assert.equal(windows.intervals[0].endMs, 135000);
    assert.equal(windows.intervals[0].cues, 8);
  } finally {
    global.fetch = originalFetch;
  }
});

test('uburoomSubtitles preserves loading status until window scheduler covers mediaTime', async () => {
  const { uburoomSubtitles } = require('../web/watch-subtitles');

  const statusEvents = [];
  const mockVideo = {
    currentTime: 10,
    addTextTrack: () => ({ mode: 'disabled' }),
    textTracks: { addEventListener: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const originalFetch = global.fetch;
  const originalRenderers = global.window?.uburoomSubtitleRenderers;
  if (!global.window) global.window = {};

  try {
    global.window.uburoomSubtitleRenderers = {
      create: async () => ({
        offset: () => {},
        picture: () => {},
        append: async () => {},
        destroy: () => {}
      })
    };

    // Subtitle manifest advertising format 'pgs' with a window URL
    global.fetch = async (url) => {
      if (url.includes('subtitle-manifest')) {
        return new Response(JSON.stringify({
          format: 'pgs',
          data: 'https://example.com/api/watch/media/123/subtitle-manifest/data',
          window: 'https://example.com/api/watch/media/123/subtitle-manifest/window',
          fonts: []
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Window endpoint returns window covering 0..20s
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          'x-subtitle-start-ms': '0',
          'x-subtitle-end-ms': '20000',
          'x-subtitle-cues': '2'
        }
      });
    };

    const subs = new uburoomSubtitles(mockVideo, status => { statusEvents.push(status); });

    subs.update({ subtitleUrl: 'https://example.com/api/watch/media/123/subtitle-manifest' });
    await new Promise(r => setTimeout(r, 50));

    // When window scheduler was initialized, streamSynced was set to undefined, and Loading subtitles was preserved
    const loadingStates = statusEvents.filter(s => s.loading);
    assert.ok(loadingStates.length > 0, 'Loading subtitles was dispatched');
    assert.equal(subs.windowScheduler.synced(10), true);

    // Status cleared only when window covered currentTime
    const lastStatus = statusEvents[statusEvents.length - 1];
    assert.equal(lastStatus.loading, false);
    assert.equal(lastStatus.message, '');
  } finally {
    global.fetch = originalFetch;
    global.window.uburoomSubtitleRenderers = originalRenderers;
  }
});
