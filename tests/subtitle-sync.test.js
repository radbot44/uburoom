'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatSubtitleOffset, normalizeSubtitleOffset, uburoomSubtitles } = require('../web/watch-subtitles.js');
const { subtitleRenderers } = require('../web/subtitle-renderers.js');
const { createSubtitleOffsetStore, subtitleOffsetKey } = require('../web/watch/preferences.js');
const { pgs } = require('../scripts/lib/subtitle-fixtures.js');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    dump: key => (data.has(key) ? JSON.parse(data.get(key)) : null),
  };
}

function createFakeTrackEnv() {
  const cues = [];
  const listeners = new Map();
  const track = {
    mode: 'disabled',
    cues,
    addCue: cue => cues.push(cue),
    removeCue: cue => {
      const idx = cues.indexOf(cue);
      if (idx >= 0) cues.splice(idx, 1);
    },
    addEventListener: () => {},
  };
  const video = {
    currentTime: 10,
    addTextTrack: () => track,
    textTracks: { addEventListener: () => {} },
    addEventListener: (event, fn) => listeners.set(event, fn),
    removeEventListener: event => listeners.delete(event),
  };
  return { track, cues, video };
}

test('normalizeSubtitleOffset and formatSubtitleOffset clamp, round, and format cleanly', () => {
  assert.equal(normalizeSubtitleOffset(0.1 + 0.2), 0.3);
  assert.equal(normalizeSubtitleOffset(-0.04), 0);
  assert.equal(normalizeSubtitleOffset(45), 30);
  assert.equal(normalizeSubtitleOffset(-99), -30);
  assert.equal(normalizeSubtitleOffset('', 1.5), 1.5);
  assert.equal(normalizeSubtitleOffset(NaN, 0), 0);
  assert.equal(normalizeSubtitleOffset('not-a-number', -2), -2);

  assert.equal(formatSubtitleOffset(0), '0.0 s');
  assert.equal(formatSubtitleOffset(1.5), '+1.5 s');
  assert.equal(formatSubtitleOffset(-0.5), '−0.5 s');
});

