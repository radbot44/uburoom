'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PlaybackError } = require('./errors');
const { processMemory } = require('./process-memory');

// Startup-only discovery. Resolve an absolute executable so subprocesses do not
// depend on their working directory, shell aliases, or later PATH changes.
function findOnPath(name, environment = process.env, platform = process.platform) {
  const pathKey = Object.keys(environment).find(key =>
    platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH',
  );
  const executable = platform === 'win32' ? name + '.exe' : name;
  for (let directory of (environment[pathKey] || '').split(platform === 'win32' ? ';' : ':')) {
    directory = directory.trim().replace(/^"(.*)"$/, '$1');
    // Empty/relative entries can resolve tools from a caller's working folder.
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executable);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch {
      /* Continue to the next PATH directory; missing tools stay optional. */
    }
  }
}

async function run(
  binary,
  args,
  signal,
  timeout = 30000,
  maxOutput = 1024 * 1024,
  diagnostic,
  { memoryLimit = 1024 * 1024 * 1024, memory = processMemory, memoryInterval = 1000, outputComplete } = {},
) {
  if (signal?.aborted) throw new PlaybackError('WebM preparation cancelled.');
  const split = args.includes('pipe:3');
  const webm = args.includes('webm') && args.includes('pipe:1');
  let directory,
    files = [];
  try {
    if (webm) {
      // QSV (and libaom) may supply AV1 codec extradata only with the first
      // packet. WebM must seek back to finalize CodecPrivate; live stdout fails.
      // Only one bounded chunk is written, never a temporary episode download.
      directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'uburoom-av1-'));
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
      const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let size = 0,
        chunks = [],
        settled = false,
        failure,
        stderr = '',
        checking = false,
        checkingMemory = false,
        drainTimer,
        complete = false,
        exited = false;
      const finish = (error, output) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        clearInterval(sizeCheck);
        clearInterval(memoryCheck);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(output);
      };
      // Wait for process close before rejecting, so cleanup can delete open files
      // on Windows and server shutdown can await it.
      const stop = error => {
        failure ||= error;
        child.kill('SIGKILL');
      };
      const cancel = () => stop(new PlaybackError('WebM preparation cancelled.'));
      const timer = setTimeout(
        () => stop(new PlaybackError('WebM encoder timed out. Check the server GPU/FFmpeg support.')),
        timeout,
      );
      const sizeCheck = webm
        ? setInterval(async () => {
            if (checking || settled) return;
            checking = true;
            try {
              const sizes = await Promise.all(
                files.map(file =>
                  fsp.stat(file).then(
                    s => s.size,
                    () => 0,
                  ),
                ),
              );
              if (sizes.reduce((a, b) => a + b, 0) > maxOutput)
                stop(new PlaybackError('WebM output exceeded the supported limit.'));
            } finally {
              checking = false;
            }
          }, 250)
        : undefined;
      const memoryCheck = setInterval(async () => {
        if (checkingMemory || settled || exited || failure || !child.pid) return;
        checkingMemory = true;
        try {
          const rss = await memory(child.pid);
          if (!settled && !exited && !failure && rss > memoryLimit)
            stop(
              Object.assign(new PlaybackError('WebM process exceeded the server memory limit.'), { exitFailure: true }),
            );
        } catch {
          let alive = false;
          try {
            process.kill(child.pid, 0);
            alive = true;
          } catch (probeError) {
            alive = probeError?.code === 'EPERM';
          }
          if (alive && !settled && !exited && !failure && child.exitCode === null && child.signalCode === null) {
            stop(new PlaybackError('WebM process resource monitoring unavailable.'));
          }
        } finally {
          checkingMemory = false;
        }
      }, memoryInterval);
      signal?.addEventListener('abort', cancel, { once: true });
      child.stdout.on('data', bytes => {
        size += bytes.length;
        if (size > maxOutput) stop(new PlaybackError('WebM output exceeded the supported limit.'));
        else if (!failure) {
          chunks.push(bytes);
          try {
            if (outputComplete?.(bytes)) {
              complete = true;
              child.kill('SIGKILL');
            }
          } catch (error) {
            stop(error);
          }
        }
      });
      // Drain, but never log stderr: FFmpeg may print its input URL.
      // Retain a bounded private tail solely to classify encoder initialization
      // errors. Never expose it: it can contain an authenticated source URL.
      child.stderr.on('data', bytes => {
        stderr = (stderr + bytes.toString()).slice(-16000);
      });
      child.on('error', () =>
        finish(new PlaybackError('WebM unavailable: configure an existing FFmpeg/FFprobe installation on the server.')),
      );
      // An exited tool cannot keep shutdown waiting on inherited pipe handles.
      child.on('exit', () => {
        exited = true;
        clearInterval(memoryCheck);
        child.stdout.resume();
        child.stderr.resume();
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, 250);
      });
      child.on('close', code => {
        diagnostic?.(code, stderr);
        const encoderFailure =
          /(?:Error while opening encoder|Error initializing (?:output|an internal MFX)|No capable devices found|Cannot load (?:nvcuda|libcuda)|InitializeEncoder failed|unsupported device|MFX_ERR_UNSUPPORTED)/i.test(
            stderr,
          );
        finish(
          failure ||
            (code === 0 || complete
              ? null
              : Object.assign(
                  new PlaybackError(
                    'The configured video encoder/probe failed. Check the selected encoder and run the AV1 probe on the server.',
                  ),
                  { encoderFailure, exitFailure: true },
                )),
          Buffer.concat(chunks),
        );
      });
    });
    if (!webm) return output;
    const sizes = await Promise.all(files.map(file => fsp.stat(file).then(s => s.size)));
    if (sizes.some(size => size < 100) || sizes.reduce((a, b) => a + b, 0) > maxOutput)
      throw Object.assign(new PlaybackError('WebM output is empty or exceeded the supported limit.'), {
        exitFailure: true,
      });
    const bytes = await Promise.all(files.map(file => fsp.readFile(file)));
    return split ? { video: bytes[0], audio: bytes[1] } : bytes[0];
  } finally {
    if (directory) {
      await Promise.all(
        files.map(file =>
          fsp.unlink(file).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          }),
        ),
      );
      await fsp.rmdir(directory);
    }
  }
}

