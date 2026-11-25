import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Track 2B Reference-Based Audiovisual Fidelity & Physical Presentation Loopback Suite.
 * - Computes ITU-R BT.2124 DeltaE_ITP across 0.05..4000 nits for SDR/HDR transfer curves.
 * - Optionally verifies local ffmpeg `libplacebo` reference images when available.
 * - Generates 30s 24fps/60fps optical+acoustic calibration MKV & analyzes stereo loopback WAV captures.
 */

const BT2020_LMS_M1 = [
  [1688 / 4096, 2146 / 4096, 262 / 4096],
  [683 / 4096, 2951 / 4096, 462 / 4096],
  [99 / 4096, 309 / 4096, 3688 / 4096],
];

const BT709_TO_BT2020 = [
  [0.627404, 0.329283, 0.043313],
  [0.069097, 0.91954, 0.011362],
  [0.016391, 0.088013, 0.895595],
];

const BT709_TO_P3 = [
  [0.822462, 0.177538, 0.0],
  [0.033194, 0.966806, 0.0],
  [0.017083, 0.072397, 0.91052],
];

function matMul3(m, [r, g, b]) {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
}

export function pqInverseEotf(nits) {
  const y = Math.max(0, nits / 10000);
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const ym = Math.pow(y, m1);
  return Math.pow((c1 + c2 * ym) / (1 + c3 * ym), m2);
}

export function pqEotfNits(v) {
  const x = Math.max(0, Math.min(1, v));
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const vp = Math.pow(x, 1 / m2);
  const num = Math.max(0, vp - c1);
  const den = c2 - c3 * vp;
  return 10000 * Math.pow(num / Math.max(1e-9, den), 1 / m1);
}

