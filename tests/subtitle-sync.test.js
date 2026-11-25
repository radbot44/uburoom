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
    assert.equal(subs.cuesByKey.size, 2000, 'cuesByKey index drops pruned cues');
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

test('uburoomSubtitles caches UbuPlayer cue snapshot across paints and skips unchanged caption DOM updates', async () => {
  const originalVttCue = global.VTTCue;
  const originalDocument = global.document;
  const originalResizeObserver = global.ResizeObserver;

  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.children = [];
      this.replaceCalls = 0;
      this.style = { setProperty: () => {} };
      this.clientWidth = 1280;
      this.clientHeight = 720;
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.replaceCalls++;
      this.children = [...nodes];
    }
    textContent() {
      return this.children
        .map(child => (typeof child === 'string' ? child : child.tagName === 'BR' ? '\n' : child.textContent()))
        .join('');
    }
  }

  global.VTTCue = class FakeVTTCue {
    constructor(startTime, endTime, text) {
      this.startTime = startTime;
      this.endTime = endTime;
      this.text = text;
    }
  };
  global.document = {
    createElement: tag => new FakeElement(tag),
  };
  global.ResizeObserver = class FakeResizeObserver {
    observe() {}
  };

  try {
    const rawCues = [];
    let cuesReads = 0;
    const track = {
      mode: 'disabled',
      activeCues: [],
      get cues() {
        cuesReads++;
        return this.mode === 'disabled' ? null : rawCues;
      },
      addCue: cue => rawCues.push(cue),
      removeCue: cue => {
        const idx = rawCues.indexOf(cue);
        if (idx >= 0) rawCues.splice(idx, 1);
        const activeIdx = track.activeCues.indexOf(cue);
        if (activeIdx >= 0) track.activeCues.splice(activeIdx, 1);
      },
      addEventListener: () => {},
    };
    const stage = new FakeElement('div');
    let now = 0;
    let ubuPlayer = true;
    const listeners = new Map();
    const surface = {
      isMediaSurface: true,
      videoElement: {
        addTextTrack: () => track,
        textTracks: { addEventListener: () => {} },
      },
      stageElement: () => stage,
      isUbuPlayer: () => ubuPlayer,
      currentTime: () => now,
      width: () => 1280,
      height: () => 720,
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: event => listeners.delete(event),
    };

    const subs = new uburoomSubtitles(surface, () => {});
    await subs.setLocalSubtitle({
      key: 'local-1',
      format: 'cues',
      cues: [
        { start: 1, end: 5, text: '<i>Shared</i> &amp; long', settings: '' },
        { start: 2, end: 4, text: 'Top A', settings: 'line:10%' },
        { start: 4, end: 6, text: 'Top A', settings: 'line:10%' },
      ],
    });

    // Initial rebuild reads track.cues lazily once for paint (plus clearCues while empty).
    cuesReads = 0;
    subs.topCues.replaceCalls = 0;
    subs.bottomCues.replaceCalls = 0;

    // t=1.0 (inclusive start): bottom cue appears, top stays empty.
    now = 1;
    subs.paint();
    assert.equal(cuesReads, 0, 'snapshot reused after initial build');
    assert.equal(subs.bottomCues.textContent(), 'Shared & long');
    assert.equal(subs.topCues.textContent(), '');
    assert.equal(subs.bottomCues.replaceCalls, 1);
    assert.equal(subs.topCues.replaceCalls, 0);
    const firstBottomNode = subs.bottomCues.children[0];

    // Repeated paints within the same cue produce zero DOM mutations and zero track.cues reads.
    for (let i = 0; i < 10; i++) {
      now = 1 + i * 0.05;
      subs.paint();
    }
    assert.equal(cuesReads, 0);
    assert.equal(subs.bottomCues.replaceCalls, 1);
    assert.equal(subs.topCues.replaceCalls, 0);
    assert.equal(subs.bottomCues.children[0], firstBottomNode);

    // t=2.0: top cue enters while bottom cue remains unchanged -> only top updates.
    now = 2;
    subs.paint();
    assert.equal(subs.topCues.textContent(), 'Top A');
    assert.equal(subs.topCues.replaceCalls, 1);
    assert.equal(subs.bottomCues.replaceCalls, 1, 'unchanged bottom box not rebuilt');
    const firstTopNode = subs.topCues.children[0];

    // t=4.0 (exclusive end of first Top A, inclusive start of second Top A): identical text in a distinct cue updates.
    now = 4;
    subs.paint();
    assert.equal(subs.topCues.textContent(), 'Top A');
    assert.equal(subs.topCues.replaceCalls, 2);
    assert.notEqual(subs.topCues.children[0], firstTopNode);
    assert.equal(subs.bottomCues.replaceCalls, 1);

    // t=5.0 (exclusive end of bottom cue): bottom clears once, stays cleared on subsequent gap ticks.
    now = 5;
    subs.paint();
    assert.equal(subs.bottomCues.textContent(), '');
    assert.equal(subs.bottomCues.replaceCalls, 2);
    now = 5.5;
    subs.paint();
    assert.equal(subs.bottomCues.replaceCalls, 2);

    // Appending cues invalidates snapshot once; next paint sees new cue without per-cue rebuilds.
    subs.appendLocalCues([
      { start: 10, end: 12, text: 'Appended 1', settings: '' },
      { start: 12, end: 14, text: 'Appended 2', settings: '' },
    ]);
    assert.equal(cuesReads, 1, 'batch append rebuilt snapshot lazily once on paint');
    now = 10.5;
    subs.paint();
    assert.equal(cuesReads, 1);
    assert.equal(subs.bottomCues.textContent(), 'Appended 1');

    // Duplicate (end, text) with earlier start merges in place via cuesByKey and rebuilds.
    subs.appendLocalCues([{ start: 9, end: 12, text: 'Appended 1', settings: '' }]);
    assert.equal(subs.cues.filter(c => c.text === 'Appended 1').length, 1);
    now = 9.5;
    subs.paint();
    assert.equal(subs.bottomCues.textContent(), 'Appended 1');

    // Boundary cache handles overlapping cues, backward seeks across boundaries, and NaN without poisoning.
    now = 1.5;
    subs.paint();
    assert.equal(subs.cueValidFrom, 1);
    assert.equal(subs.cueValidUntil, 2);
    assert.equal(subs.bottomCues.textContent(), 'Shared & long');
    assert.equal(subs.topCues.textContent(), '');
    now = NaN;
    subs.paint();
    assert.equal(subs.bottomCues.textContent(), '');
    now = 2.5;
    subs.paint();
    assert.equal(subs.cueValidFrom, 2);
    assert.equal(subs.cueValidUntil, 4);
    assert.equal(subs.bottomCues.textContent(), 'Shared & long');
    assert.equal(subs.topCues.textContent(), 'Top A');
    now = 1.2;
    subs.paint();
    assert.equal(subs.bottomCues.textContent(), 'Shared & long');
    assert.equal(subs.topCues.textContent(), '');

    // Offset change rebuilds cues and updates visible captions immediately.
    subs.setOffset(1);
    now = 9.5;
    subs.paint();
    assert.equal(subs.bottomCues.textContent(), '');
    now = 10.5;
    subs.paint();
    assert.equal(subs.bottomCues.textContent(), 'Appended 1');

    // Native fullscreen toggles track mode between hidden and showing.
    subs.nativeFullscreen(true);
    assert.equal(track.mode, 'showing');
    subs.nativeFullscreen(false);
    assert.equal(track.mode, 'hidden');

    // Native video path uses track.activeCues and still skips identical updates.
    ubuPlayer = false;
    const activeCue = rawCues[0];
    track.activeCues = [activeCue];
    const bottomBeforeNative = subs.bottomCues.replaceCalls;
    subs.paint();
    assert.equal(subs.bottomCues.textContent(), 'Shared & long');
    assert.equal(subs.bottomCues.replaceCalls, bottomBeforeNative + 1);
    subs.paint();
    assert.equal(subs.bottomCues.replaceCalls, bottomBeforeNative + 1);

    // Reset clears caption boxes once and disables the track.
    subs.reset();
    assert.equal(track.mode, 'disabled');
    assert.equal(subs.topCues.textContent(), '');
    assert.equal(subs.bottomCues.textContent(), '');
    const bottomAfterReset = subs.bottomCues.replaceCalls;
    subs.paint();
    assert.equal(subs.bottomCues.replaceCalls, bottomAfterReset);

    subs.destroy();
  } finally {
    global.VTTCue = originalVttCue;
    global.document = originalDocument;
    global.ResizeObserver = originalResizeObserver;
  }
});

