'use strict';
// Six-second, on-demand WebM chunks. No episode download, background encoding,
// public upstream endpoint or new service to deploy.
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { qualityDefinition, qualityId } = require('../shared/room-protocol');
const Playback = require('../web/playback-policy');
const CHUNK = Playback.BUFFER.chunkSeconds;
const { processMemory } = require('./process-memory');
const MIME = 'video/webm; codecs="av01.0.12M.08"', AUDIO_MIME = 'audio/webm; codecs="opus"';
class PlaybackError extends Error {}

async function run(binary, args, signal, timeout = 30000, maxOutput = 1024 * 1024, diagnostic, { memoryLimit = 1024 * 1024 * 1024, memory = processMemory, memoryInterval = 1000 } = {}) {
  if (signal?.aborted) throw new PlaybackError('WebM preparation cancelled.');
  const split = args.includes('pipe:3');
  const webm = args.includes('webm') && args.includes('pipe:1');
  let directory, files = [];
  try {
    if (webm) {
      // QSV (and libaom) may supply AV1 codec extradata only with the first
      // packet. WebM must seek back to finalize CodecPrivate; live stdout fails.
      // Only one bounded chunk is written, never a temporary episode download.
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uburoom-av1-'));
      files = ['video.webm', ...(split ? ['audio.webm'] : [])].map(name => path.join(directory, name));
      args = [...args];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'pipe:1') args[i] = files[0];
        else if (args[i] === 'pipe:3') args[i] = files[1];
        else if (args[i] === '-live') args[i + 1] = '0';
      }
    }
    const output = await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PlaybackError('WebM preparation cancelled.'));
    const child = spawn(binary, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let size = 0, chunks = [], settled = false, failure, stderr = '', checking = false, checkingMemory = false, drainTimer;
    const finish = (error, output) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(drainTimer); clearInterval(sizeCheck); clearInterval(memoryCheck); signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(output);
    };
    // Wait for process close before rejecting, so cleanup can delete open files
    // on Windows and server shutdown can await it.
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const cancel = () => stop(new PlaybackError('WebM preparation cancelled.'));
    const timer = setTimeout(() => stop(new PlaybackError('WebM encoder timed out. Check the server GPU/FFmpeg support.')), timeout);
    const sizeCheck = webm ? setInterval(async () => {
      if (checking || settled) return; checking = true;
      try {
        const sizes = await Promise.all(files.map(file => fs.stat(file).then(s => s.size, () => 0)));
        if (sizes.reduce((a,b) => a + b, 0) > maxOutput) stop(new PlaybackError('WebM output exceeded the supported limit.'));
      } finally { checking = false; }
    }, 250) : undefined;
    const memoryCheck = setInterval(async () => {
      if(checkingMemory||settled||failure||!child.pid)return;checkingMemory=true;
      try { if(await memory(child.pid)>memoryLimit)stop(new PlaybackError('WebM process exceeded the server memory limit.')); }
      catch { if(!settled&&!failure)stop(new PlaybackError('WebM process resource monitoring unavailable.')); }
      finally {checkingMemory=false;}
    },memoryInterval);
    signal?.addEventListener('abort', cancel, {once:true});
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > maxOutput) stop(new PlaybackError('WebM output exceeded the supported limit.'));
      else if(!failure)chunks.push(bytes);
    });
    // Drain, but never log stderr: FFmpeg may print its input URL.
    // Retain a bounded private tail solely to classify encoder initialization
    // errors. Never expose it: it can contain an authenticated source URL.
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16000); });
    child.on('error', () => finish(new PlaybackError('WebM unavailable: configure an existing FFmpeg/FFprobe installation on the server.')));
    // An exited tool cannot keep shutdown waiting on inherited pipe handles.
    child.on('exit',()=>{child.stdout.resume();child.stderr.resume();drainTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();},250);});
    child.on('close', code => {
      diagnostic?.(code, stderr);
      const encoderFailure=/(?:Error while opening encoder|Error initializing (?:output|an internal MFX)|No capable devices found|Cannot load (?:nvcuda|libcuda)|InitializeEncoder failed|unsupported device|MFX_ERR_UNSUPPORTED)/i.test(stderr);
      finish(failure || (code === 0 ? null : Object.assign(new PlaybackError('The configured video encoder/probe failed. Check the selected encoder and run the AV1 probe on the server.'),{encoderFailure})), Buffer.concat(chunks));
    });
    });
    if (!webm) return output;
    const sizes = await Promise.all(files.map(file => fs.stat(file).then(s => s.size)));
    if (sizes.some(size => size < 100) || sizes.reduce((a,b) => a + b, 0) > maxOutput) throw new PlaybackError('WebM output is empty or exceeded the supported limit.');
    const bytes = await Promise.all(files.map(file => fs.readFile(file)));
    return split ? {video:bytes[0],audio:bytes[1]} : bytes[0];
  } finally {
    if (directory) {
      await Promise.all(files.map(file => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
      await fs.rmdir(directory);
    }
  }
}

function encoderArgs(encoder = 'qsv', codec = 'av1') {
  if (!Playback.localFormat(codec)) throw new PlaybackError('Unknown local output codec.');
  if (encoder === 'software') {
    if (codec === 'av1') return ['-c:v','libsvtav1','-preset','10','-pix_fmt','yuv420p','-flags','+global_header'];
    return ['-c:v',codec === 'vp9'?'libvpx-vp9':'libvpx','-deadline','realtime','-cpu-used',codec === 'vp9'?'6':'8',
      '-threads','2','-lag-in-frames','0','-auto-alt-ref','0',...(codec==='vp9'?['-row-mt','1']:[]),'-pix_fmt','yuv420p'];
  }
  if (encoder === 'nvenc') {
    if(codec!=='av1')throw new PlaybackError('NVENC does not encode '+codec.toUpperCase()+'. Enable CPU fallback or choose another backend.');
    return ['-c:v','av1_nvenc','-preset','p4','-pix_fmt','yuv420p','-bf','0','-flags','+global_header'];
  }
  if(codec==='vp8')throw new PlaybackError('VP8 requires the software backend. Enable CPU fallback or select software.');
  return ['-c:v',codec==='vp9'?'vp9_qsv':'av1_qsv','-preset','veryfast','-pix_fmt','nv12','-bf','0','-flags','+global_header'];
}
async function probeEncoder(ffmpeg, signal, execute = run, encoder = 'hardware', codec = 'av1') {
  const output = await execute(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','testsrc2=size=320x180:rate=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.5', ...encoderArgs(encoder,codec), '-b:v','500k','-c:a','libopus','-ac','2','-f','webm','-live','1','pipe:1'], signal, 15000);
  if (output.length < 100) throw new PlaybackError('WebM hardware probe produced no video.');
  return output;
}

function outputSpec(info, quality) {
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video || !(video.width > 0 && video.height > 0)) throw new PlaybackError('Original source has no readable video.');
  const q = qualityDefinition(quality);
  if (!q) throw new PlaybackError('Invalid WebM quality.');
  const maxWidth = q.width || 3840, maxHeight = q.height || 2160;
  const ratio = Math.min(1, maxWidth / video.width, maxHeight / video.height);
  const width = Math.max(2, Math.floor(video.width * ratio / 2) * 2), height = Math.max(2, Math.floor(video.height * ratio / 2) * 2);
  const hdr = ['smpte2084','arib-std-b67'].includes(video.color_transfer);
  // Keep constant-rate source cadence. Forcing 30 fps duplicates film frames and
  // discards half of a 60 fps source, even when both decoder and encoder keep up.
  const filters = ['setpts=PTS-STARTPTS'];
  if (hdr) filters.push('zscale=t=linear:npl=100','format=gbrpf32le','zscale=p=bt709','tonemap=tonemap=hable:desat=0','zscale=t=bt709:m=bt709:r=tv');
  filters.push(`scale=${width}:${height}:out_color_matrix=bt709`, 'format=nv12');
  const sourceBitrate = Number(info.format?.bit_rate) / 1000;
  const bitrate = q.bitrate || Math.min(40000, Math.max(2000, Number.isFinite(sourceBitrate) ? sourceBitrate : 12000));
  // Carry the measured source rate through the encoder and WebM DefaultDuration.
  // Timestamp passthrough without packet durations creates MSE buffer holes on
  // some clients. This establishes CFR coverage; VFR timing needs separate tests.
  let frameRate;
  for (const rate of [video.r_frame_rate,video.avg_frame_rate]) {
    const match = /^(\d+)\/(\d+)$/.exec(rate || '');
    if (match && Number(match[2]) > 0 && Number(match[1])/Number(match[2]) > 0 && Number(match[1])/Number(match[2]) <= 240) {
      frameRate = rate; break;
    }
  }
  return { width, height, hdr, bitrate, frameRate, filter:filters.join(','), audio:info.streams.some(s => s.codec_type === 'audio') };
}

class AV1 {
  constructor(plex, config, execute = run) {
    this.plex = plex; this.ffmpeg = config.ffmpegPath; this.jobs = new Set();
    this.encoder = config.transcoding?.encoder || 'auto';
    this.cpuFallback = config.transcoding?.cpuFallback ?? true;
    this.maxActive = config.transcoding?.maxJobs || 2;
    this.run = (...args) => {
      const job = Promise.resolve().then(() => execute(...args)); this.jobs.add(job);
      job.finally(() => this.jobs.delete(job)).catch(() => {}); return job;
    };
    this.ffprobe = config.ffprobePath || (this.ffmpeg && path.join(path.dirname(this.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    this.groups = new Map(); this.inputs = new Map(); this.controllers = new Set(); this.queue = []; this.active = 0; this.closed = false;
  }
  async selectEncoder(codec = 'av1') {
    this.probePromises ||= new Map();
    if (!this.probePromises.has(codec)) {
      const promise = (async () => {
        const preferred = this.encoder === 'auto' || this.encoder === 'hardware' ? (codec==='av1'?['qsv','nvenc']:codec==='vp9'?['qsv']:[]) : [this.encoder];
        const candidates = [...new Set([...preferred,...(this.cpuFallback?['software']:[])])];
        if (!candidates.length) throw new PlaybackError(codec.toUpperCase()+' has no available hardware backend; enable CPU fallback or select software.');
        for (const encoder of candidates) {
          try {
            await probeEncoder(this.ffmpeg,this.shutdownSignal ||= (this.shutdownController = new AbortController()).signal,this.run,encoder,codec);
            return encoder;
          } catch (error) { if (this.closed || encoder === candidates.at(-1)) throw error; }
        }
      })().catch(error=>{this.probePromises.delete(codec);throw error;});
      this.probePromises.set(codec,promise);
    }
    return this.probePromises.get(codec);
  }
  acquire(source, quality, existingOnly = false, codec = 'av1') {
    if (!Playback.localFormat(codec)) throw new PlaybackError('Unknown local output codec.');
    if (!this.ffmpeg) throw new PlaybackError('WebM unavailable: install FFmpeg on the server PATH or set tools.ffmpeg in config.yaml, then run the encoder probe.');
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const scope=source.shareKey?[source.shareKey,source.sourceKey]:source.principal;
    const key = createHash('sha256').update(JSON.stringify([scope,source.id,source.partId,source.audioIndex,source.audioOrdinal,qualityId(quality),codec])).digest('hex');
    if(existingOnly && !this.groups.has(key))throw Object.assign(new PlaybackError('No matching shared output is available.'),{conversionCapacity:true});
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= 8) throw Object.assign(new PlaybackError('WebM is busy; close an unused player or choose a shared quality.'),{conversionCapacity:true});
      group = { key, source, quality, codec, refs:0, chunks:new Map(), controllers:new Set(), bytes:0 };
      this.groups.set(key, group);
    }
    group.refs++;
    // Each lease keeps its authorized source for future uncached chunk work.
    group.source = source;
    return { group, source, released:false };
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
    if (signal.aborted) throw new PlaybackError('WebM preparation cancelled.');
    if (this.active >= this.maxActive) {
      if (this.queue.length >= 12) throw new PlaybackError('WebM encoder is busy.');
      await new Promise((resolve, reject) => {
        const entry = { resolve:() => { signal.removeEventListener('abort', cancel); resolve(); } };
        const cancel = () => { this.queue = this.queue.filter(x => x !== entry); reject(new PlaybackError('WebM preparation cancelled.')); };
        signal.addEventListener('abort', cancel, {once:true}); this.queue.push(entry);
      });
    } else this.active++;
    try { if (signal.aborted) throw new PlaybackError('WebM preparation cancelled.'); return await action(); }
    finally { const next = this.queue.shift(); if (next) next.resolve(); else this.active--; }
  }
  async chunk(lease, index, signal) {
    if (lease.released || this.closed) throw new PlaybackError('WebM stream was replaced.');
    const group = lease.group, source=lease.source||group.source, start = index * CHUNK;
    if (!Number.isSafeInteger(index) || index < 0 || start >= source.duration) throw new PlaybackError('Invalid WebM chunk.');
    let entry = group.chunks.get(index);
    if (entry?.controller.signal.aborted && !entry.error) {
      group.chunks.delete(index); entry = undefined;
    }
    // Briefly memoize failures to collapse concurrent track/viewer requests.
    // A later bounded client retry must be able to recover a temporary Plex
    // outage; caching a rejected chunk forever makes that source time unusable.
    if (entry?.error && !entry.users && Date.now() - entry.failedAt >= 5000) {
      group.chunks.delete(index); entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController(); group.controllers.add(controller); this.controllers.add(controller);
      entry = { users:0, at:Date.now(), controller };
      entry.promise = this.slot(controller.signal, async () => {
        await this.conversionPolicy?.video('uburoom',group.codec);
        const releaseConversion=await this.conversionPolicy?.wait({signal:controller.signal});
        try {
        const codec = group.codec;
        const encoder = await this.selectEncoder(codec);
        return await this.input(source, controller.signal, async url => {
          if (!group.info) group.info = JSON.parse((await this.run(this.ffprobe, ['-v','error','-show_entries',
            'stream=index,codec_type,width,height,color_transfer,r_frame_rate,avg_frame_rate:format=bit_rate','-of','json',url], controller.signal)).toString());
          const spec = outputSpec(group.info, group.quality);
          const audioStreams = group.info.streams.filter(s=>s.codec_type==='audio');
          const selectedAudio = source.audioIndex !== undefined ? audioStreams.find(s=>s.index===source.audioIndex) : audioStreams[source.audioOrdinal ?? 0];
          if (spec.audio && !selectedAudio) throw new PlaybackError('The selected audio track is not present in the source.');
          const audioMap = source.audioIndex !== undefined ? '0:'+source.audioIndex : '0:a:'+(source.audioOrdinal ?? 0);
          const args = ['-hide_banner','-loglevel','error','-nostdin','-threads','2','-ss',String(start),'-i',url];
          if (!spec.audio) args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
          const duration = String(Math.min(CHUNK, source.duration - start));
          args.push('-t',duration, '-map','0:v:0','-an',
            '-sn','-dn','-map_metadata','-1','-map_chapters','-1','-filter_threads','2','-vf',spec.filter,
            ...encoderArgs(encoder,codec),'-b:v',`${spec.bitrate}k`,'-maxrate',`${spec.bitrate}k`,'-bufsize',`${spec.bitrate * 2}k`,
            ...(spec.frameRate ? ['-r',spec.frameRate,'-fps_mode','cfr'] : []),
            '-g','180','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
            '-f','webm','-live','1','-cluster_time_limit','1000','pipe:1',
            '-t',duration,'-map',spec.audio ? audioMap : '1:a:0','-vn','-sn','-dn','-map_metadata','-1','-c:a','libopus','-b:a','128k','-ac','2','-ar','48000',
            '-af','asetpts=PTS-STARTPTS','-f','webm','-live','1','-cluster_time_limit','1000','pipe:3');
          try {
            const bytes = await this.run(this.ffmpeg,args,controller.signal,30000,48*1024*1024);
            group.encoder=encoder;group.cpuFallback=encoder==='software'&&this.encoder!=='software'; return bytes;
          } catch (error) {
            // Retry only an encoder process failure, under the same job lease.
            // Cancellation, limits and upstream failures never trigger CPU work.
            if (!error.encoderFailure || encoder === 'software' || !this.cpuFallback || controller.signal.aborted) throw error;
            const first=args.indexOf('-c:v'),last=args.indexOf('-b:v',first);
            args.splice(first,last-first,...encoderArgs('software',codec));
            const bytes = await this.run(this.ffmpeg,args,controller.signal,30000,48*1024*1024);
            group.encoder='software'; group.cpuFallback=true; return bytes;
          }
        });
        } finally {releaseConversion?.();}
      }).then(bytes => {
        if (controller.signal.aborted || group.chunks.get(index)!==entry) throw new PlaybackError('WebM preparation cancelled.');
        entry.bytes = bytes; entry.size = bytes.video.length + bytes.audio.length; group.bytes += entry.size; this.prune(group, entry); return bytes;
      }).catch(error => {
        if (controller.signal.aborted) { if (group.chunks.get(index)===entry) group.chunks.delete(index); }
        else {
          // Keep failure local to this chunk and cool down before re-encoding.
          entry.error = error instanceof PlaybackError ? error : new PlaybackError('WebM chunk preparation failed.');
          entry.failedAt = Date.now();
          this.prune(group,entry);
        }
        throw entry.error || error;
      }).finally(() => { group.controllers.delete(controller); this.controllers.delete(controller); });
      // Caller disconnects can stop waiting without leaving an unhandled rejection.
      entry.promise.catch(() => {}); group.chunks.set(index, entry);
    }
    entry.at = Date.now(); entry.users++;
    try {
      return await new Promise((resolve, reject) => {
        const cancel = () => reject(new PlaybackError('WebM client disconnected.'));
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
      if (entry !== keep && (entry.bytes || entry.error) && !entry.users) { group.chunks.delete(index); group.bytes -= entry.size || 0; }
    }
  }
  close() {
    this.closed = true; this.shutdownController?.abort();
    for (const controller of this.controllers) controller.abort();
    this.groups.clear(); this.inputs.clear(); this.server?.closeAllConnections(); this.server?.close();
    return Promise.allSettled([...this.jobs]);
  }
}
module.exports = { AV1, PlaybackError, CHUNK, MIME, AUDIO_MIME, encoderArgs, probeEncoder, outputSpec, run };