export function srgbOetf(c) {
  const x = Math.max(0, c);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function srgbEotf(v) {
  const x = Math.max(0, v);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function gamma22Oetf(c) {
  return Math.pow(Math.max(0, c), 1 / 2.2);
}

export function gamma22Eotf(v) {
  return Math.pow(Math.max(0, v), 2.2);
}

export function bt2100ICtCp(bt2020Nits) {
  const lms = matMul3(BT2020_LMS_M1, bt2020Nits);
  const lp = pqInverseEotf(lms[0]);
  const mp = pqInverseEotf(lms[1]);
  const sp = pqInverseEotf(lms[2]);
  const I = 0.5 * (lp + mp);
  const Ct = (6610 / 4096) * lp - (13613 / 4096) * mp + (7003 / 4096) * sp;
  const Cp = (17933 / 4096) * lp - (17390 / 4096) * mp - (543 / 4096) * sp;
  return [I, Ct, Cp];
}

export function deltaEItp(bt2020NitsA, bt2020NitsB) {
  const [i1, ct1, cp1] = bt2100ICtCp(bt2020NitsA);
  const [i2, ct2, cp2] = bt2100ICtCp(bt2020NitsB);
  const dI = i1 - i2;
  const dT = 0.5 * (ct1 - ct2);
  const dP = cp1 - cp2;
  return 720 * Math.sqrt(dI * dI + dT * dT + dP * dP);
}

export function bt2390EetfNits(srcNits, targetPeakNits = 203, srcMinNits = 0.005, targetMinNits = 0.05) {
  const e1 = (pqInverseEotf(srcNits) - pqInverseEotf(srcMinNits)) / (pqInverseEotf(4000) - pqInverseEotf(srcMinNits));
  const minLum =
    (pqInverseEotf(targetMinNits) - pqInverseEotf(srcMinNits)) / (pqInverseEotf(4000) - pqInverseEotf(srcMinNits));
  const maxLum =
    (pqInverseEotf(targetPeakNits) - pqInverseEotf(srcMinNits)) / (pqInverseEotf(4000) - pqInverseEotf(srcMinNits));
  const ks = 1.5 * maxLum - 0.5;
  const clamped = Math.max(0, Math.min(1, e1));
  let mapped = clamped;
  if (clamped >= ks && ks < 1) {
    const t = (clamped - ks) / (1 - ks);
    const h00 = 2 * t * t * t - 3 * t * t + 1;
    const h10 = t * t * t - 2 * t * t + t;
    const h01 = -2 * t * t * t + 3 * t * t;
    const h11 = t * t * t - t * t;
    mapped = h00 * ks + h10 * (1 - ks) + h01 * maxLum + h11 * 0;
  }
  const out = mapped + minLum * Math.pow(1 - mapped, 4);
  const pqOut = out * (pqInverseEotf(4000) - pqInverseEotf(srcMinNits)) + pqInverseEotf(srcMinNits);
  return pqEotfNits(pqOut);
}

export function runDeltaEOracleReport() {
  const sdrLevelsNits = [0.05, 0.2, 1.0, 5.0, 20.0, 50.0, 100.0, 203.0];
  const sdrComparisons = sdrLevelsNits.map(nits => {
    const lin = nits / 203.0;
    const ubuCodeword = gamma22Oetf(lin);
    const unmanagedPanelNits = gamma22Eotf(ubuCodeword) * 203.0;
    const colorSyncSrgbPanelNits = srgbEotf(ubuCodeword) * 203.0;
    const ref2020 = matMul3(BT709_TO_BT2020, [nits, nits, nits]);
    const unman2020 = matMul3(BT709_TO_BT2020, [unmanagedPanelNits, unmanagedPanelNits, unmanagedPanelNits]);
    const sync2020 = matMul3(BT709_TO_BT2020, [colorSyncSrgbPanelNits, colorSyncSrgbPanelNits, colorSyncSrgbPanelNits]);
    return {
      nits,
      gamma22OnUnmanagedPanelDeltaE: Number(deltaEItp(ref2020, unman2020).toFixed(2)),
      gamma22OnSrgbCompositorDeltaE: Number(deltaEItp(ref2020, sync2020).toFixed(2)),
    };
  });

  // SDR-on-HDR canvas (uInputMode == 0) analysis:
  // Writing linear BT.709 light directly vs extended-sRGB / display-p3-linear blowout check
  const midGrayLin = 0.18;
  const sdrMidGrayNits = midGrayLin * 203.0; // 36.54 nits
  const rawSrgbCodeword = srgbOetf(midGrayLin); // ~0.4614
  const srgbCodewordOnLinearCanvasNits = rawSrgbCodeword * 203.0; // ~93.66 nits (2.56x midtone blowout!)
  const rawLinWrittenToExtendedCanvasNits = srgbEotf(midGrayLin) * 203.0; // 0.18 treated as sRGB codeword -> 5.52 nits
  const p3Mapped = matMul3(BT709_TO_P3, [midGrayLin, midGrayLin, midGrayLin]);

  const hdrLevelsNits = [0.05, 1, 10, 100, 203, 1000, 4000];
  const hdrEetfPoints = hdrLevelsNits.map(nits => ({
    srcNits: nits,
    bt2390ToSdr203Nits: Number(bt2390EetfNits(nits, 203).toFixed(3)),
    bt2390ToHdr1000Nits: Number(bt2390EetfNits(nits, 1000).toFixed(3)),
  }));

  // FFmpeg libplacebo reference pixel check (1000-nit & 203-nit PQ patches -> BT.2390 SDR)
  let libplaceboCheck = { available: false };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubu-oracle-'));
  try {
    const pq1000 = Math.round(pqInverseEotf(1000) * 65535);
    const pq203 = Math.round(pqInverseEotf(203) * 65535);
    const makePatch = (val, file) => {
      const raw = Buffer.alloc(16 * 16 * 6);
      for (let i = 0; i < 16 * 16; i++) {
        raw.writeUInt16LE(val, i * 6);
        raw.writeUInt16LE(val, i * 6 + 2);
        raw.writeUInt16LE(val, i * 6 + 4);
      }
      const inPath = path.join(tmpDir, `${file}.rgb`);
      const outPath = path.join(tmpDir, `${file}_out.rgb`);
      fs.writeFileSync(inPath, raw);
      execFileSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb48le',
        '-s',
        '16x16',
        '-i',
        inPath,
        '-vf',
        'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=iec61966-2-1:format=rgb24',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        outPath,
      ]);
      const out = fs.readFileSync(outPath);
      return out[0] / 255;
    };
    const out1000 = makePatch(pq1000, 'p1000');
    const out203 = makePatch(pq203, 'p203');
    libplaceboCheck = {
      available: true,
      pq1000SdrCodeword: Number(out1000.toFixed(4)),
      pq203SdrCodeword: Number(out203.toFixed(4)),
    };
  } catch (err) {
    libplaceboCheck = { available: false, reason: err.message };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    sdrComparisons,
    sdrOnHdrMidGray: {
      expectedNits: Number(sdrMidGrayNits.toFixed(2)),
      srgbCodeword: Number(rawSrgbCodeword.toFixed(4)),
      rawLinearOnSrgbCanvasNits: Number(rawLinWrittenToExtendedCanvasNits.toFixed(2)),
      srgbCodewordOnLinearCanvasNits: Number(srgbCodewordOnLinearCanvasNits.toFixed(2)),
      srgbOnLinearBlowoutRatio: Number((srgbCodewordOnLinearCanvasNits / sdrMidGrayNits).toFixed(2)),
      p3Neutral: p3Mapped.map(v => Number(v.toFixed(4))),
    },
    hdrEetfPoints,
    libplaceboCheck,
  };
}