test('paused UbuPlayer paints newly arrived text subtitle windows without waiting for timeupdate and ignores stale responses', async () => {
  const originalVttCue = global.VTTCue;
  const originalDocument = global.document;
  const originalResizeObserver = global.ResizeObserver;
  const originalFetch = global.fetch;

  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.children = [];
      this.replaceCalls = 0;
      this.style = { setProperty: () => {} };
      this.clientWidth = 1280;
      this.clientHeight = 720;
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.replaceCalls++;
      this.children = [...nodes];
    }
    textContent() {
      return this.children
        .map(child => (typeof child === 'string' ? child : child.tagName === 'BR' ? '\n' : child.textContent()))
        .join('');
    }
  }

  global.VTTCue = class FakeVTTCue {
    constructor(startTime, endTime, text) {
      this.startTime = startTime;
      this.endTime = endTime;
      this.text = text;
    }
  };
  global.document = { createElement: tag => new FakeElement(tag) };
  global.ResizeObserver = class FakeResizeObserver {
    observe() {}
  };

  try {
    const rawCues = [];
    const track = {
      mode: 'disabled',
      activeCues: [],
      get cues() {
        return this.mode === 'disabled' ? null : rawCues;
      },
      addCue: cue => rawCues.push(cue),
      removeCue: cue => {
        const idx = rawCues.indexOf(cue);
        if (idx >= 0) rawCues.splice(idx, 1);
      },
      addEventListener: () => {},
    };
    const stage = new FakeElement('div');
    let now = 5;
    const listeners = new Map();
    const surface = {
      isMediaSurface: true,
      videoElement: {
        addTextTrack: () => track,
        textTracks: { addEventListener: () => {} },
      },
      stageElement: () => stage,
      isUbuPlayer: () => true,
      currentTime: () => now,
      width: () => 1280,
      height: () => 720,
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: event => listeners.delete(event),
    };

    const statuses = [];
    const gates = new Map();
    const fetchCues = new Map([
      [
        '/subs/a/0',
        {
          startMs: 0,
          endMs: 60000,
          cues: [{ start: 4, end: 8, text: 'Initial paused line', settings: '' }],
        },
      ],
      [
        '/subs/a/120000',
        {
          startMs: 110000,
          endMs: 180000,
          cues: [
            { start: 120, end: 126, text: 'First overlap', settings: '' },
            { start: 120, end: 124, text: 'Second overlap', settings: '' },
          ],
        },
      ],
      [
        '/subs/b/120000',
        {
          startMs: 110000,
          endMs: 180000,
          cues: [{ start: 120, end: 126, text: 'Track B line', settings: '' }],
        },
      ],
    ]);

    global.fetch = async (url, { signal } = {}) => {
      const parsed = new URL(url, 'https://example.test');
      if (!parsed.pathname.endsWith('/window')) {
        return new Response(JSON.stringify({ format: 'cues', window: parsed.pathname + '/0/window' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const atMs = Number(parsed.searchParams.get('atMs'));
      const prefix = parsed.pathname.startsWith('/subs/b/') ? '/subs/b/' : '/subs/a/';
      const key = prefix + (atMs >= 100000 ? '120000' : '0');
      const gate = gates.get(key);
      if (gate) {
        await Promise.race([
          gate.promise,
          new Promise((_, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        ]);
      }
      const payload = fetchCues.get(key);
      return new Response(JSON.stringify(payload.cues), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Subtitle-Start-Ms': String(payload.startMs),
          'X-Subtitle-End-Ms': String(payload.endMs),
        },
      });
    };

    const subs = new uburoomSubtitles(surface, s => statuses.push(s));

    // 1. Enabling while paused: delayed initial window paints on arrival without timeupdate.
    const initialGate = Promise.withResolvers();
    gates.set('/subs/a/0', initialGate);
    subs.update({ subtitleUrl: '/subs/a', tracks: { subtitleOffset: 0 } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(subs.bottomCues.textContent(), '');
    initialGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(subs.bottomCues.textContent(), 'Initial paused line');
    assert.equal(statuses.at(-1)?.loading, false);

    // 2. Pause-seek into an uncovered window delayed until after seeked: paints both overlapping lines on arrival.
    const seekGate = Promise.withResolvers();
    gates.set('/subs/a/120000', seekGate);
    now = 121;
    listeners.get('seeked')?.();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(subs.bottomCues.textContent(), '');
    seekGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(subs.bottomCues.textContent(), 'First overlapSecond overlap');
    assert.equal(statuses.at(-1)?.loading, false);
    assert.equal(statuses.at(-1)?.message, '');

    // 3. Stale response after switching track does not overwrite the new track's captions.
    const staleGate = Promise.withResolvers();
    gates.set('/subs/a/0', staleGate);
    subs.update({ subtitleUrl: '/subs/b', tracks: { subtitleOffset: 0 } });
    staleGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(subs.bottomCues.textContent(), 'Track B line');

    subs.destroy();
  } finally {
    global.VTTCue = originalVttCue;
    global.document = originalDocument;
    global.ResizeObserver = originalResizeObserver;
    global.fetch = originalFetch;
  }
});
