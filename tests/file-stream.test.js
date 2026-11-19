'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  fsp = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { fileStream } = require('../server/file-stream');

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('file streams serve exact byte ranges and finish cleanly', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-file-stream-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'media.bin');
  const bytes = Buffer.from(Array.from({ length: 700 * 1024 }, (_, i) => i % 251));
  await fsp.writeFile(file, bytes);
  const read = async stream => Buffer.from(await new Response(stream).arrayBuffer());
  assert.deepEqual(await read(fileStream(file)), bytes);
  assert.deepEqual(await read(fileStream(file, { start: 1000, end: 300000 })), bytes.subarray(1000, 300001));
  // An open handle is owned and closed by the stream.
  const handle = await fsp.open(file);
  assert.deepEqual(await read(fileStream(handle, { start: 5 })), bytes.subarray(5));
  await assert.rejects(handle.stat(), /closed|EBADF/);
});

test('cancelling or aborting a file stream mid-read cannot crash the server', async t => {
  // Node 22.14's Readable.toWeb resumed a cancelled file stream and enqueued on its closed
  // controller, an uncaught TypeError that stopped uburoom when FFmpeg seeked a local film.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-file-stream-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'media.bin');
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 7));
  for (let i = 0; i < 20; i++) {
    const abort = new AbortController();
    const reader = new Response(fileStream(file, { signal: abort.signal })).body.getReader();
    assert.equal((await reader.read()).done, false);
    await tick(2);
    const pending = reader.read().catch(error => error);
    if (i % 2) abort.abort();
    await reader.cancel().catch(() => {});
    await pending;
    await tick(2);
  }
  const abort = new AbortController();
  const reader = new Response(fileStream(file, { signal: abort.signal })).body.getReader();
  await reader.read();
  abort.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(new Response(fileStream(file, { signal: aborted.signal })).arrayBuffer(), {
    name: 'AbortError',
  });
});