test('uburoomSubtitles.setOffset shifts text cues immediately without clobbering on server heartbeats', async () => {
  const originalVttCue = global.VTTCue;
  const originalFetch = global.fetch;
  global.VTTCue = class FakeVTTCue {
    constructor(startTime, endTime, text) {
      this.startTime = startTime;
      this.endTime = endTime;
      this.text = text;
    }
  };
  const { track, cues, video } = createFakeTrackEnv();
  try {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          cues: [
            { start: 0.5, end: 1.0, text: 'Opening' },
            { start: 5.0, end: 8.0, text: 'Dialogue' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const subs = new uburoomSubtitles(video, () => {});
    subs.update({ subtitleUrl: 'https://example.com/captions-1', tracks: { subtitleOffset: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(track.mode, 'hidden');
    assert.deepEqual(
      cues.map(c => [c.startTime, c.endTime, c.text]),
      [
        [0.5, 1.0, 'Opening'],
        [5.0, 8.0, 'Dialogue'],
      ],
    );

    // Positive delay pushes cues later.
    assert.equal(subs.setOffset(1.5), 1.5);
    assert.deepEqual(
      cues.map(c => [c.startTime, c.endTime, c.text]),
      [
        [2.0, 2.5, 'Opening'],
        [6.5, 9.5, 'Dialogue'],
      ],
    );

    // Server heartbeat reporting subtitleOffset: 0 must not wipe client offset.
    subs.update({ subtitleUrl: 'https://example.com/captions-1', tracks: { subtitleOffset: 0 } });
    assert.equal(subs.offset, 1.5);

    // Negative offset clamps start at 0 and drops cues whose shifted end <= start.
    assert.equal(subs.setOffset(-1.5), -1.5);
    assert.deepEqual(
      cues.map(c => [c.startTime, c.endTime, c.text]),
      [[3.5, 6.5, 'Dialogue']],
    );

    // Resetting restores earlier cues from stored source list.
    assert.equal(subs.setOffset(0), 0);
    assert.equal(cues.length, 2);

    // An explicit server offset update still takes effect.
    subs.update({ subtitleUrl: 'https://example.com/captions-1', tracks: { subtitleOffset: 2 } });
    assert.equal(subs.offset, 2);
  } finally {
    global.VTTCue = originalVttCue;
    global.fetch = originalFetch;
  }
});

test('uburoomSubtitles.setOffset updates renderer offset and checks windowed subtitles at mediaTime - offset', async () => {
  const { video } = createFakeTrackEnv();
  const originalFetch = global.fetch;
  const originalCreate = subtitleRenderers.create;
  const rendererOffsets = [];
  const requestedAtMs = [];
  const statusEvents = [];

  try {
    Object.assign(subtitleRenderers, {
      create: async (_video, _format, _assets, initialOffset) => {
        rendererOffsets.push(initialOffset);
        return {
          offset: value => rendererOffsets.push(value),
          append: async () => {},
          flush: async () => {},
          reset: async () => {},
          destroy: () => {},
        };
      },
    });
    global.fetch = async url => {
      if (url.endsWith('/subtitle-manifest')) {
        return new Response(
          JSON.stringify({
            format: 'pgs',
            data: 'https://example.com/api/watch/media/1/subtitle-manifest/data',
            window: 'https://example.com/api/watch/media/1/subtitle-manifest/window',
            fonts: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const parsed = new URL(url);
      const atMs = Number(parsed.searchParams.get('atMs'));
      requestedAtMs.push(atMs);
      return new Response(pgs(), {
        status: 200,
        headers: {
          'x-subtitle-start-ms': String(Math.max(0, atMs - 5000)),
          'x-subtitle-end-ms': String(atMs + 10000),
          'x-subtitle-cues': '1',
        },
      });
    };

    const subs = new uburoomSubtitles(
      video,
      status => statusEvents.push(status),
      mediaTime => mediaTime + 5,
    );
    subs.update({ subtitleUrl: 'https://example.com/api/watch/media/1/subtitle-manifest' });
    await new Promise(resolve => setTimeout(resolve, 40));

    // video.currentTime is 10, resolveMediaTime yields 15.
    assert.equal(requestedAtMs[0], 15000);
    assert.deepEqual(rendererOffsets, [0, 0]);

    // Shifting +12s shifts source lookup to (15 - 12) = 3s, outside [10s..25s].
    subs.setOffset(12);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(rendererOffsets.at(-1), 12);
    assert.equal(requestedAtMs.at(-1), 3000);
    assert.ok(statusEvents.some(s => s.loading && s.message === 'Loading subtitles…'));
  } finally {
    global.fetch = originalFetch;
    Object.assign(subtitleRenderers, { create: originalCreate });
  }
});

test('subtitle offset store persists per (mediaId, track), deletes zeros, and evicts LRU past 100 entries', () => {
  const storage = memoryStorage();
  const store = createSubtitleOffsetStore(storage, 100);

  assert.equal(subtitleOffsetKey('movie-1', { id: 'track-a' }), 'movie-1:track-a');
  assert.equal(subtitleOffsetKey('movie-1', 'off'), '');
  assert.equal(subtitleOffsetKey('movie-1', 'auto'), '');

  assert.equal(store.set('movie-1', { id: 'track-a' }, 1.24), 1.2);
  assert.equal(store.get('movie-1', { id: 'track-a' }), 1.2);
  assert.equal(store.get('movie-1', { id: 'track-b' }), 0);

  // Explicit 0 clears storage entry instead of storing zeros.
  assert.equal(store.set('movie-1', { id: 'track-a' }, 0), 0);
  assert.equal(store.get('movie-1', { id: 'track-a' }), 0);
  assert.deepEqual(storage.dump('uburoom.subtitleOffsets'), []);

  // Populate 100 entries, touch the oldest so it promotes to MRU, then insert 101st.
  for (let i = 1; i <= 100; i++) store.set('m' + i, 't1', 0.5);
  assert.equal(store.get('m1', 't1'), 0.5);
  store.set('m101', 't1', -2.5);

  const raw = storage.dump('uburoom.subtitleOffsets');
  assert.equal(raw.length, 100);
  assert.equal(store.get('m1', 't1'), 0.5);
  assert.equal(store.get('m2', 't1'), 0);
  assert.equal(store.get('m101', 't1'), -2.5);

  // Corrupt storage degrades gracefully.
  const broken = createSubtitleOffsetStore(memoryStorage({ 'uburoom.subtitleOffsets': '{not-json' }));
  assert.equal(broken.get('m1', 't1'), 0);
});

test('uburoomSubtitles refetches pruned text windows and restores dropped cues on rewind', async () => {
  const originalVttCue = global.VTTCue;
  const originalFetch = global.fetch;
  global.VTTCue = class FakeVTTCue {
    constructor(startTime, endTime, text) {
      this.startTime = startTime;
      this.endTime = endTime;
      this.text = text;
    }
  };
  const { video } = createFakeTrackEnv();
  const requests = [];
  const makeCues = (startSec, count) =>
    Array.from({ length: count }, (_, i) => ({
      start: startSec + i,
      end: startSec + i + 0.8,
      text: 'Cue ' + (startSec + i),
    }));
  try {
    const baseUrl = 'https://example.com/captions-windowed';
    const windowUrl = baseUrl + '/sub-1/window';
    global.fetch = async url => {
      const target = String(url);
      requests.push(target);
      if (target === baseUrl) {
        return new Response(JSON.stringify({ format: 'cues', window: windowUrl }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const parsed = new URL(target);
      const atMs = Number(parsed.searchParams.get('atMs'));
      if (atMs < 1500000) {
        return new Response(JSON.stringify(makeCues(0, 1500)), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Subtitle-Start-Ms': '0',
            'X-Subtitle-End-Ms': '1500000',
          },
        });
      }
      return new Response(JSON.stringify(makeCues(2000, 1100)), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Subtitle-Start-Ms': '1500000',
          'X-Subtitle-End-Ms': '3200000',
        },
      });
    };

    const subs = new uburoomSubtitles(video, () => {});
    video.currentTime = 5;
    subs.update({ subtitleUrl: baseUrl, tracks: { subtitleOffset: 0 } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(subs.cues.length, 1500);
    assert.ok(subs.cues.some(c => c.text === 'Cue 5'));

    // Jump forward and load 1100 more cues (2600 > 2500) -> prunes earliest 600 cues including Cue 5.
    video.currentTime = 2500;
    subs.textWindows.check(2500);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(subs.cues.length, 2000);
    assert.equal(
      subs.cues.some(c => c.text === 'Cue 5'),
      false,
      'Cue 5 was pruned when total cues exceeded 2500',
    );
    assert.equal(subs.textWindows.covered(5000), false, 'pruned earlier window is no longer marked covered');

    // Rewinding to t=5 must refetch the missing window and restore Cue 5.
    const beforeRewind = requests.length;
    video.currentTime = 5;
    subs.textWindows.check(5);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(requests.length > beforeRewind, 'rewind triggered a fresh window fetch');
    assert.ok(
      subs.cues.some(c => c.text === 'Cue 5'),
      'rewound cue is restored instead of dropped by seen cache',
    );
    subs.destroy();
  } finally {
    global.VTTCue = originalVttCue;
    global.fetch = originalFetch;
  }
});
