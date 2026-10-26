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
  const { pipe, clear } = SubtitleResources;
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
    captionVersion: '11111111-2222-3333-4444-555555555555',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', external: false } },
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
  clear(media);
});