const STREAM_CODECS = {
  srt: 'subrip',
  vtt: 'webvtt',
  ssa: 'ass',
  pgs: 'hdmv_pgs_subtitle',
  vobsub: 'dvd_subtitle',
  dca: 'dts',
};
function codecMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if ((a === 'pcm' && b.startsWith('pcm')) || (b === 'pcm' && a.startsWith('pcm'))) return true;
  const ca = STREAM_CODECS[a] || a,
    cb = STREAM_CODECS[b] || b;
  return ca === cb;
}

// A provider's track list can be out of date for the file it serves. Its number counts only
// when the file agrees; otherwise the track is found by its order among its codec.
function fileIndex(rows = [], track, streams = [], type) {
  if (!rows.length || !streams.some(stream => stream.codec_name)) return track.index;
  const same = streams.filter(stream => stream.codec_type === type && codecMatches(track.codec, stream.codec_name));
  const at = streams.find(stream => stream.index === track.index);
  if (at?.codec_type === type && (codecMatches(track.codec, at.codec_name) || !same.length)) return track.index;
  const order = rows
    .filter(row => !row.external && codecMatches(track.codec, row.codec))
    .findIndex(row => row.id === track.id);
  if (!same[order])
    throw new PlaybackError(
      'This track is not in the video file. Refresh its metadata on the media server or choose another track.',
    );
  return same[order].index;
}

function stream(binary, args, signal, onChunk, { idleTimeout = 30000, maxOutput = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PlaybackError('Subtitle loading was cancelled.'));
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0,
      settled = false,
      failure,
      stderr = '',
      idleTimer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve();
    };
    const stop = error => {
      failure ||= error;
      child.kill('SIGKILL');
    };
    const cancel = () => stop(new PlaybackError('Subtitle loading was cancelled.'));
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(new PlaybackError('Subtitle extraction timed out. Try burn-in.')), idleTimeout);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    resetIdle();
    child.stdout.on('data', chunk => {
      resetIdle();
      size += chunk.length;
      if (size > maxOutput)
        stop(new PlaybackError('Subtitle resource or fonts exceeded the supported limits. Try burn-in.'));
      else if (!failure) onChunk?.(chunk);
    });
    child.stderr.on('data', bytes => {
      stderr = (stderr + bytes.toString()).slice(-16000);
    });
    child.on('error', () => finish(new PlaybackError('Subtitle extraction failed: FFmpeg unavailable on the server.')));
    child.on('close', code => {
      if (failure) return finish(failure);
      if (code !== 0)
        return finish(new PlaybackError('Subtitle extraction failed during media demuxing. Try burn-in.'));
      if (size === 0) return finish(new PlaybackError('Subtitle extraction produced no usable data. Try burn-in.'));
      finish(null);
    });
  });
}

