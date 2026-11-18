// @ts-check
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { PlaybackError } = require('./errors');
const { run } = require('./media-tools');

/**
 * Keeps a file's picture and converts only its sound: the video stream is copied
 * untouched into fragmented-MP4 HLS and one chosen audio track becomes stereo AAC.
 * It serves a video whose picture the browser can decode but whose sound it cannot,
 * or one with several audio tracks, for providers that have no transcoder of their own.
 *
 * A copied stream can only be cut at its own keyframes, so a session first finds
 * where they are by seeking through the container's index, a few probes at once,
 * and those become the playlist's segments. They are remembered per file. FFmpeg then runs as one continuous
 * process from the segment a viewer asks for; its output is split here at the same
 * boundaries. It keeps the source's timestamps, so every run lands on one timeline.
 * FFmpeg is held back by not reading its output once it is far enough ahead.
 */

const ORIGIN = 'http://remux.uburoom.invalid';
// Seconds between the seeks that find segment boundaries. Through the byte bridge every seek
// reads about a megabyte ahead, so it seeks half as often there and splits the work.
const STEP = { local: 6, bridged: 12 };
const SEARCHES = { local: 1, bridged: 6 };
const REMEMBERED = 20; // Files whose boundaries are kept.
const AHEAD = 8; // Segments produced beyond the newest one asked for.
const BEHIND = 6; // Segments kept behind the oldest recent request.
const MAX_SEGMENTS = 64;
const IDLE_MS = 45000;
const TIMESCALE = 90000;
const COPYABLE = /^(h264|avc1|hevc|h265|hvc1|hev1)$/i;
// Segments are written under one folder per server process. A server that is killed rather
// than shut down cannot remove its own, so each start removes those of processes that are gone.
const ROOT = path.join(os.tmpdir(), 'uburoom-remux');

/** Remove the segment folders of server processes that no longer run. */
function sweep() {
  let entries = [];
  try {
    entries = fs.readdirSync(ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // Still running, possibly another uburoom on this machine.
    } catch (error) {
      if (error.code === 'EPERM') continue;
    }
    fs.rm(path.join(ROOT, name), { recursive: true, force: true }, () => {});
  }
}

const failure = message => new PlaybackError(message);

/** Top-level MP4 boxes from a growing byte stream. */
class Boxes {
  constructor() {
    this.pending = Buffer.alloc(0);
  }
  /** @returns {{type: string, bytes: Buffer}[]} */
  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const boxes = [];
    for (;;) {
      if (this.pending.length < 8) break;
      let size = this.pending.readUInt32BE(0);
      if (size === 1) {
        if (this.pending.length < 16) break;
        size = Number(this.pending.readBigUInt64BE(8));
      }
      if (size < 8) throw failure('The copied stream is malformed.');
      if (this.pending.length < size) break;
      boxes.push({ type: this.pending.toString('latin1', 4, 8), bytes: this.pending.subarray(0, size) });
      this.pending = this.pending.subarray(size);
    }
    return boxes;
  }
}

/** When the video track's fragment starts decoding, in seconds; undefined when it holds no video. */
function fragmentTime(moof) {
  const children = (bytes, from) => {
    const list = [];
    for (let at = from; at + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(at);
      if (size < 8 || at + size > bytes.length) break;
      list.push({ type: bytes.toString('latin1', at + 4, at + 8), bytes: bytes.subarray(at, at + size) });
      at += size;
    }
    return list;
  };
  for (const traf of children(moof, 8).filter(box => box.type === 'traf')) {
    const parts = children(traf.bytes, 8),
      header = parts.find(box => box.type === 'tfhd'),
      time = parts.find(box => box.type === 'tfdt');
    // The video is mapped first, so it is track 1.
    if (!header || !time || header.bytes.readUInt32BE(12) !== 1) continue;
    return (time.bytes[8] === 1 ? Number(time.bytes.readBigUInt64BE(12)) : time.bytes.readUInt32BE(12)) / TIMESCALE;
  }
}