export function generateLoopbackMkv(outPath, { durationSec = 30, fps = 24 } = {}) {
  const sampleRate = 48000;
  const totalSamples = durationSec * sampleRate;
  const pcm = new Float32Array(totalSamples);
  // 1-cycle 2 kHz click at exact k * 1.000s (24 samples at 48 kHz)
  const clickLen = Math.round(sampleRate / 2000);
  for (let sec = 0; sec < durationSec; sec++) {
    const start = sec * sampleRate;
    for (let i = 0; i < clickLen && start + i < totalSamples; i++) {
      pcm[start + i] = 0.85 * Math.sin((2 * Math.PI * 2000 * i) / sampleRate);
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubu-loopgen-'));
  try {
    const wavPath = path.join(tmpDir, 'clicks.wav');
    writeWavMonoF32(wavPath, pcm, sampleRate);
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=640x360:r=${fps}:d=${durationSec}`,
      '-i',
      wavPath,
      '-vf',
      `drawbox=x=iw-128:y=0:w=128:h=128:color=white:t=fill:enable='eq(mod(n,${fps}),0)'`,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'flac',
      outPath,
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return outPath;
}

export function writeWavMonoF32(outPath, samples, sampleRate = 48000) {
  const buf = Buffer.alloc(44 + samples.length * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 4, 40);
  for (let i = 0; i < samples.length; i++) buf.writeFloatLE(samples[i], 44 + i * 4);
  fs.writeFileSync(outPath, buf);
}

export function analyzeStereoLoopbackWav(wavBuffer) {
  if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Invalid WAV header');
  const channels = wavBuffer.readUInt16LE(22);
  const sampleRate = wavBuffer.readUInt32LE(24);
  const bitsPerSample = wavBuffer.readUInt16LE(34);
  const format = wavBuffer.readUInt16LE(20);
  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= wavBuffer.length) {
    const id = wavBuffer.toString('ascii', offset, offset + 4);
    const size = wavBuffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size;
  }
  if (dataStart < 0) throw new Error('Missing WAV data chunk');
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataSize / (channels * bytesPerSample));
  const ch0 = new Float32Array(frames);
  const ch1 = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const base = dataStart + i * channels * bytesPerSample;
    const readSample = pos => {
      if (format === 3 && bitsPerSample === 32) return wavBuffer.readFloatLE(pos);
      if (bitsPerSample === 16) return wavBuffer.readInt16LE(pos) / 32768;
      return 0;
    };
    ch0[i] = readSample(base);
    ch1[i] = channels > 1 ? readSample(base + bytesPerSample) : 0;
  }

  const findRisingEdges = (arr, threshold = 0.25, minGapSamples = Math.round(sampleRate * 0.6)) => {
    const edges = [];
    let cooldown = 0;
    for (let i = 0; i < arr.length; i++) {
      if (cooldown > 0) {
        cooldown--;
        continue;
      }
      if (Math.abs(arr[i]) >= threshold) {
        edges.push(i / sampleRate);
        cooldown = minGapSamples;
      }
    }
    return edges;
  };

  const photoTimes = findRisingEdges(ch0);
  const micTimes = findRisingEdges(ch1);
  const offsetsMs = [];
  for (const pt of photoTimes) {
    let bestDiff = Infinity;
    for (const mt of micTimes) {
      const diff = (mt - pt) * 1000;
      if (Math.abs(diff) < Math.abs(bestDiff)) bestDiff = diff;
    }
    if (Math.abs(bestDiff) < 500) offsetsMs.push(bestDiff);
  }
  offsetsMs.sort((a, b) => a - b);
  const meanOffsetMs = offsetsMs.length ? offsetsMs.reduce((a, b) => a + b, 0) / offsetsMs.length : 0;
  const medianOffsetMs = offsetsMs.length ? offsetsMs[Math.floor(offsetsMs.length / 2)] : 0;

  const intervalsMs = [];
  for (let i = 1; i < photoTimes.length; i++) intervalsMs.push((photoTimes[i] - photoTimes[i - 1]) * 1000);
  const meanInterval = intervalsMs.length ? intervalsMs.reduce((a, b) => a + b, 0) / intervalsMs.length : 0;
  const jitterMs = intervalsMs.length
    ? Math.sqrt(intervalsMs.reduce((s, v) => s + (v - meanInterval) ** 2, 0) / intervalsMs.length)
    : 0;

  return {
    sampleRate,
    channels,
    photoPulses: photoTimes.length,
    micClicks: micTimes.length,
    matchedPairs: offsetsMs.length,
    meanAcousticMinusPhotonMs: Number(meanOffsetMs.toFixed(3)),
    medianAcousticMinusPhotonMs: Number(medianOffsetMs.toFixed(3)),
    cadenceJitterMs: Number(jitterMs.toFixed(3)),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--generate-loopback' && args[1]) {
    const fpsIdx = args.indexOf('--fps');
    const fps = fpsIdx > 0 ? Number(args[fpsIdx + 1]) || 24 : 24;
    generateLoopbackMkv(args[1], { fps });
    console.log(JSON.stringify({ generated: args[1], fps }));
    return;
  }
  if (args[0] === '--analyze-wav' && args[1]) {
    const report = analyzeStereoLoopbackWav(fs.readFileSync(args[1]));
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const report = runDeltaEOracleReport();
  console.log(JSON.stringify(report, null, 2));
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('ubuplayer-fidelity-oracle.mjs')
) {
  main();
}
