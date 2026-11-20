'use strict';
// @ts-check
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { classifyHdr, cpuTonemap } = require('../../media-tools');

/** Picture sizes (width, height), the same as Plex's, so local tiles look like the others. */
const SIZES = { poster: [300, 450], landscape: [400, 225], backdrop: [1280, 720], logo: [720, 280] };
const MAX_PICTURE = 3 * 1024 * 1024,
  CACHE_BYTES = 256 * 1024 * 1024,
  AT_ONCE = 2,
  TIMEOUT_MS = 30000,
  // Raise when the pictures made from the same source change, so old ones are not served.
  VERSION = 2;
/** Where frames are looked for, as parts of the running time: early, so a picture never gives the film away. */
const MOMENTS = [0.05, 0.1, 0.15, 0.2];
const unavailable = () => Object.assign(new Error('Artwork unavailable'), { status: 404 });

/**
 * Pictures for local videos, made with FFmpeg and kept in a folder of the data directory,
 * never beside the media. A picture file beside the video (`poster.jpg`, `Film-fanart.jpg`)
 * is used when there is one; otherwise a frame from early in the video: FFmpeg's thumbnail
 * filter picks one from half a second at each of 5%, 10%, 15% and 20% of the running time
 * (never later, so nothing is spoiled), and the brightest, most detailed of the four is
 * used, since an early scene is often dark. HDR frames are tone-mapped. A frame that does not fit the picture's shape
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
      const frame = await this.frame(entry, source, tools);
      // A frame that does not fit the picture's shape sits whole on a blurred, lightly darkened copy of itself.
      args = [
        '-i',
        frame,
        '-filter_complex',
        `[0:v:0]split[a][b];` +
          `[a]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=30:2,eq=brightness=-0.1:saturation=0.85[back];` +
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
  /**
   * The video's frame for its pictures, kept in the picture folder so every kind is made from the same one
   * without reading the video again. @returns {Promise<string>} The frame's file.
   */
  async frame(entry, source, tools) {
    const key = createHash('sha256')
      .update([VERSION, entry.token, 'frame', entry.path, source.stat.size, source.stat.mtimeMs].join('\n'))
      .digest('hex')
      .slice(0, 32);
    const file = path.join(this.directory, key + '.jpg');
    if (
      await fs.stat(file).then(
        stat => stat.size > 0,
        () => false,
      )
    )
      return file;
    let making = this.making.get(key);
    if (!making) {
      making = this.choose(entry, source.info, tools).then(async bytes => {
        await this.save(file, bytes);
        return bytes;
      });
      this.making.set(key, making);
      making.finally(() => this.making.delete(key)).catch(() => {});
    }
    await making;
    return file;
  }
  /**
   * The best of four early frames, as a JPEG at most 1280 wide: the brightest and most detailed, since an early
   * scene is often dark. Candidates are written as BMPs to a temporary folder to be scored, then removed.
   * @returns {Promise<Buffer>}
   */
  async choose(entry, info, tools) {
    const video = info.streams?.find(stream => stream.codec_type === 'video');
    if (!video?.width || !video?.height) throw unavailable();
    const hdr = classifyHdr(video);
    // Dolby Vision Profile 5 has no picture zscale can tone-map; a wrong-colored frame is worse than none.
    if (hdr.doviP5) throw unavailable();
    const duration = Number(info.duration) || 0;
    const moments = duration > 0 ? MOMENTS.map(part => duration * part) : [0];
    // Shrunk first: the thumbnail filter holds its frames in memory, and tone-mapping a small picture is quick.
    const prepare = [
      'scale=iw*sar:ih',
      'setsar=1',
      "scale=w='min(1280,iw)':h=-2",
      ...cpuTonemap(hdr),
      'trim=end_frame=12',
      'thumbnail=12',
      'format=bgr24',
    ].join(',');
    const signal = () => AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.closing.signal]);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uburoom-frame-'));
    try {
      // One moment at a time: decoding four 4K streams at once needs more memory than a picture is worth.
      for (const [index, at] of moments.entries())
        await tools
          .run(
            tools.ffmpeg,
            [
              '-v',
              'error',
              '-nostdin',
              '-ss',
              at.toFixed(3),
              '-t',
              '1',
              '-i',
              entry.path,
              '-map',
              '0:v:0',
              '-vf',
              prepare,
              '-frames:v',
              '1',
              '-f',
              'image2',
              path.join(directory, index + '.bmp'),
            ],
            signal(),
            TIMEOUT_MS,
          )
          // A moment that cannot be read leaves the others to choose from.
          .catch(() => {});
      const scored = [];
      for (const name of await fs.readdir(directory)) {
        const file = path.join(directory, name);
        const score = frameScore(await fs.readFile(file));
        if (score !== undefined) scored.push({ file, score });
      }
      if (!scored.length) throw unavailable();
      const best = scored.sort((a, b) => b.score - a.score)[0].file;
      const bytes = await tools.run(
        tools.ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          '-i',
          best,
          '-c:v',
          'mjpeg',
          '-q:v',
          '2',
          '-pix_fmt',
          'yuvj444p',
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        signal(),
        TIMEOUT_MS,
        MAX_PICTURE,
      );
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw unavailable();
      return bytes;
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
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
  /** Stop making pictures; resolves once any being made have ended, so nothing still holds a file. */
  async close() {
    this.closing.abort();
    await Promise.allSettled([...this.making.values()]);
  }
}

/**
 * How good a frame is to show: its average brightness plus its contrast, from an uncompressed 24-bit BMP, so a
 * lit scene with something in it beats both a black frame and a flat grey one. Undefined for anything else.
 * @param {Buffer} bytes
 */
function frameScore(bytes) {
  if (bytes.length < 54 || bytes.toString('latin1', 0, 2) !== 'BM' || bytes.readUInt16LE(28) !== 24) return;
  const offset = bytes.readUInt32LE(10),
    width = bytes.readInt32LE(18),
    height = Math.abs(bytes.readInt32LE(22));
  const row = Math.ceil((width * 3) / 4) * 4;
  if (width <= 0 || !height || offset + row * height > bytes.length) return;
  let sum = 0,
    squares = 0,
    count = 0;
  // Every fourth pixel of every fourth row is plenty to tell a dark frame from a lit one.
  for (let y = 0; y < height; y += 4)
    for (let x = 0; x < width; x += 4) {
      const at = offset + y * row + x * 3;
      const luma = 0.114 * bytes[at] + 0.587 * bytes[at + 1] + 0.299 * bytes[at + 2];
      sum += luma;
      squares += luma * luma;
      count++;
    }
  const mean = sum / count;
  return mean + Math.sqrt(Math.max(0, squares / count - mean * mean));
}

module.exports = { LocalArt, SIZES, frameScore };
