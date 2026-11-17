'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Remux } = require('../server/remux');
const { AV1 } = require('../server/av1');
const { normalizeConfig } = require('../server/config');

function fixture(t, synthetic = false) {
  const file = path.join(__dirname, '../assets/demo/sync-test.mp4');
  const owner = new Remux(new AV1(normalizeConfig({})));
  if (synthetic) {
    owner.boundaries = async () => Array.from({ length: 200 }, (_, index) => index * 6);
    owner.open = async (_source, signal) =>
      new Promise(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
  }
  t.after(() => owner.close());
  const media = () => ({
    id: 'fixture',
    sourceKey: file,
    sourceStart: 'fixture',
    videoCodec: 'h264',
    duration: synthetic ? 1200 : 60,
    title: 'Generated sync fixture',
    provider: { filePath: async () => file },
  });
  const acquire = async (room = 'room') => {
    const source = media();
    const lease = await owner.acquire(source, { id: 'audio', ordinal: 0 }, [room, 'version']);
    return { media: source, lease, session: lease.session };
  };
  const store = (session, index) =>
    session.store({ id: 'fixture', controller: new AbortController() }, index, Buffer.from('segment-' + index));
  return { owner, acquire, store };
}

test('real remux isolates rooms, shares same-room leases and serves concurrent anchor/mid-stream requests', async t => {
  const f = fixture(t),
    a = await f.acquire(),
    b = await f.acquire(),
    other = await f.acquire('other');
  assert.equal(a.session, b.session);
  assert.notEqual(a.session, other.session);
  const get = async (viewer, index) => {
    const response = await viewer.media.hlsProvider.request(new URL('seg-' + index + '.m4s', viewer.media.start).href, {
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };
  const [anchor, middle] = await Promise.all([get(a, 0), get(b, 1)]);
  assert.ok(anchor.length > 100);
  assert.ok(middle.length > 100);
  assert.deepEqual(await get(b, 0), anchor, 'late anchor fetch never restarts the encoder');
  assert.equal(a.session.cursors.get(b.lease).index, 1, 'anchor requests preserve this lease playhead');
  assert.equal(a.session.cursors.get(a.lease).index, 0);
  const head = await b.media.hlsProvider.request(new URL('seg-1.m4s', b.media.start).href, { method: 'HEAD' });
  assert.equal(head.body, null);
  assert.equal(Number(head.headers.get('content-length')), middle.length);
  await a.lease.release();
  assert.equal(a.session.cursors.has(a.lease), false);
  assert.equal(b.session.closed, false);
  await b.lease.release();
  assert.equal(b.session.closed, true);
});

test('remux preemption settles skipped waiters promptly and cancellation removes pending waiters', async t => {
  const f = fixture(t, true),
    a = await f.acquire();
  await f.store(a.session, 0);
  const controller = new AbortController();
  const first = a.session.segment(1, controller.signal, a.lease);
  const rejected = assert.rejects(first, /moved; retry/);
  await new Promise(resolve => setImmediate(resolve));
  const later = a.session.segment(20, controller.signal, a.lease);
  const cancelled = assert.rejects(later, /cancelled/);
  await Promise.race([
    rejected,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Skipped waiter hung')), 1000);
      timer.unref();
    }),
  ]);
  controller.abort();
  await cancelled;
  assert.equal(a.session.waiters.has(20), false);
});

test('remux retains per-lease windows and segment zero within a bounded segment cache', async t => {
  const f = fixture(t, true),
    a = await f.acquire(),
    b = await f.acquire();
  a.session.cursors.set(a.lease, { index: 10, at: Date.now() });
  a.session.cursors.set(b.lease, { index: 180, at: Date.now() });
  for (let index = 0; index < 200; index++) await f.store(a.session, index);
  assert.ok(a.session.segments.has(0));
  assert.ok(a.session.segments.has(10));
  assert.ok(a.session.segments.has(180));
  assert.ok(a.session.segments.size <= 64);
  const before = a.session.segments.get(10).file;
  await a.lease.release();
  a.session.pace();
  assert.equal(a.session.segments.has(10), false, 'released lease no longer pins trailing segments');
  assert.ok(a.session.segments.has(0));
  // Files evicted by pacing are unlinked asynchronously.
  for (let retry = 0; retry < 100 && fs.existsSync(before); retry++)
    await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(fs.promises.stat(before), { code: 'ENOENT' });
});

test('an opened remux segment survives pacing unlink, while aborted and HEAD requests close handles', async t => {
  const f = fixture(t, true),
    a = await f.acquire();
  await f.store(a.session, 0);
  a.session.cursors.set(a.lease, { index: 10, at: Date.now() });
  await f.store(a.session, 10);
  const opened = await a.session.segment(10, undefined, a.lease);
  a.session.cursors.set(a.lease, { index: 100, at: Date.now() });
  a.session.pace();
  assert.equal(a.session.segments.has(10), false);
  await fs.promises.rm(opened.file, { force: true });
  assert.equal((await opened.handle.readFile()).toString(), 'segment-10');
  await opened.handle.close();
  const signal = AbortSignal.abort();
  await assert.rejects(a.session.segment(0, signal, a.lease), /cancelled/);
});

test('a backward same-lease request cannot pause a run ahead of an outstanding forward request', async t => {
  const f = fixture(t, true),
    a = await f.acquire();
  await f.store(a.session, 0);
  const forward = a.session.segment(20, undefined, a.lease);
  await new Promise(resolve => setImmediate(resolve));
  const backward = a.session.segment(1, undefined, a.lease);
  await new Promise(resolve => setImmediate(resolve));
  const run = a.session.run;
  run.child = { stdout: { pause() {}, resume() {} } };
  await a.session.store(run, 1, Buffer.from('backward'));
  const first = await backward;
  await first.handle.close();
  run.head = 12;
  a.session.pace();
  assert.equal(run.paused, false, 'the pending forward request still supplies demand');
  await a.session.store(run, 20, Buffer.from('forward'));
  const second = await forward;
  assert.equal((await second.handle.readFile()).toString(), 'forward');
  await second.handle.close();
});

test('remux response cancellation, abort and HEAD release opened file descriptors', async t => {
  const f = fixture(t, true),
    a = await f.acquire();
  await f.store(a.session, 0);
  const opened = [],
    original = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await original(...args);
    opened.push(handle);
    return handle;
  });
  const url = new URL('seg-0.m4s', a.media.start).href;
  await a.media.hlsProvider.request(url, { method: 'HEAD' });
  assert.equal(opened.at(-1).fd, -1);
  const cancelled = await a.media.hlsProvider.request(url);
  await cancelled.body.cancel();
  const controller = new AbortController();
  const aborted = await a.media.hlsProvider.request(url, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted.arrayBuffer());
  for (let retry = 0; retry < 100 && opened.some(handle => handle.fd !== -1); retry++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened.every(handle => handle.fd === -1));
});