function classifyHdr(video = {}) {
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  const dovi = sideData.find(
    entry => /dovi|dolby vision/i.test(entry?.side_data_type || '') || entry?.dv_profile !== undefined,
  );
  const dvProfile = Number(dovi?.dv_profile ?? video.DOVIProfile);
  const dvCompat = Number(dovi?.bl_signal_compatibility_id ?? video.DOVIBLCompatID);
  const hasDovi = Boolean(dovi || video.DOVIPresent || Number.isFinite(dvProfile));
  const transfer = String(video.color_transfer || video.colorTrc || video.colorTransfer || '').toLowerCase();
  if (hasDovi) {
    if (dvProfile === 5 || (dvCompat === 0 && !['smpte2084', 'arib-std-b67'].includes(transfer))) {
      return {
        hdr: true,
        kind: 'dovi-p5',
        label: 'Dolby Vision (Profile 5)',
        dovi: true,
        doviProfile: Number.isFinite(dvProfile) ? dvProfile : 5,
        doviCompat: Number.isFinite(dvCompat) ? dvCompat : 0,
        doviP5: true,
        transfer: 'smpte2084',
      };
    }
    if (dvCompat === 2 && !['smpte2084', 'arib-std-b67'].includes(transfer)) {
      const profile = Number.isFinite(dvProfile) ? dvProfile : 8;
      return {
        hdr: false,
        kind: 'dovi-sdr',
        label: `Dolby Vision (Profile ${profile}, SDR base)`,
        dovi: true,
        doviProfile: profile,
        doviCompat: 2,
        doviP5: false,
        transfer: 'bt709',
      };
    }
    if (transfer === 'arib-std-b67' || dvCompat === 4) {
      const profile = Number.isFinite(dvProfile) ? dvProfile : null;
      return {
        hdr: true,
        kind: 'dovi-hlg',
        label: profile !== null ? `Dolby Vision (Profile ${profile}, HLG base)` : 'Dolby Vision (HLG base)',
        dovi: true,
        doviProfile: profile,
        doviCompat: Number.isFinite(dvCompat) ? dvCompat : 4,
        doviP5: false,
        transfer: 'arib-std-b67',
      };
    }
    const profile = Number.isFinite(dvProfile) ? dvProfile : null;
    return {
      hdr: true,
      kind: 'dovi-hdr10',
      label: profile !== null ? `Dolby Vision (Profile ${profile}, HDR10 base)` : 'Dolby Vision',
      dovi: true,
      doviProfile: profile,
      doviCompat: Number.isFinite(dvCompat) ? dvCompat : 1,
      doviP5: false,
      transfer: 'smpte2084',
    };
  }
  if (transfer === 'smpte2084')
    return {
      hdr: true,
      kind: 'hdr10',
      label: 'HDR10',
      dovi: false,
      doviProfile: null,
      doviCompat: null,
      doviP5: false,
      transfer: 'smpte2084',
    };
  if (transfer === 'arib-std-b67')
    return {
      hdr: true,
      kind: 'hlg',
      label: 'HLG',
      dovi: false,
      doviProfile: null,
      doviCompat: null,
      doviP5: false,
      transfer: 'arib-std-b67',
    };
  return {
    hdr: false,
    kind: 'sdr',
    label: 'SDR',
    dovi: false,
    doviProfile: null,
    doviCompat: null,
    doviP5: false,
    transfer: transfer || 'bt709',
  };
}

/**
 * The CPU filters that turn an HDR picture into SDR BT.709, or none for SDR. Dolby Vision
 * Profile 5 uses proprietary IPTPQc2 color reshaping without an HDR10 base layer; CPU
 * zscale cannot decode IPTPQc2 and must use libplacebo, so it gets none here either.
 * @param {ReturnType<typeof classifyHdr>} hdrInfo
 */
function cpuTonemap(hdrInfo) {
  return hdrInfo.hdr && !hdrInfo.doviP5
    ? [
        `setparams=color_primaries=bt2020:color_trc=${hdrInfo.transfer}:colorspace=bt2020nc`,
        'zscale=t=linear:npl=100',
        'format=gbrpf32le',
        'zscale=p=bt709',
        'tonemap=tonemap=hable:desat=0',
        'zscale=t=bt709:m=bt709:r=tv',
      ]
    : [];
}

module.exports = { findOnPath, run, stream, codecMatches, fileIndex, classifyHdr, cpuTonemap };