class RemuxSession {
  /** @param {Remux} owner @param {string} key @param {any} source @param {any} audio */
  constructor(owner, key, source, audio) {
    this.owner = owner;
    this.key = key;
    this.id = randomUUID();
    this.source = source;
    this.audio = audio;
    this.users = 0;
    this.closed = false;
    this.directory = path.join(ROOT, String(process.pid), this.id);
    /** @type {Map<number, {file: string, size: number}>} */
    this.segments = new Map();
    /** @type {Map<number, {resolve: Function, reject: Function}[]>} */
    this.waiters = new Map();
    this.cursors = new Map();
    this.opening = new Map();
    this.runs = new Set();
    this.requested = 0;
    this.requestedAt = Date.now();
    this.abort = new AbortController();
    this.initWaiters = [];
    /** @type {Buffer | undefined} The stream's initialization segment, the same for every run. */
    this.init = undefined;
    /** @type {number[]} Where each segment starts. */
    this.boundaries = [];
    /** @type {any} The FFmpeg run in progress. */
    this.run = undefined;
    /** @type {any} */
    this.idle = undefined;
    this.ready = this.prepare();
    this.ready.catch(() => {});
  }
  get url() {
    return `${ORIGIN}/${this.id}/index.m3u8`;
  }
  async prepare() {
    await fs.promises.mkdir(this.directory, { recursive: true });
    this.boundaries = await this.owner.boundaries(this.source, this.abort.signal);
  }
  playlist() {
    const starts = this.boundaries,
      lengths = starts.map((at, i) => (i + 1 < starts.length ? starts[i + 1] : this.source.duration) - at);
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...lengths)),
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MAP:URI="init.mp4"',
      ...lengths.flatMap((length, i) => ['#EXTINF:' + Math.max(0.001, length).toFixed(3) + ',', `seg-${i}.m4s`]),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
  }
  /** The segment a fragment belongs to: boundaries are picture times, a fragment's is its earlier decode time. */
  locate(time) {
    let low = 0,
      high = this.boundaries.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.boundaries[middle] - 0.5 <= time) low = middle;
      else high = middle - 1;
    }
    return low;
  }
  /** Start FFmpeg at a segment, replacing any run in progress. */
  start(index) {
    if (this.closed) return;
    this.stop();
    // The new run cannot produce earlier segments. Let their callers retry now.
    const skipped = Object.assign(failure('The copied stream moved; retry this segment.'), { status: 503 });
    for (const [pending, list] of this.waiters)
      if (pending < index) {
        this.waiters.delete(pending);
        for (const waiter of list) waiter.reject(skipped);
      }
    const { av1 } = this.owner,
      controller = new AbortController(),
      run = (this.run = /** @type {any} */ ({
        id: randomUUID(),
        first: index,
        head: index,
        controller,
        paused: false,
      }));
    const hevc = !/^(h264|avc1)$/i.test(this.source.videoCodec || '');
    const args = url => [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      // Seeking lands on a keyframe at or before this, which the fragments' own times reveal.
      ...(index ? ['-ss', String(this.boundaries[index] + 0.05)] : []),
      '-copyts',
      '-i',
      url,
      '-map',
      '0:v:0',
      ...(this.audio ? ['-map', '0:a:' + (this.audio.ordinal ?? 0)] : ['-an']),
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-c:v',
      'copy',
      ...(hevc ? ['-tag:v', 'hvc1'] : []),
      ...(this.audio ? ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k'] : []),
      '-video_track_timescale',
      String(TIMESCALE),
      // Keep the film's own times in every fragment, so every run lands on one timeline.
      '-avoid_negative_ts',
      'disabled',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof+frag_discont',
      'pipe:1',
    ];
    run.done = this.owner
      .open(this.source, controller.signal, url => this.produce(run, args(url)))
      .catch(error => {
        if (controller.signal.aborted) return;
        av1.logger?.warn?.('Remux', `Copying "${this.source.title}" failed: ${String(error.message || error)}`);
        const reason = error instanceof PlaybackError ? error : failure('The video could not be copied.');
        for (const list of this.waiters.values()) for (const waiter of list) waiter.reject(reason);
        this.waiters.clear();
        for (const waiter of this.initWaiters.splice(0)) waiter.reject(reason);
      })
      .finally(() => {
        this.runs.delete(run.done);
        if (this.run === run) this.run = undefined;
      });
    this.runs.add(run.done);
  }
  produce(run, args) {
    return new Promise((resolve, reject) => {
      const child = (run.child = spawn(this.owner.av1.ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      const boxes = new Boxes(),
        init = [];
      let moof,
        collecting,
        parts = [],
        stderr = '',
        writing = Promise.resolve();
      const flush = () => {
        if (collecting === undefined || !parts.length) return;
        const index = collecting,
          bytes = Buffer.concat(parts);
        parts = [];
        writing = writing.then(() => this.store(run, index, bytes));
      };
      const kill = () => child.kill('SIGKILL');
      run.controller.signal.addEventListener('abort', kill, { once: true });
      child.stderr.on('data', data => {
        if (stderr.length < 2000) stderr += data;
      });
      child.stdout.on('data', chunk => {
        try {
          for (const box of boxes.push(chunk)) {
            if (box.type === 'ftyp' || box.type === 'moov') {
              init.push(Buffer.from(box.bytes));
              if (box.type === 'moov') this.setInit(Buffer.concat(init));
            } else if (box.type === 'moof') moof = Buffer.from(box.bytes);
            else if (box.type === 'mdat' && moof) {
              const time = fragmentTime(moof),
                index = time === undefined ? collecting : this.locate(time);
              if (index !== undefined && run.landed === undefined) {
                run.landed = index;
                // A seek that passed the segment asked for cannot fill it: begin earlier.
                if (index > run.first && run.first > 0) {
                  const earlier = Math.max(0, run.first - 1);
                  queueMicrotask(() => {
                    if (this.run === run && !run.controller.signal.aborted) this.start(earlier);
                  });
                  return;
                }
              }
              if (index !== undefined && index >= run.first - 1) {
                if (index !== collecting) {
                  flush();
                  collecting = index;
                }
                parts.push(moof, Buffer.from(box.bytes));
              }
              moof = undefined;
            }
          }
        } catch (error) {
          kill();
          reject(error);
        }
      });
      child.on('error', reject);
      child.on('close', code => {
        run.controller.signal.removeEventListener('abort', kill);
        if (run.controller.signal.aborted) return void writing.then(resolve, reject);
        if (code !== 0) return reject(failure('FFmpeg could not copy this video: ' + stderr.trim().slice(0, 300)));
        // The source ended, so the segment being collected is whole.
        flush();
        writing.then(resolve, reject);
      });
    });
  }
  setInit(bytes) {
    this.init ||= bytes;
    for (const waiter of this.initWaiters.splice(0)) waiter.resolve(this.init);
  }
  async store(run, index, bytes) {
    if (this.closed || run.controller.signal.aborted) return;
    if (this.segments.has(index)) {
      run.head = index + 1;
      this.pace();
      return;
    }
    const file = path.join(this.directory, `seg-${index}-${run.id}.m4s`);
    await fs.promises.writeFile(file, bytes);
    if (this.closed || run.controller.signal.aborted) return void fs.promises.rm(file, { force: true }).catch(() => {});
    this.segments.set(index, { file, size: bytes.length });
    run.head = index + 1;
    for (const waiter of this.waiters.get(index) || []) waiter.resolve();
    this.waiters.delete(index);
    this.pace();
  }
  /** Hold FFmpeg once it is far enough ahead of what viewers ask for, and drop what is far behind. */
  pace() {
    const run = this.run;
    const now = Date.now();
    for (const [lease, cursor] of this.cursors) if (now - cursor.at > IDLE_MS) this.cursors.delete(lease);
    const cursors = [...this.cursors.values()].map(cursor => cursor.index);
    const requests = [...cursors, ...this.waiters.keys()];
    const newest = requests.length ? Math.max(...requests) : this.requested;
    const oldest = requests.length ? Math.min(...requests) : this.requested;
    if (run?.child) {
      const far = run.head > newest + AHEAD;
      if (far && !run.paused) run.child.stdout.pause();
      else if (!far && run.paused) run.child.stdout.resume();
      run.paused = far;
    }
    const drop = index => {
      const segment = this.segments.get(index);
      if (segment) {
        this.segments.delete(index);
        void fs.promises.rm(segment.file, { force: true }).catch(() => {});
      }
    };
    for (const index of this.segments.keys())
      if (index !== 0 && !this.opening.has(index) && (index < oldest - BEHIND || index > newest + AHEAD * 2))
        drop(index);
    // Widely separated viewers cannot retain an entire film between them.
    const distance = index =>
      Math.min(...(cursors.length ? cursors : [this.requested]).map(at => Math.abs(index - at)));
    const expendable = [...this.segments.keys()]
      .filter(index => index !== 0 && !this.opening.has(index))
      .sort((a, b) => distance(b) - distance(a));
    while (this.segments.size > MAX_SEGMENTS && expendable.length) drop(expendable.shift());
  }
  stop() {
    this.run?.controller.abort();
    this.run = undefined;
  }
  touch() {
    this.requestedAt = Date.now();
    clearTimeout(this.idle);
    // Nobody is fetching: stop converting, but keep what is on disk for their return.
    this.idle = setTimeout(() => {
      this.stop();
      const reason = failure('The copied stream is idle; retry the request.');
      for (const list of this.waiters.values()) for (const waiter of list) waiter.reject(reason);
      this.waiters.clear();
      for (const waiter of this.initWaiters.splice(0)) waiter.reject(reason);
    }, IDLE_MS);
    this.idle.unref?.();
  }
  async initSegment(signal) {
    await this.ready;
    if (this.init) return this.init;
    if (!this.run) this.start(this.requested);
    return this.wait(this.initWaiters, signal);
  }
  wait(list, signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = list.indexOf(waiter);
        if (index >= 0) list.splice(index, 1);
        reject(failure('The request was cancelled.'));
      };
      const waiter = {
        resolve: value => (signal?.removeEventListener('abort', cancel), resolve(value)),
        reject: error => (signal?.removeEventListener('abort', cancel), reject(error)),
      };
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      list.push(waiter);
    });
  }
  async segment(index, signal, lease = this) {
    await this.ready;
    if (this.closed) throw failure('This stream was replaced.');
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.boundaries.length) throw failure('Invalid segment.');
    // Every HLS viewer first needs the timestamp anchor, even when joining mid-film.
    if (index !== 0 && !this.segments.has(0)) {
      const anchor = await this.segment(0, signal, lease);
      await anchor.handle.close();
    }
    if (signal?.aborted) throw failure('The request was cancelled.');
    if (index !== 0 || !this.cursors.has(lease)) this.cursors.set(lease, { index, at: Date.now() });
    this.requested = index;
    this.touch();
    if (index !== 0 && !this.opening.has(index) && this.opening.size >= MAX_SEGMENTS - 1)
      throw Object.assign(failure('Too many copied segments are pending; retry shortly.'), { status: 503 });
    this.opening.set(index, (this.opening.get(index) || 0) + 1);
    try {
      if (!this.segments.has(index)) {
        const run = this.run;
        // A run reaches a segment only by producing every one before it.
        // One it already passed and has since dropped has to be produced again.
        if (!run || index < run.head || index > run.head + AHEAD) this.start(index);
        else this.pace();
        const list = this.waiters.get(index) || [];
        this.waiters.set(index, list);
        await this.wait(list, signal);
      }
      const segment = this.segments.get(index);
      if (!segment) throw failure('This segment is no longer available; retry.');
      const handle = await fs.promises.open(segment.file, 'r');
      if (signal?.aborted) {
        await handle.close();
        throw failure('The request was cancelled.');
      }
      return { ...segment, handle };
    } finally {
      const pending = this.opening.get(index) - 1;
      if (pending) this.opening.set(index, pending);
      else this.opening.delete(index);
      if (this.waiters.get(index)?.length === 0) this.waiters.delete(index);
      this.pace();
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.abort.abort();
    this.stop();
    const reason = failure('This stream was replaced.');
    for (const list of this.waiters.values()) for (const waiter of list) waiter.reject(reason);
    this.waiters.clear();
    for (const waiter of this.initWaiters.splice(0)) waiter.reject(reason);
    await Promise.all([...this.runs]);
    await fs.promises.rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }
}

