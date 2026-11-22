// @ts-check
'use strict';
const fsp = require('node:fs/promises');

const PIECE = 256 * 1024;

/**
 * A web stream of a file's bytes, read only when its consumer asks for more.
 *
 * Node's Readable.toWeb adapter keeps reading while the consumer is busy; when the consumer
 * cancels (FFmpeg seeking, a viewer leaving) data still in flight is enqueued on a closed
 * controller, and that TypeError ends the whole process. Reading on pull leaves nothing in
 * flight, and cancelling or aborting only closes the file.
 *
 * @param {string | import('node:fs/promises').FileHandle} source a path, or an open handle this stream then owns
 * @param {{ start?: number, end?: number, signal?: AbortSignal, onClose?: () => void }} [options] end is inclusive, as in HTTP ranges
 * @returns {ReadableStream<Uint8Array>}
 */
function fileStream(source, { start = 0, end = Infinity, signal, onClose } = {}) {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle = typeof source === 'string' ? undefined : source;
  /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
  let controller;
  let at = start,
    done = false;
  const close = async () => {
    if (done) return;
    done = true;
    signal?.removeEventListener('abort', aborted);
    try {
      await handle?.close().catch(() => {});
    } finally {
      onClose?.();
    }
  };
  const aborted = () => {
    try {
      controller?.error(signal?.reason);
    } catch {
      /* Already closed or errored. */
    }
    close();
  };
  return new ReadableStream(
    {
      async start(c) {
        controller = c;
        if (signal?.aborted) {
          await close();
          throw signal.reason;
        }
        signal?.addEventListener('abort', aborted, { once: true });
        if (!handle) handle = await fsp.open(/** @type {string} */ (source), 'r');
      },
      async pull(c) {
        const length = Math.min(PIECE, end + 1 - at);
        if (done || length <= 0) {
          await close();
          if (!signal?.aborted) c.close();
          return;
        }
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await /** @type {import('node:fs/promises').FileHandle} */ (handle).read(
          buffer,
          0,
          length,
          at,
        );
        // Cancelled or aborted while reading: the stream is finished, so nothing is enqueued.
        if (done) return;
        if (!bytesRead) {
          await close();
          c.close();
          return;
        }
        at += bytesRead;
        c.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}

module.exports = { fileStream };
