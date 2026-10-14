'use strict';
// Six-second, on-demand WebM chunks. No episode download, background encoding,
// public upstream endpoint, CPU encoder fallback, or new service to deploy.
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { QUALITIES, qualityId } = require('../extension/engine');
const CHUNK = 6, MIME = 'video/webm; codecs="av01.0.12M.08"', AUDIO_MIME = 'audio/webm; codecs="opus"';
class PlaybackError extends Error {}

async function run(binary, args, signal, timeout = 30000, maxOutput = 1024 * 1024, diagnostic) {
  if (signal?.aborted) throw new PlaybackError('AV1 preparation cancelled.');
  const split = args.includes('pipe:3');
  const webm = args.includes('webm') && args.includes('pipe:1');
  let directory, files = [];
  try {
    if (webm) {
      // QSV (and libaom) may supply AV1 codec extradata only with the first
      // packet. WebM must seek back to finalize CodecPrivate; live stdout fails.
      // Only one bounded chunk is written, never a temporary episode download.
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'radtv-av1-'));
      files = ['video.webm', ...(split ? ['audio.webm'] : [])].map(name => path.join(directory, name));
      args = [...args];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'pipe:1') args[i] = files[0];
        else if (args[i] === 'pipe:3') args[i] = files[1];
        else if (args[i] === '-live') args[i + 1] = '0';
      }
    }
    const output = await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PlaybackError('AV1 preparation cancelled.'));
    const child = spawn(binary, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let size = 0, chunks = [], settled = false, failure, stderr = '', checking = false;
    const finish = (error, output) => {
      if (settled) return; settled = true; clearTimeout(timer); clearInterval(sizeCheck); signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(output);
    };
    // Wait for process close before rejecting, so cleanup can delete open files
    // on Windows and server shutdown can await it.
    const stop = error => { failure ||= error; child.kill(); };
    const cancel = () => stop(new PlaybackError('AV1 preparation cancelled.'));
    const timer = setTimeout(() => stop(new PlaybackError('AV1 encoder timed out. Check the server GPU/FFmpeg support.')), timeout);
    const sizeCheck = webm ? setInterval(async () => {
      if (checking || settled) return; checking = true;
      try {
        const sizes = await Promise.all(files.map(file => fs.stat(file).then(s => s.size, () => 0)));
        if (sizes.reduce((a,b) => a + b, 0) > maxOutput) stop(new PlaybackError('AV1 output exceeded the supported limit.'));
      } finally { checking = false; }
    }, 250) : undefined;
    signal?.addEventListener('abort', cancel, {once:true});
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > maxOutput) stop(new PlaybackError('AV1 output exceeded the supported limit.'));
      else chunks.push(bytes);
    });
    // Drain, but never log stderr: FFmpeg may print its input URL.
    if (diagnostic) child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16000); });
    else child.stderr.resume();
    child.on('error', () => finish(new PlaybackError('AV1 unavailable: configure an existing FFmpeg/FFprobe installation on the server.')));
    child.on('close', code => {
      diagnostic?.(code, stderr);
      finish(failure || (code === 0 ? null : new PlaybackError('AV1 hardware encoding/probing failed. Run the AV1 probe on the server; no CPU encoder was used.')), Buffer.concat(chunks));
    });
    });
    if (!webm) return output;
    const sizes = await Promise.all(files.map(file => fs.stat(file).then(s => s.size)));
    if (sizes.some(size => size < 100) || sizes.reduce((a,b) => a + b, 0) > maxOutput) throw new PlaybackError('AV1 output is empty or exceeded the supported limit.');
    const bytes = await Promise.all(files.map(file => fs.readFile(file)));
    return split ? {video:bytes[0],audio:bytes[1]} : bytes[0];
  } finally {
    if (directory) {
      await Promise.all(files.map(file => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
      await fs.rmdir(directory);
    }
  }
}

function encoderArgs() { return ['-c:v','av1_qsv','-preset','veryfast','-pix_fmt','nv12','-bf','0','-flags','+global_header']; }
async function probeEncoder(ffmpeg, signal, execute = run) {
  const output = await execute(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','testsrc2=size=320x180:rate=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.5', ...encoderArgs(), '-b:v','500k','-c:a','libopus','-ac','2','-f','webm','-live','1','pipe:1'], signal, 15000);
  if (output.length < 100) throw new PlaybackError('AV1 hardware probe produced no video.');
  return output;
}

function outputSpec(info, quality) {
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video || !(video.width > 0 && video.height > 0)) throw new PlaybackError('Original source has no readable video.');
  const q = QUALITIES.find(q => q.id === qualityId(quality));
  if (!q) throw new PlaybackError('Invalid AV1 quality.');
  const maxWidth = q.width || 3840, maxHeight = q.height || 2160;
  const ratio = Math.min(1, maxWidth / video.width, maxHeight / video.height);
  const width = Math.max(2, Math.floor(video.width * ratio / 2) * 2), height = Math.max(2, Math.floor(video.height * ratio / 2) * 2);
  const hdr = ['smpte2084','arib-std-b67'].includes(video.color_transfer);
  const filters = ['setpts=PTS-STARTPTS','fps=30'];
  if (hdr) filters.push('zscale=t=linear:npl=100','format=gbrpf32le','zscale=p=bt709','tonemap=tonemap=hable:desat=0','zscale=t=bt709:m=bt709:r=tv');
  filters.push(`scale=${width}:${height}:out_color_matrix=bt709`, 'format=nv12');
  const sourceBitrate = Number(info.format?.bit_rate) / 1000;
  const bitrate = q.bitrate || Math.min(40000, Math.max(2000, Number.isFinite(sourceBitrate) ? sourceBitrate : 12000));
  return { width, height, hdr, bitrate, filter:filters.join(','), audio:info.streams.some(s => s.codec_type === 'audio') };
}

class AV1 {
  constructor(plex, config, execute = run) {
    this.plex = plex; this.ffmpeg = config.ffmpegPath; this.jobs = new Set();
    this.run = (...args) => {
      const job = Promise.resolve().then(() => execute(...args)); this.jobs.add(job);
      job.finally(() => this.jobs.delete(job)).catch(() => {}); return job;
    };
    this.ffprobe = config.ffprobePath || (this.ffmpeg && path.join(path.dirname(this.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    this.groups = new Map(); this.inputs = new Map(); this.controllers = new Set(); this.queue = []; this.active = 0; this.closed = false;
  }
  acquire(source, quality) {
    if (!this.ffmpeg) throw new PlaybackError('AV1 unavailable: set FFMPEG_PATH after running the encoder probe on the server.');
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const key = source.id + ':' + qualityId(quality);
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= 8) throw new PlaybackError('AV1 is busy; close an unused player or choose a shared quality.');
      group = { key, source, quality, refs:0, chunks:new Map(), controllers:new Set(), bytes:0 };
      this.groups.set(key, group);
    }
    group.refs++;
    // Freshly authorized viewers may replace a departed viewer's source credential.
    group.source = source;
    return { group, released:false };
  }
  release(lease) {
    if (!lease || lease.released) return; lease.released = true;
    const group = lease.group;
    if (--group.refs > 0) return;
    this.groups.delete(group.key);
    for (const controller of group.controllers) controller.abort();
    group.chunks.clear(); group.bytes = 0;
  }
  async bridge() {
    if (this.bridgePromise) return this.bridgePromise;
    this.bridgePromise = (async () => {
      const server = this.server = http.createServer(async (req, res) => {
        const entry = this.inputs.get(req.url);
        if (!entry || entry.signal.aborted || !['GET','HEAD'].includes(req.method)) { res.writeHead(403); return res.end(); }
        const abort = new AbortController(), cancel = () => abort.abort();
        res.on('close', cancel); entry.signal.addEventListener('abort', cancel, {once:true});
        const timer = setTimeout(cancel, 30000);
        try {
          const response = await (entry.source.plexContext||this.plex).request(entry.source.start, { method:req.method, signal:abort.signal,
            headers:{Accept:'*/*', ...(req.headers.range ? {Range:req.headers.range} : {})} });
          const headers = {};
          for (const key of ['content-type','content-length','content-range','accept-ranges']) if (response.headers.has(key)) headers[key] = response.headers.get(key);
          res.writeHead(response.status, headers);
          if (req.method === 'HEAD') res.end(); else await pipeline(Readable.fromWeb(response.body), res);
        } catch { res.destroy(); }
        finally { clearTimeout(timer); entry.signal.removeEventListener('abort', cancel); }
      });
      server.requestTimeout = 30000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      if (this.closed) { server.close(); throw new PlaybackError('Server is shutting down.'); }
      server.unref(); return server.address().port;
    })();
    return this.bridgePromise;
  }
  async input(source, signal, action) {
    const port = await this.bridge(), key = '/' + randomBytes(24).toString('hex');
    // A short-lived loopback capability is visible in the process arguments;
    // the Plex URL/token is never passed to FFmpeg or FFprobe.
    this.inputs.set(key, {source, signal});
    try { return await action(`http://127.0.0.1:${port}${key}`); } finally { this.inputs.delete(key); }
  }
  async slot(signal, action) {
    if (signal.aborted) throw new PlaybackError('AV1 preparation cancelled.');
    if (this.active >= 2) {
      if (this.queue.length >= 12) throw new PlaybackError('AV1 encoder is busy.');
      await new Promise((resolve, reject) => {
        const entry = { resolve:() => { signal.removeEventListener('abort', cancel); resolve(); } };
        const cancel = () => { this.queue = this.queue.filter(x => x !== entry); reject(new PlaybackError('AV1 preparation cancelled.')); };
        signal.addEventListener('abort', cancel, {once:true}); this.queue.push(entry);
      });
    } else this.active++;
    try { if (signal.aborted) throw new PlaybackError('AV1 preparation cancelled.'); return await action(); }
    finally { const next = this.queue.shift(); if (next) next.resolve(); else this.active--; }
  }
  async chunk(lease, index, signal) {
    if (lease.released || this.closed) throw new PlaybackError('AV1 stream was replaced.');
    const group = lease.group, start = index * CHUNK;
    if (!Number.isSafeInteger(index) || index < 0 || start >= group.source.duration) throw new PlaybackError('Invalid AV1 chunk.');
    if (group.error) throw group.error;
    let entry = group.chunks.get(index);
    if (!entry) {
      const controller = new AbortController(); group.controllers.add(controller); this.controllers.add(controller);
      entry = { users:0, at:Date.now(), controller };
      entry.promise = this.slot(controller.signal, async () => {
        this.probePromise ||= probeEncoder(this.ffmpeg, this.shutdownSignal ||= (this.shutdownController = new AbortController()).signal, this.run);
        await this.probePromise;
        return this.input(group.source, controller.signal, async url => {
          if (!group.info) group.info = JSON.parse((await this.run(this.ffprobe, ['-v','error','-show_entries',
            'stream=codec_type,width,height,color_transfer:format=bit_rate','-of','json',url], controller.signal)).toString());
          const spec = outputSpec(group.info, group.quality);
          const args = ['-hide_banner','-loglevel','error','-nostdin','-threads','2','-ss',String(start),'-i',url];
          if (!spec.audio) args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
          const duration = String(Math.min(CHUNK, group.source.duration - start));
          args.push('-t',duration, '-map','0:v:0','-an',
            '-sn','-dn','-map_metadata','-1','-map_chapters','-1','-filter_threads','2','-vf',spec.filter,
            ...encoderArgs(),'-b:v',`${spec.bitrate}k`,'-maxrate',`${spec.bitrate}k`,'-bufsize',`${spec.bitrate * 2}k`,
            '-g','180','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
            '-f','webm','-live','1','-cluster_time_limit','1000','pipe:1',
            '-t',duration,'-map',spec.audio ? '0:a:0' : '1:a:0','-vn','-sn','-dn','-map_metadata','-1','-c:a','libopus','-b:a','128k','-ac','2','-ar','48000',
            '-af','asetpts=PTS-STARTPTS','-f','webm','-live','1','-cluster_time_limit','1000','pipe:3');
          return this.run(this.ffmpeg, args, controller.signal, 30000, 48 * 1024 * 1024);
        });
      }).then(bytes => {
        entry.bytes = bytes; entry.size = bytes.video.length + bytes.audio.length; group.bytes += entry.size; this.prune(group, entry); return bytes;
      }).catch(error => {
        group.chunks.delete(index);
        // Disconnection cancels this chunk, not everyone else's stream.
        if (!controller.signal.aborted) group.error = error instanceof PlaybackError ? error : new PlaybackError('AV1 source probing failed.');
        throw group.error || error;
      }).finally(() => { group.controllers.delete(controller); this.controllers.delete(controller); });
      // Caller disconnects can stop waiting without leaving an unhandled rejection.
      entry.promise.catch(() => {}); group.chunks.set(index, entry);
    }
    entry.at = Date.now(); entry.users++;
    try {
      return await new Promise((resolve, reject) => {
        const cancel = () => reject(new PlaybackError('AV1 client disconnected.'));
        if (signal.aborted) return cancel();
        signal.addEventListener('abort', cancel, {once:true});
        entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
    } finally {
      if (--entry.users === 0 && !entry.bytes) entry.controller.abort();
    }
  }
  prune(group, keep) {
    for (const [index, entry] of [...group.chunks].sort((a,b) => a[1].at - b[1].at)) {
      if (group.chunks.size <= 12 && group.bytes <= 128 * 1024 * 1024) break;
      if (entry !== keep && entry.bytes && !entry.users) { group.chunks.delete(index); group.bytes -= entry.size; }
    }
  }
  close() {
    this.closed = true; this.shutdownController?.abort();
    for (const controller of this.controllers) controller.abort();
    this.groups.clear(); this.inputs.clear(); this.server?.closeAllConnections(); this.server?.close();
    return Promise.allSettled([...this.jobs]);
  }
}
module.exports = { AV1, PlaybackError, CHUNK, MIME, AUDIO_MIME, probeEncoder, outputSpec, run };
