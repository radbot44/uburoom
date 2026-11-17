'use strict';
// @ts-check
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { classifyHdr, cpuTonemap } = require('../av1');

/** Picture sizes (width, height), the same as Plex's, so local tiles look like the others. */
const SIZES = { poster: [300, 450], landscape: [400, 225], backdrop: [1280, 720], logo: [720, 280] };
const MAX_PICTURE = 3 * 1024 * 1024,
  CACHE_BYTES = 256 * 1024 * 1024,
  AT_ONCE = 2,
  TIMEOUT_MS = 30000,
  // Raise when the pictures made from the same source change, so old ones are not served.
  VERSION = 1;
const unavailable = () => Object.assign(new Error('Artwork unavailable'), { status: 404 });

/**
 * Pictures for local videos, made with FFmpeg and kept in a folder of the data directory,
 * never beside the media. A picture file beside the video (`poster.jpg`, `Film-fanart.jpg`)
 * is used when there is one; otherwise a frame from about a fifth of the way in, picked by
 * FFmpeg's thumbnail filter from about a second of video so it is rarely a black or
 * blurred one. HDR frames are tone-mapped. A frame that does not fit the picture's shape
 * sits whole on a blurred, darkened copy of itself (owner-approved 2026-11-16). Each
 * picture is made once per source file version, two at a time, and the folder is kept
 * under its size by removing the least recently used.
 */
class LocalArt {
  /**
   * @param {{directory: string, tools: () => any, logger?: any}} options `tools()` is the pipeline's
   *   FFmpeg runner (`ffmpeg` path and `run`), read when needed so a later configuration is seen.
   */
  constructor({ directory, tools, logger }) {
    this.directory = directory;
    this.tools = tools;
    this.logger = logger;
    /** @type {Map<string, Promise<Buffer>>} */
    this.making = new Map();
    /** @type {(() => void)[]} */
    this.waiting = [];
    this.active = 0;
    this.written = 0;
    this.closing = new AbortController();
  }
  /** Whether frames can be made at all; picture files beside videos still need FFmpeg to be resized. */
  get available() {
    return !!this.tools()?.ffmpeg;
  }
  /**
   * @param {import('./index').LocalEntry} entry
   * @param {string} kind
   * @param {() => Promise<{stat: {size: number, mtimeMs: number}, info: any}>} describe The video as it is now.
   * @returns {Promise<{type: string, bytes: Buffer}>}
   */
  async picture(entry, kind, describe) {
    if (!Object.hasOwn(SIZES, kind)) throw Object.assign(new Error('Invalid artwork'), { status: 400 });
    if (!this.available) throw unavailable();
    const file = entry.art[kind] || (kind === 'landscape' ? entry.art.backdrop : undefined);
    let source;
    if (file) {
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat?.isFile()) throw unavailable();
      source = { file, stat };
    } else if (kind === 'logo') throw unavailable();
    else {
      const { stat, info } = await describe();
      source = { stat, info };
    }
    const png = kind === 'logo';
    const key = createHash('sha256')
      .update([VERSION, entry.token, kind, file || entry.path, source.stat.size, source.stat.mtimeMs].join('\n'))
      .digest('hex')
      .slice(0, 32);
    const cached = path.join(this.directory, key + (png ? '.png' : '.jpg'));
    const type = png ? 'image/png' : 'image/jpeg';
    const saved = await fs.readFile(cached).catch(() => undefined);
    if (saved?.length) {
      // Touched so the least recently shown pictures are the ones removed.
      const now = new Date();
      fs.utimes(cached, now, now).catch(() => {});
      return { type, bytes: saved };
    }
    let making = this.making.get(key);
    if (!making) {
      making = this.turn(() => this.make(entry, kind, source, cached));
      this.making.set(key, making);
      making.finally(() => this.making.delete(key)).catch(() => {});
    }
    return { type, bytes: await making };
  }
  /** Run `task` once fewer than AT_ONCE pictures are being made. */
  async turn(task) {
    if (this.active >= AT_ONCE) await new Promise(resolve => this.waiting.push(() => resolve(undefined)));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
  async make(entry, kind, source, cached) {
    const tools = this.tools();
    const [width, height] = SIZES[kind];
    let args;
    if (source.file) {
      // Never enlarged; a logo keeps its transparency.
      args = [
        '-i',
        source.file,
        '-vf',
        `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease`,
      ];
    } else {
      const video = source.info.streams?.find(stream => stream.codec_type === 'video');
      if (!video?.width || !video?.height) throw unavailable();
      const hdr = classifyHdr(video);
      // Dolby Vision Profile 5 has no picture zscale can tone-map; a wrong-colored frame is worse than none.
      if (hdr.doviP5) throw unavailable();
      const duration = Number(source.info.duration) || 0;
      const at = duration > 20 ? duration * 0.2 : duration / 2;
      // Shrunk first: the thumbnail filter holds its frames in memory, and tone-mapping a small picture is quick.
      const picture = [
        'scale=iw*sar:ih',
        'setsar=1',
        "scale=w='min(1280,iw)':h=-2",
        ...cpuTonemap(hdr),
        'thumbnail=24',
        'split[a][b]',
      ].join(',');
      args = [
        '-ss',
        at.toFixed(3),
        '-i',
        entry.path,
        '-filter_complex',
        `[0:v:0]${picture};` +
          `[a]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=30:2,eq=brightness=-0.22:saturation=0.8[back];` +
          `[b]scale=${width}:${height}:force_original_aspect_ratio=decrease[front];` +
          `[back][front]overlay=(W-w)/2:(H-h)/2:format=yuv444[out]`,
        '-map',
        '[out]',
      ];
    }
    const png = kind === 'logo';
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.closing.signal]);
    let bytes;
    try {
      bytes = await tools.run(
        tools.ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          ...args,
          '-an',
          '-sn',
          '-dn',
          '-frames:v',
          '1',
          ...(png ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj444p']),
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        signal,
        TIMEOUT_MS,
        MAX_PICTURE,
      );
    } catch {
      this.logger?.debug?.('Local', `No ${kind} picture could be made for "${entry.title}"`);
      throw unavailable();
    }
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw unavailable();
    await this.save(cached, bytes).catch(error =>
      this.logger?.warn('Local', `Local pictures could not be saved (${error.code || error.message})`),
    );
    return bytes;
  }
  async save(cached, bytes) {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = cached + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, cached);
    if (++this.written % 20 === 1) await this.trim();
  }
  /** Keep the folder under CACHE_BYTES, removing the pictures shown least recently. */
  async trim(limit = CACHE_BYTES) {
    const names = await fs.readdir(this.directory).catch(() => []);
    const files = [];
    for (const name of names) {
      if (!/^[0-9a-f]{32}\.(?:jpg|png)$/.test(name)) continue;
      const stat = await fs.stat(path.join(this.directory, name)).catch(() => undefined);
      if (stat) files.push({ name, size: stat.size, at: stat.mtimeMs });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.at - b.at)) {
      if (total <= limit) break;
      await fs.unlink(path.join(this.directory, file.name)).catch(() => {});
      total -= file.size;
    }
  }
  close() {
    this.closing.abort();
  }
}

module.exports = { LocalArt, SIZES };