class Remux {
  /** @param {any} av1 - The pipeline's FFmpeg tools and source bridge. */
  constructor(av1) {
    this.av1 = av1;
    sweep();
    /** @type {Map<string, RemuxSession>} */
    this.sessions = new Map();
    /** @type {Map<string, RemuxSession>} */
    this.byId = new Map();
    /** @type {Map<string, Promise<number[]>>} Segment boundaries by file. */
    this.known = new Map();
  }
  /**
   * Hand FFmpeg the source: the file itself when the provider says its bytes are a plain
   * local file, otherwise the pipeline's byte bridge, which keeps provider addresses and
   * credentials out of process arguments but reads well ahead on every seek.
   * @template T @param {any} source @param {AbortSignal} signal @param {(url: string, local: boolean) => Promise<T>} action
   */
  async open(source, signal, action) {
    const file = await source.provider?.filePath?.(source).catch(() => undefined);
    if (file) return action(file, true);
    return this.av1.input({ ...source, start: source.sourceStart }, signal, url => action(url, false));
  }
  /** Where a file's segments start: one seek per step, each reading the keyframe at or before it. */
  boundaries(source, signal) {
    const known = this.known.get(source.sourceKey);
    if (known) {
      this.known.delete(source.sourceKey);
      this.known.set(source.sourceKey, known);
      return known;
    }
    const av1 = this.av1,
      duration = source.duration;
    const search = async (from, share, step) => {
      const intervals = [];
      for (let at = from; at < Math.min(duration, from + share); at += step) intervals.push(at + '%+#2');
      if (!intervals.length) return [];
      const raw = await this.open(source, signal, (url, local) =>
        run(
          av1.ffprobe,
          [
            '-v',
            'error',
            // Through the bridge, one connection for every seek; a new one each time is several times slower.
            ...(local ? [] : ['-multiple_requests', '1']),
            '-select_streams',
            'v:0',
            '-show_entries',
            'packet=pts_time,flags',
            '-of',
            'csv=p=0',
            '-read_intervals',
            intervals.join(','),
            url,
          ],
          signal,
          120000,
          8 * 1024 * 1024,
        ),
      );
      return raw
        .toString()
        .split(/\r?\n/)
        .map(line => line.split(','))
        .filter(([time, flags]) => flags?.startsWith('K') && Number(time) >= 0 && Number(time) < duration)
        .map(([time]) => Number(time));
    };
    const job = (async () => {
      const way = (await source.provider?.filePath?.(source).catch(() => undefined)) ? 'local' : 'bridged',
        step = STEP[way],
        share = Math.ceil(duration / step / SEARCHES[way]) * step,
        searches = [];
      for (let from = 0; from < duration; from += share) searches.push(search(from, share, step));
      const found = [...new Set((await Promise.all(searches)).flat())].sort((a, b) => a - b);
      if (!found.length) throw failure('This video has no keyframes to copy from.');
      // Keyframes closer than a second would make needless tiny segments.
      return found.filter((at, i, all) => i === 0 || at - all[i - 1] >= 1);
    })();
    // A failed search is not remembered, so the next viewer tries again.
    job.catch(() => this.known.get(source.sourceKey) === job && this.known.delete(source.sourceKey));
    this.known.set(source.sourceKey, job);
    while (this.known.size > REMEMBERED) this.known.delete(this.known.keys().next().value);
    return job;
  }
  /** Whether this source's picture can be copied as it is. Dolby Vision profile 5 has no plain picture to copy. */
  available(media) {
    return (
      !!this.av1.ffmpeg &&
      !!this.av1.ffprobe &&
      COPYABLE.test(media?.videoCodec || '') &&
      media.sourceHdrKind !== 'dovi-p5' &&
      media.duration > 0 &&
      !!media.sourceStart
    );
  }
  /**
   * Join the copy of this source with this audio track, starting one if there is none.
   * The prepared media object becomes an HLS stream answered by this object.
   */
  async acquire(media, audio, shareKey) {
    const key = JSON.stringify([media.sourceKey, audio?.id ?? null, shareKey || null]);
    let session = this.sessions.get(key);
    if (!session) {
      session = new RemuxSession(
        this,
        key,
        { ...media, resources: undefined, subtitleAbort: undefined, remuxLease: undefined },
        audio,
      );
      this.sessions.set(key, session);
      this.byId.set(session.id, session);
    }
    session.users++;
    let released = false;
    const lease = {
      session,
      release: () => {
        if (released) return;
        released = true;
        session.cursors.delete(lease);
        session.pace();
        if (--session.users > 0) return;
        this.sessions.delete(key);
        this.byId.delete(session.id);
        return session.close();
      },
    };
    try {
      await session.ready;
    } catch (error) {
      await lease.release();
      throw error instanceof PlaybackError ? error : failure('This video could not be prepared for copying.');
    }
    media.format = 'hls';
    media.transcodeId = session.id;
    media.start = session.url;
    media.hlsProvider = {
      url: value => this.url(value),
      sessionHeaders: () => ({}),
      request: (value, options) => {
        if (released) throw failure('This stream was replaced.');
        return this.request(value, options, lease);
      },
    };
    media.audioCodec = audio ? 'aac' : undefined;
    media.remuxLease = lease;
    return lease;
  }
  /** Only this object's own addresses are ever resolved. */
  url(value) {
    const url = new URL(value, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error('Invalid copied-stream address');
    return url;
  }
  sessionHeaders() {
    return {};
  }
  /** Answers a playlist, the initialization segment or one segment, as a provider would. */
  /** @param {string} value @param {{signal?: AbortSignal, method?: string, [key: string]: any}} [options] */
  async request(value, { signal, method } = {}, lease = undefined) {
    const url = this.url(value),
      match = /^\/([a-f0-9-]{36})\/(index\.m3u8|init\.mp4|seg-(\d{1,7})\.m4s)$/.exec(url.pathname),
      session = match && this.byId.get(match[1]);
    if (!session) throw Object.assign(new Error('Copied stream unavailable'), { status: 410 });
    if (lease && lease.session !== session) throw failure('Invalid copied-stream lease.');
    if (match[2] === 'index.m3u8') {
      await session.ready;
      return new Response(session.playlist(), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (match[2] === 'init.mp4') {
      const bytes = await session.initSegment(signal);
      return new Response(method === 'HEAD' ? null : bytes, {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
      });
    }
    const segment = await session.segment(Number(match[3]), signal, lease);
    let body = null;
    if (method === 'HEAD') await segment.handle.close();
    else body = /** @type {any} */ (Readable.toWeb(segment.handle.createReadStream({ signal })));
    return new Response(body, {
      headers: { 'Content-Type': 'video/iso.segment', 'Content-Length': String(segment.size) },
    });
  }
  async close() {
    await Promise.all([...this.byId.values()].map(session => session.close()));
    await fs.promises.rm(path.join(ROOT, String(process.pid)), { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { Remux, Boxes, fragmentTime };
