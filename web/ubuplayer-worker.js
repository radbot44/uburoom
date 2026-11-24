import LibAV from './vendor/libav/libav-uburoom.mjs';
import LibAVFactory from './vendor/libav/libav-6.11.9.0.2-uburoom.wasm.mjs';
import {
  computeTonemapUniforms,
  createDoviRpuContext,
  createOffscreenRenderer,
  inspectHevcPacket,
  parseDolbyVisionConfigRecord,
  parseDolbyVisionRpu,
  parseHevcColorMetadata,
  patchHevcSpsVuiToSdrFullRange,
  patchHvccForRawHdrDecode,
  wrapFramePreventingSdrClamp,
} from './ubuplayer-gpu.js';

export {
  computeTonemapUniforms,
  createDoviRpuContext,
  createOffscreenRenderer,
  inspectHevcPacket,
  parseDolbyVisionConfigRecord,
  parseDolbyVisionRpu,
  parseHevcColorMetadata,
  patchHevcSpsVuiToSdrFullRange,
  patchHvccForRawHdrDecode,
  wrapFramePreventingSdrClamp,
};

/* UbuPlayer Web Worker media engine:
 * - Packet-only container demuxing (MKV, MP4/MOV, WebM, MPEG-TS, AVI) via isolated AVFormatContexts
 *   for video, audio, and subtitles sharing one read-ahead block cache (zero fMP4 muxing, zero
 *   synthetic B-frame DTS, zero WASM FLAC/AAC re-encoding).
 * - Direct 48 kHz stereo Float32 PCM audio decode (with discrete 5.1/7.1 Dialogue Boost) streamed
 *   straight to UbuPlayer's AudioWorkletNode over a dedicated MessagePort.
 * - Hardware WebCodecs VideoDecoder + audio-paced OffscreenCanvas renderer (WebGPU with WebGL2
 *   fallback) implementing libplacebo-equivalent static-peak ITU-R BT.2390 tonemapping and
 *   Dolby Vision Profile 5/7/8 support.
 */

const BLOCK_SIZE = 1024 * 1024;
const MAX_CACHED_BLOCKS = 24;
const OUT_SAMPLE_RATE = 48000;
const OUT_CHANNEL_LAYOUT = 0x3; // AV_CH_LAYOUT_STEREO
const MAX_VIDEO_PACKET_BYTES = 96 * 1024 * 1024;
const MAX_DECODER_INFLIGHT = 18;
const MAX_AUDIO_AHEAD_SECONDS = 18;

const DISPOSITION_DEFAULT = 0x0001;
const DISPOSITION_COMMENT = 0x0008;
const DISPOSITION_FORCED = 0x0040;
const DISPOSITION_HEARING_IMPAIRED = 0x0080;
const DISPOSITION_VISUAL_IMPAIRED = 0x0100;

let sharedLibAVPromise;
let nextEngineSeq = 1;
const blockReadHandlers = new Map();

function getSharedLibAV() {
  if (!sharedLibAVPromise) {
    const isNode = typeof globalThis.process === 'object' && Boolean(globalThis.process?.versions?.node);
    const wasmurl = isNode
      ? undefined
      : new URL('./vendor/libav/libav-6.11.9.0.2-uburoom.wasm.wasm', import.meta.url).href;
    sharedLibAVPromise = LibAV.LibAV({ noworker: true, factory: LibAVFactory, ...(wasmurl ? { wasmurl } : {}) }).then(
      la => {
        la.onblockread = async (name, pos, len) => {
          const handler = blockReadHandlers.get(name);
          if (handler) return handler(name, pos, len);
          await la.ff_block_reader_dev_send(name, pos, new Uint8Array(0));
        };
        return la;
      },
    );
  }
  return sharedLibAVPromise;
}

function defaultMaskForChannels(channels) {
  if (channels <= 1) return 0x4;
  if (channels === 2) return 0x3;
  if (channels === 3) return 0x7;
  if (channels === 4) return 0x33;
  if (channels === 5) return 0x37;
  if (channels === 6) return 0x3f;
  if (channels === 7) return 0x13f;
  if (channels === 8) return 0x63f;
  return (1 << Math.min(channels, 16)) - 1;
}

function hex2(n) {
  return (n & 0xff).toString(16).padStart(2, '0');
}

function reverseBits32(v) {
  let x = v >>> 0;
  x = ((x & 0x55555555) << 1) | ((x >>> 1) & 0x55555555);
  x = ((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333);
  x = ((x & 0x0f0f0f0f) << 4) | ((x >>> 4) & 0x0f0f0f0f);
  x = ((x & 0x00ff00ff) << 8) | ((x >>> 8) & 0x00ff00ff);
  return ((x << 16) | (x >>> 16)) >>> 0;
}

function inferBitDepthFromExtradata(codecName, extradata) {
  if (!extradata || !extradata.length) return 0;
  const name = String(codecName || '').toLowerCase();
  if ((name === 'hevc' || name === 'h265' || name === 'hvc1' || name === 'hev1') && extradata[0] === 1) {
    if (extradata.length >= 18) {
      const depth = 8 + (extradata[17] & 0x07);
      if (depth >= 8 && depth <= 16) return depth;
    }
    const profileIdc = extradata.length >= 2 ? extradata[1] & 0x1f : 0;
    if (profileIdc === 2) return 10;
  }
  if ((name === 'h264' || name === 'avc1') && extradata.length >= 4 && extradata[0] === 1) {
    if (extradata[1] === 110) return 10;
  }
  if ((name === 'av1' || name === 'av01') && extradata.length >= 4 && (extradata[0] & 0x80) !== 0) {
    const highBitdepth = (extradata[2] >> 6) & 1;
    const twelveBit = (extradata[2] >> 5) & 1;
    return highBitdepth ? (twelveBit ? 12 : 10) : 8;
  }
  if (name === 'vp9' && extradata.length >= 4 && extradata[0] === 1) {
    const depth = (extradata[2] >> 4) & 0x0f;
    if (depth === 8 || depth === 10 || depth === 12) return depth;
  }
  return 0;
}

export function buildWebCodecsVideoCodec(codecName, extradata, bitDepth = 8, isAnnexB = false) {
  const name = String(codecName || '').toLowerCase();
  if (name === 'h264' || name === 'avc1') {
    if (extradata && extradata.length >= 4 && extradata[0] === 1) {
      return `avc1.${hex2(extradata[1])}${hex2(extradata[2])}${hex2(extradata[3])}`;
    }
    if (extradata && extradata.length >= 7) {
      for (let i = 0; i + 6 < extradata.length; i++) {
        const sc3 = extradata[i] === 0 && extradata[i + 1] === 0 && extradata[i + 2] === 1;
        const sc4 = sc3 && i > 0 && extradata[i - 1] === 0;
        if (sc3 && !sc4 && (extradata[i + 3] & 0x1f) === 7 && i + 6 < extradata.length) {
          return `avc1.${hex2(extradata[i + 4])}${hex2(extradata[i + 5])}${hex2(extradata[i + 6])}`;
        }
        if (
          extradata[i] === 0 &&
          extradata[i + 1] === 0 &&
          extradata[i + 2] === 0 &&
          extradata[i + 3] === 1 &&
          i + 7 < extradata.length &&
          (extradata[i + 4] & 0x1f) === 7
        ) {
          return `avc1.${hex2(extradata[i + 5])}${hex2(extradata[i + 6])}${hex2(extradata[i + 7])}`;
        }
      }
    }
    return bitDepth > 8 ? 'avc1.6e0028' : 'avc1.640028';
  }
  if (name === 'hevc' || name === 'h265' || name === 'hvc1' || name === 'hev1') {
    const prefix = isAnnexB ? 'hev1' : 'hvc1';
    if (extradata && extradata.length >= 13 && extradata[0] === 1) {
      const space = ['', 'A', 'B', 'C'][(extradata[1] >> 6) & 3];
      const tier = (extradata[1] >> 5) & 1 ? 'H' : 'L';
      const profileIdc = extradata[1] & 0x1f;
      const compat = ((extradata[2] << 24) | (extradata[3] << 16) | (extradata[4] << 8) | extradata[5]) >>> 0;
      const compatRev = reverseBits32(compat).toString(16);
      const constraints = [];
      for (let i = 6; i < 12; i++) constraints.push(extradata[i]);
      while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop();
      const constraintStr = constraints.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('.');
      const levelIdc = extradata[12];
      return `${prefix}.${space}${profileIdc}.${compatRev}.${tier}${levelIdc}.${constraintStr}`;
    }
    return bitDepth >= 10 ? `${prefix}.2.4.L153.B0` : `${prefix}.1.6.L93.B0`;
  }
  if (name === 'av1' || name === 'av01') {
    if (extradata && extradata.length >= 4 && (extradata[0] & 0x80) !== 0) {
      const seqProfile = (extradata[1] >> 5) & 0x7;
      const seqLevelIdx0 = String(extradata[1] & 0x1f).padStart(2, '0');
      const seqTier0 = (extradata[2] >> 7) & 1 ? 'H' : 'M';
      const highBitdepth = (extradata[2] >> 6) & 1;
      const twelveBit = (extradata[2] >> 5) & 1;
      const depth = highBitdepth ? (twelveBit ? '12' : '10') : '08';
      return `av01.${seqProfile}.${seqLevelIdx0}${seqTier0}.${depth}`;
    }
    return bitDepth >= 10 ? 'av01.0.12M.10' : 'av01.0.08M.08';
  }
  if (name === 'vp9') {
    return bitDepth >= 10 ? 'vp09.02.41.10' : 'vp09.00.41.08';
  }
  if (name === 'vp8') {
    return 'vp8';
  }
  if (name === 'mpeg4') {
    return 'mp4v.20.9';
  }
  return '';
}

function formatAssTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const totalCs = Math.round(clamped * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function matroskaAssToDialogue(rawText, startSec, endSec) {
  const trimmed = rawText.replace(/[\r\n]+$/g, '');
  if (!trimmed) return '';
  if (/^Dialogue:/i.test(trimmed)) return trimmed + '\r\n';
  const firstComma = trimmed.indexOf(',');
  if (firstComma < 0) return '';
  const afterReadOrder = trimmed.slice(firstComma + 1);
  const secondComma = afterReadOrder.indexOf(',');
  if (secondComma < 0) return '';
  const layer = afterReadOrder.slice(0, secondComma).trim() || '0';
  const rest = afterReadOrder.slice(secondComma + 1);
  return `Dialogue: ${layer},${formatAssTimestamp(startSec)},${formatAssTimestamp(endSec)},${rest}\r\n`;
}

function wrapPgsPacketToSup(data, ptsSeconds) {
  if (!data || data.length < 3) return null;
  if (data.length >= 13 && data[0] === 0x50 && data[1] === 0x47) return data;
  const pts90k = Math.max(0, Math.round(ptsSeconds * 90000)) >>> 0;
  const segments = [];
  let total = 0;
  let offset = 0;
  while (offset + 3 <= data.length) {
    const segLen = (data[offset + 1] << 8) | data[offset + 2];
    if (offset + 3 + segLen > data.length) break;
    const out = new Uint8Array(10 + 3 + segLen);
    out[0] = 0x50;
    out[1] = 0x47;
    out[2] = (pts90k >>> 24) & 0xff;
    out[3] = (pts90k >>> 16) & 0xff;
    out[4] = (pts90k >>> 8) & 0xff;
    out[5] = pts90k & 0xff;
    out.set(data.subarray(offset, offset + 3 + segLen), 10);
    segments.push(out);
    total += out.length;
    offset += 3 + segLen;
  }
  if (!total) return null;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const s of segments) {
    joined.set(s, at);
    at += s.length;
  }
  return joined;
}

function cleanSubripText(raw) {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\{\\[^}]*\}/g, '')
    .trim();
}

function joinChunks(list) {
  if (!list.length) return new Uint8Array(0);
  if (list.length === 1) return list[0];
  const total = list.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of list) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function packetPtsSeconds(libav, pkt, tbNum, tbDen) {
  if (pkt.pts !== undefined && pkt.ptshi !== -0x80000000) {
    return (libav.i64tof64(pkt.pts, pkt.ptshi || 0) * tbNum) / tbDen;
  }
  if (pkt.dts !== undefined && pkt.dtshi !== -0x80000000) {
    return (libav.i64tof64(pkt.dts, pkt.dtshi || 0) * tbNum) / tbDen;
  }
  return undefined;
}

export function createWorkerEngine(postMessageFn, runtimeOptions = {}) {
  const engineId = nextEngineSeq++;
  const vDevName = `ubu_v_${engineId}.media`;
  const aDevName = `ubu_a_${engineId}.media`;
  const sDevName = `ubu_s_${engineId}.media`;

  let libav;
  let closed = false;
  let fileSize = 0;
  let duration = 0;
  let nextReadId = 1;
  const pendingReads = new Map();
  const blockCache = new Map();
  const inflightBlocks = new Map();

  let vFmtCtx = 0;
  let aFmtCtx = 0;
  let sFmtCtx = 0;
  let vReadPkt = 0;
  let aReadPkt = 0;
  let sReadPkt = 0;

  let totalStreamCount = 0;
  let vStream = null;
  let audioStreams = [];
  let subtitleStreams = [];
  let fontAttachments = [];
  let chapters = [];

  let activeAudioStream = null;
  let activeSubStream = null;
  const seenAssEvents = new Set();
  let audioMode = 'normal';
  let targetHdr = false;
  let packetInspectMode = false;

  // Audio decode & resample state (direct 48 kHz Float32 PCM)
  let decCtx = 0;
  let decPkt = 0;
  let decFrame = 0;
  let filterGraph = 0;
  let bufSrc = 0;
  let bufSink = 0;
  let filterSig = '';
  let audioNextSample = null;
  let audioTrimBeforeSample = null;
  let waitingForAudioSync = false;
  let audioPort = null;
  let workletBufferedSeconds = 0;
  let outSampleRate = OUT_SAMPLE_RATE;

  // Video decode & OffscreenCanvas GPU presentation state
  let offscreenCanvas = null;
  let renderer = null;
  let videoDecoder = null;
  let videoDecoderConfig = null;
  let doviRpuCtx = createDoviRpuContext();
  let latestRpu = null;
  const rpuByPtsUs = new Map();
  const videoPacketQueue = [];
  let videoPacketBytes = 0;
  const frameQueue = [];
  let waitingForKeyFrame = true;
  let totalVideoFrames = 0;
  let droppedVideoFrames = 0;
  let firstFramePresented = false;

  // Timeline & generation tracking
  let seekGen = 0;
  let audioGen = 0;
  let subGen = 0;
  let videoEof = false;
  let audioEof = false;
  let subEof = false;
  let videoDemuxUntil = 0;
  let audioDemuxUntil = 0;
  let subDemuxUntil = 0;
  let bufferedStart = 0;
  let targetUntil = 30;
  let aheadBudgetSeconds = 30;

  // Clock sync from AudioWorklet/UbuPlayer
  let clockAnchorMedia = 0;
  let clockAnchorWallMs = 0;
  let clockPaused = true;
  let clockRate = 1.0;

  let pumping = false;
  let pumpRequested = false;
  let renderTimer = null;
  let renderingFrame = false;
  let opChain = Promise.resolve();
  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  const VideoDecoderCtor = runtimeOptions.VideoDecoder ?? globalThis.VideoDecoder;
  const EncodedVideoChunkCtor = runtimeOptions.EncodedVideoChunk ?? globalThis.EncodedVideoChunk;

  function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function currentMediaTime() {
    if (clockPaused) return clockAnchorMedia;
    const elapsedSec = Math.max(0, (nowMs() - clockAnchorWallMs) / 1000);
    return Math.max(0, clockAnchorMedia + elapsedSec * clockRate);
  }

  function enqueue(fn) {
    opChain = opChain.then(
      () => (closed ? undefined : fn()),
      () => (closed ? undefined : fn()),
    );
    return opChain;
  }

  function cacheBlock(blockIndex, bytes) {
    if (blockCache.has(blockIndex)) blockCache.delete(blockIndex);
    blockCache.set(blockIndex, bytes);
    while (blockCache.size > MAX_CACHED_BLOCKS) {
      const oldest = blockCache.keys().next().value;
      blockCache.delete(oldest);
    }
  }

  function requestBlock(blockIndex) {
    if (inflightBlocks.has(blockIndex)) return inflightBlocks.get(blockIndex);
    const start = blockIndex * BLOCK_SIZE;
    const end = Math.min(fileSize, start + BLOCK_SIZE);
    if (start >= fileSize) return Promise.resolve(new Uint8Array(0));
    const id = nextReadId++;
    const req = new Promise((resolve, reject) => {
      pendingReads.set(id, {
        resolve: bytes => {
          cacheBlock(blockIndex, bytes);
          resolve(bytes);
        },
        reject,
      });
      postMessageFn({ type: 'read', id, start, end });
    }).finally(() => {
      inflightBlocks.delete(blockIndex);
    });
    inflightBlocks.set(blockIndex, req);
    return req;
  }

  async function readBytes(pos, len) {
    if (pos >= fileSize) return new Uint8Array(0);
    const wantEnd = Math.min(fileSize, pos + Math.max(len, 65536));
    const firstBlock = Math.floor(pos / BLOCK_SIZE);
    const blockOffset = pos - firstBlock * BLOCK_SIZE;
    let block = blockCache.get(firstBlock);
    if (block) {
      blockCache.delete(firstBlock);
      blockCache.set(firstBlock, block);
    } else {
      block = await requestBlock(firstBlock);
    }
    const availableInBlock = block.subarray(blockOffset);
    if (availableInBlock.length >= wantEnd - pos || firstBlock * BLOCK_SIZE + block.length >= fileSize) {
      return availableInBlock;
    }
    const secondBlock = blockCache.get(firstBlock + 1) || (await requestBlock(firstBlock + 1));
    const joined = new Uint8Array(availableInBlock.length + secondBlock.length);
    joined.set(availableInBlock, 0);
    joined.set(secondBlock, availableInBlock.length);
    return joined;
  }

  function registerDeviceReader(devName) {
    blockReadHandlers.set(devName, async (name, pos, len) => {
      try {
        const bytes = await readBytes(pos, len);
        await libav.ff_block_reader_dev_send(name, pos, bytes);
      } catch (err) {
        await libav.ff_block_reader_dev_send(name, pos, null, { error: err });
      }
    });
  }

  async function configureStreamDiscards(fmtCtx, activeIndices) {
    const keep = new Set(activeIndices);
    for (let i = 0; i < totalStreamCount; i++) {
      const stPtr = await libav.AVFormatContext_streams_a(fmtCtx, i);
      if (!stPtr) continue;
      await libav.AVStream_discard_s(stPtr, keep.has(i) ? libav.AVDISCARD_DEFAULT : libav.AVDISCARD_ALL);
    }
  }

  async function readMetadataDict(dictPtr) {
    if (!dictPtr) return {};
    try {
      return (await libav.ff_copyout_dict(dictPtr)) || {};
    } catch {
      return {};
    }
  }

  async function copyExtradata(codecpar) {
    const ptr = await libav.AVCodecParameters_extradata(codecpar);
    const size = await libav.AVCodecParameters_extradata_size(codecpar);
    if (!ptr || size <= 0) return new Uint8Array(0);
    return new Uint8Array(await libav.copyout_u8(ptr, size));
  }

  async function inspectCodedSideData(codecpar) {
    const out = { doviConfig: null };
    try {
      const count = await libav.AVCodecParameters_nb_coded_side_data(codecpar);
      const ptr = count > 0 ? await libav.AVCodecParameters_coded_side_data(codecpar) : 0;
      if (ptr && count > 0 && typeof libav.ff_copyout_side_data === 'function') {
        const entries = (await libav.ff_copyout_side_data(ptr, count)) || [];
        for (const entry of entries) {
          if (!entry?.data?.length) continue;
          const dv = parseDolbyVisionConfigRecord(entry.data);
          if (dv) out.doviConfig = dv;
        }
      }
    } catch {}
    return out;
  }

  function surroundDialogueActive() {
    return Boolean(activeAudioStream && activeAudioStream.channels > 2 && audioMode === 'dialogue');
  }

  async function freeAudioDecoder() {
    if (filterGraph) {
      await libav.avfilter_graph_free_js(filterGraph);
      filterGraph = bufSrc = bufSink = 0;
      filterSig = '';
    }
    if (decCtx) {
      await libav.ff_free_decoder(decCtx, decPkt, decFrame);
      decCtx = decPkt = decFrame = 0;
    }
    audioNextSample = null;
    audioTrimBeforeSample = null;
    waitingForAudioSync = false;
  }

  async function initAudioDecoder(streamInfo) {
    await freeAudioDecoder();
    activeAudioStream = streamInfo;
    if (!streamInfo) return;
    if (!aFmtCtx) {
      registerDeviceReader(aDevName);
      await libav.mkblockreaderdev(aDevName, fileSize);
      const [ctx] = await libav.ff_init_demuxer_file(aDevName);
      aFmtCtx = ctx;
      aReadPkt = await libav.av_packet_alloc();
    }
    await configureStreamDiscards(aFmtCtx, [streamInfo.index]);
    const dec = await libav.ff_init_decoder(streamInfo.codecId, {
      codecpar: streamInfo.codecpar,
      time_base: [streamInfo.tbNum, streamInfo.tbDen],
    });
    decCtx = dec[1];
    decPkt = dec[2];
    decFrame = dec[3];
  }

  async function ensureAudioFilter(f0) {
    const fRate = (await libav.AVFrame_sample_rate(f0)) || 48000;
    const fFmt = await libav.AVFrame_format(f0);
    const fCh = (await libav.AVFrame_ch_layout_nb_channels(f0)) || 2;
    const fMask = (await libav.AVFrame_channel_layoutmask(f0)) || defaultMaskForChannels(fCh);
    const sig = `${fRate}:${fFmt}:${fMask}:${audioMode}:${outSampleRate}`;
    if (filterGraph && filterSig === sig) return;
    if (filterGraph) {
      await libav.avfilter_graph_free_js(filterGraph);
      filterGraph = bufSrc = bufSink = 0;
    }
    const filterDesc =
      fCh > 2
        ? audioMode === 'dialogue'
          ? `aresample=${outSampleRate}:clev=1.414214:slev=0.5:lfe_mix_level=0.5`
          : audioMode === 'night'
            ? `aresample=${outSampleRate}:clev=1.0:slev=0.707107:lfe_mix_level=0.5`
            : `aresample=${outSampleRate}:clev=0.707107:slev=0.707107`
        : `aresample=${outSampleRate}`;
    const graph = await libav.ff_init_filter_graph(
      filterDesc,
      {
        sample_rate: fRate,
        sample_fmt: fFmt,
        channel_layout: fMask,
        time_base: [1, fRate],
      },
      {
        sample_rate: outSampleRate,
        sample_fmt: libav.AV_SAMPLE_FMT_FLTP,
        channel_layout: OUT_CHANNEL_LAYOUT,
      },
    );
    filterGraph = graph[0];
    bufSrc = graph[1];
    bufSink = graph[2];
    filterSig = sig;
  }

  async function seekFormatContext(ctx, streamInfo, seconds) {
    if (!ctx) return;
    // Matroska Cues typically index only the video track. Seeking an audio or subtitle
    // AVFormatContext by its own stream index causes FFmpeg to binary-search/scan gigabytes
    // of the file over HTTP Range requests. Always seek via the indexed video stream when present.
    const seekStream = vStream || streamInfo;
    if (!seekStream) return;
    const clamped = Math.max(0, seconds);
    const ts = Math.round((clamped * seekStream.tbDen) / seekStream.tbNum);
    const [tsLo, tsHi] = libav.f64toi64(ts);
    const ret = await libav.avformat_seek_file_max(ctx, seekStream.index, tsLo, tsHi);
    if (ret < 0) {
      await libav.avformat_seek_file_approx(ctx, seekStream.index, tsLo, tsHi);
    }
  }

  function isTrueHdCodec(streamInfo) {
    return streamInfo?.codec === 'truehd' || streamInfo?.codec === 'mlp';
  }

  function hasAudioSyncHeader(streamInfo, pkt) {
    if (!pkt?.data?.length) return false;
    if (isTrueHdCodec(streamInfo)) {
      const d = pkt.data;
      return (
        (pkt.flags & libav.AV_PKT_FLAG_KEY) !== 0 &&
        d.length >= 8 &&
        d[4] === 0xf8 &&
        d[5] === 0x72 &&
        d[6] === 0x6f &&
        (d[7] === 0xba || d[7] === 0xbb)
      );
    }
    return (pkt.flags & libav.AV_PKT_FLAG_KEY) !== 0;
  }

  async function seekAudioContext(streamInfo, targetSeconds) {
    if (!aFmtCtx || !streamInfo) return;
    const clamped = Math.max(0, targetSeconds);
    const preroll = clamped > 0 ? (isTrueHdCodec(streamInfo) ? 1.5 : 0.15) : 0;
    await seekFormatContext(aFmtCtx, streamInfo, Math.max(0, clamped - preroll));
    audioNextSample = null;
    audioTrimBeforeSample = clamped > 0 ? Math.round(clamped * outSampleRate) : null;
    waitingForAudioSync = clamped > 0 && isTrueHdCodec(streamInfo);
  }

  function clearDecodedFrames() {
    while (frameQueue.length) {
      const item = frameQueue.shift();
      try {
        item.frame.close();
      } catch {}
    }
  }

  function clearVideoPackets() {
    videoPacketQueue.length = 0;
    videoPacketBytes = 0;
    rpuByPtsUs.clear();
  }

  function insertDecodedFrame(frame) {
    if (closed) {
      try {
        frame.close();
      } catch {}
      return;
    }
    const ptsUs = Number(frame.timestamp) || 0;
    const rpu = rpuByPtsUs.get(ptsUs) || latestRpu;
    if (rpuByPtsUs.size > 256) {
      const firstKey = rpuByPtsUs.keys().next().value;
      rpuByPtsUs.delete(firstKey);
    } else {
      rpuByPtsUs.delete(ptsUs);
    }
    const entry = { frame, ptsSec: ptsUs / 1e6, rpu };
    let idx = frameQueue.length;
    while (idx > 0 && frameQueue[idx - 1].ptsSec > entry.ptsSec) idx--;
    frameQueue.splice(idx, 0, entry);
    scheduleRenderTick(0);
  }

  async function initVideoDecoder() {
    if (typeof VideoDecoderCtor !== 'function' || !vStream) return;
    const isLengthPrefixed =
      (vStream.codecName === 'h264' || vStream.codecName === 'hevc') &&
      vStream.extradata?.length >= 7 &&
      vStream.extradata[0] === 1;
    const isAnnexB = (vStream.codecName === 'h264' || vStream.codecName === 'hevc') && !isLengthPrefixed;
    const codecString = buildWebCodecsVideoCodec(vStream.codecName, vStream.extradata, vStream.bitDepth, isAnnexB);
    if (!codecString) {
      const err = Object.assign(new Error(`Unsupported video codec: ${vStream.codecName}`), {
        kind: 'codec-unsupported',
      });
      throw err;
    }
    let description = vStream.extradata?.length && !isAnnexB ? vStream.extradata : undefined;
    const wantRawHdrDecode = Boolean(vStream.hdr || (vStream.hdrKind && vStream.hdrKind !== 'sdr'));
    const rawHdrFullRange = Boolean(vStream.fullRange || vStream.hdrKind === 'dovi-p5');
    if (wantRawHdrDecode && vStream.codecName === 'hevc' && description) {
      const patched = patchHvccForRawHdrDecode(description, { fullRange: rawHdrFullRange });
      if (patched.patched) description = patched.extradata;
    }
    const baseCfg = {
      codec: codecString,
      codedWidth: vStream.width,
      codedHeight: vStream.height,
      ...(description ? { description } : {}),
      ...(wantRawHdrDecode
        ? {
            colorSpace: {
              primaries: 'bt709',
              transfer: 'iec61966-2-1',
              matrix: 'bt709',
              fullRange: rawHdrFullRange,
            },
          }
        : {}),
    };
    let chosenCfg = null;
    if (typeof VideoDecoderCtor.isConfigSupported === 'function') {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        try {
          const res = await VideoDecoderCtor.isConfigSupported({ ...baseCfg, hardwareAcceleration: hw });
          if (res?.supported) {
            chosenCfg = res.config || { ...baseCfg, hardwareAcceleration: hw };
            break;
          }
        } catch {}
      }
      if (!chosenCfg) {
        throw Object.assign(new Error(`Browser WebCodecs cannot decode ${codecString}.`), {
          kind: 'codec-unsupported',
        });
      }
    } else {
      chosenCfg = baseCfg;
    }
    videoDecoderConfig = chosenCfg;
    videoDecoder = new VideoDecoderCtor({
      output: frame => insertDecodedFrame(frame),
      error: err => {
        if (!closed) {
          postMessageFn({
            type: 'error',
            kind: 'codec-unsupported',
            message: err?.message || 'Hardware video decoder failed.',
          });
        }
      },
    });
    videoDecoder.configure(videoDecoderConfig);
    waitingForKeyFrame = true;
  }

  function feedVideoDecoder() {
    if (!videoDecoder || videoDecoder.state !== 'configured' || typeof EncodedVideoChunkCtor !== 'function') return;
    while (
      videoPacketQueue.length > 0 &&
      (videoDecoder.decodeQueueSize || 0) + frameQueue.length < MAX_DECODER_INFLIGHT
    ) {
      const pkt = videoPacketQueue.shift();
      videoPacketBytes = Math.max(0, videoPacketBytes - pkt.data.byteLength);
      if (waitingForKeyFrame) {
        if (!pkt.isKey) continue;
        waitingForKeyFrame = false;
      }
      const timestampUs = Math.round(pkt.ptsSec * 1e6);
      if (pkt.rpu) rpuByPtsUs.set(timestampUs, pkt.rpu);
      try {
        const chunk = new EncodedVideoChunkCtor({
          type: pkt.isKey ? 'key' : 'delta',
          timestamp: timestampUs,
          duration: Math.max(1, Math.round(pkt.durSec * 1e6)),
          data: pkt.data,
        });
        videoDecoder.decode(chunk);
      } catch (err) {
        postMessageFn({
          type: 'error',
          kind: 'codec-unsupported',
          message: err?.message || 'Video packet decode failed.',
        });
        return;
      }
    }
    if (!videoEof && videoDemuxUntil < targetUntil && videoPacketBytes < MAX_VIDEO_PACKET_BYTES * 0.5) {
      pumpLoop();
    }
  }

  function effectiveBufferedEnd() {
    const vEnd = videoEof ? duration || videoDemuxUntil : videoDemuxUntil;
    if (!activeAudioStream) return vEnd;
    const aEnd = audioEof ? duration || audioDemuxUntil : audioDemuxUntil;
    return Math.min(vEnd, Math.max(aEnd, currentMediaTime() + workletBufferedSeconds));
  }

  function emitBufferProgress() {
    postMessageFn({
      type: 'progress',
      seekGen,
      bufferedStart,
      bufferedEnd: Math.max(bufferedStart, effectiveBufferedEnd()),
      videoEof,
      audioEof: !activeAudioStream || audioEof,
    });
  }

  function scheduleRenderTick(delayMs = 4) {
    if (closed || renderTimer !== null) return;
    if (delayMs === 0 && typeof globalThis.requestAnimationFrame === 'function') {
      const id = globalThis.requestAnimationFrame(() => {
        renderTimer = null;
        void renderStep();
      });
      renderTimer = { kind: 'raf', id };
      return;
    }
    const id = setTimeout(() => {
      renderTimer = null;
      void renderStep();
    }, delayMs);
    renderTimer = { kind: 'timeout', id };
  }

  function cancelRenderTick() {
    if (!renderTimer) return;
    if (renderTimer.kind === 'raf' && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(renderTimer.id);
    } else {
      clearTimeout(renderTimer.id);
    }
    renderTimer = null;
  }

  async function renderStep() {
    if (closed || renderingFrame) return;
    feedVideoDecoder();
    if (!frameQueue.length) {
      if (!clockPaused && (!videoEof || (videoDecoder?.decodeQueueSize || 0) > 0 || videoPacketQueue.length > 0)) {
        scheduleRenderTick(8);
      }
      return;
    }

    const mediaNow = currentMediaTime();
    // Discard GOP seek pre-roll frames prior to mediaNow before marking firstFramePresented,
    // preventing MAX_DECODER_INFLIGHT stalls and presenting the exact seek target frame while paused.
    while (frameQueue.length > 0 && !firstFramePresented) {
      const candidate = frameQueue[0];
      const durSec = Math.max(1 / 120, (Number(candidate.frame.duration) || 41666) / 1e6);
      const moreIncoming =
        frameQueue.length > 1 || !videoEof || videoPacketQueue.length > 0 || (videoDecoder?.decodeQueueSize || 0) > 0;
      if (candidate.ptsSec + durSec < mediaNow - 0.015 && moreIncoming) {
        frameQueue.shift();
        try {
          candidate.frame.close();
        } catch {}
        feedVideoDecoder();
        continue;
      }
      break;
    }
    if (!frameQueue.length) {
      if (!videoEof || (videoDecoder?.decodeQueueSize || 0) > 0 || videoPacketQueue.length > 0) {
        scheduleRenderTick(4);
      }
      return;
    }
    // Present the target seek/load frame immediately even while paused so previews appear
    if (clockPaused && firstFramePresented) return;

    // Drop late frames if another frame is already due at or before mediaNow
    while (frameQueue.length > 1 && frameQueue[1].ptsSec <= mediaNow && mediaNow - frameQueue[0].ptsSec > 0.045) {
      const dropped = frameQueue.shift();
      totalVideoFrames++;
      droppedVideoFrames++;
      try {
        dropped.frame.close();
      } catch {}
    }

    const head = frameQueue[0];
    const leadSec = head.ptsSec - mediaNow;
    if (firstFramePresented && !clockPaused && leadSec > 0.006) {
      const waitMs = Math.min(16, Math.max(1, Math.floor((leadSec * 1000) / Math.max(0.5, clockRate))));
      scheduleRenderTick(waitMs);
      return;
    }

    frameQueue.shift();
    renderingFrame = true;
    const frame = head.frame;
    const width = frame.displayWidth || frame.codedWidth || vStream?.width || 0;
    const height = frame.displayHeight || frame.codedHeight || vStream?.height || 0;
    try {
      if (renderer) {
        await renderer.renderFrame(frame, vStream, head.rpu || latestRpu, targetHdr);
      }
      totalVideoFrames++;
      firstFramePresented = true;
      postMessageFn({
        type: 'framePresented',
        seekGen,
        mediaTime: head.ptsSec,
        width,
        height,
        totalVideoFrames,
        droppedVideoFrames,
        bufferedStart,
        bufferedEnd: Math.max(bufferedStart, effectiveBufferedEnd()),
      });
    } catch (err) {
      if (!closed) {
        postMessageFn({
          type: 'error',
          kind: 'render-failed',
          message: err?.message || 'GPU frame rendering failed.',
        });
      }
    } finally {
      renderingFrame = false;
      try {
        frame.close();
      } catch {}
    }

    feedVideoDecoder();
    if (!closed && (!clockPaused || !firstFramePresented)) {
      scheduleRenderTick(0);
    }
  }

  async function init(msg) {
    libav = await getSharedLibAV();
    if (typeof libav.av_log_set_level === 'function') {
      await libav.av_log_set_level(libav.AV_LOG_FATAL ?? libav.AV_LOG_QUIET ?? 8);
    }
    fileSize = Number(msg.fileSize) || 0;
    if (Number(msg.sampleRate) > 0) outSampleRate = Math.round(Number(msg.sampleRate));
    audioMode = ['normal', 'dialogue', 'night'].includes(msg.audioMode) ? msg.audioMode : 'normal';
    targetHdr = Boolean(msg.targetHdr);
    packetInspectMode = Boolean(msg.packetInspectMode);
    offscreenCanvas = msg.canvas || null;

    blockCache.clear();
    if (msg.initialBytes) {
      const initView = msg.initialBytes instanceof Uint8Array ? msg.initialBytes : new Uint8Array(msg.initialBytes);
      const expectedBlock0 = Math.min(fileSize, BLOCK_SIZE);
      if (expectedBlock0 > 0 && initView.byteLength >= expectedBlock0) {
        cacheBlock(0, initView.byteLength === expectedBlock0 ? initView : initView.subarray(0, expectedBlock0));
      }
    }

    registerDeviceReader(vDevName);
    await libav.mkblockreaderdev(vDevName, fileSize);
    const [ctx, streams] = await libav.ff_init_demuxer_file(vDevName);
    vFmtCtx = ctx;
    totalStreamCount = streams.length;

    const fmtDurLo = await libav.AVFormatContext_duration(vFmtCtx);
    const fmtDurHi = await libav.AVFormatContext_durationhi(vFmtCtx);
    const rawFmtDur = libav.i64tof64(fmtDurLo, fmtDurHi);
    duration = rawFmtDur > 0 ? rawFmtDur / libav.AV_TIME_BASE : Number(msg.duration) || 0;

    try {
      const rawChapters = await libav.ff_get_demuxer_chapters(vFmtCtx);
      if (Array.isArray(rawChapters)) {
        chapters = await Promise.all(
          rawChapters.map(async (ch, idx) => {
            const meta = ch.metadata ? await readMetadataDict(ch.metadata) : {};
            const tb = (ch.time_base_num || 1) / (ch.time_base_den || 1000);
            const start = libav.i64tof64(ch.start, ch.starthi || 0) * tb;
            const end = libav.i64tof64(ch.end, ch.endhi || 0) * tb;
            return {
              id: String(idx + 1),
              index: idx + 1,
              title: meta.title || meta.TITLE || `Chapter ${idx + 1}`,
              startTime: Math.max(0, Math.round(start * 1000) / 1000),
              endTime: Math.max(0, Math.round(end * 1000) / 1000),
            };
          }),
        );
      }
    } catch {
      chapters = [];
    }

    audioStreams = [];
    subtitleStreams = [];
    fontAttachments = [];
    vStream = null;

    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      const stPtr = (await libav.AVFormatContext_streams_a(vFmtCtx, i)) || 0;
      const metaPtr = stPtr ? await libav.AVStream_metadata(stPtr) : 0;
      const meta = await readMetadataDict(metaPtr);
      const disp = stPtr && libav.AVStream_disposition ? await libav.AVStream_disposition(stPtr) : 0;
      const codecName = String((await libav.avcodec_get_name(s.codec_id)) || '').toLowerCase();
      const lang = (meta.language || meta.LANGUAGE || 'und').toLowerCase();
      const title = meta.title || meta.TITLE || '';

      if (s.codec_type === libav.AVMEDIA_TYPE_VIDEO && !vStream && !(disp & 0x0400)) {
        const width = await libav.AVCodecParameters_width(s.codecpar);
        const height = await libav.AVCodecParameters_height(s.codecpar);
        const pixFmt = await libav.AVCodecParameters_format(s.codecpar);
        const pixDesc = pixFmt >= 0 ? await libav.av_pix_fmt_desc_get(pixFmt) : 0;
        const rawSampleBits =
          typeof libav.AVCodecParameters_bits_per_raw_sample === 'function'
            ? await libav.AVCodecParameters_bits_per_raw_sample(s.codecpar)
            : 0;
        const pixDepth = pixDesc ? await libav.AVPixFmtDescriptor_comp_depth(pixDesc) : 0;
        const colorTrc = await libav.AVCodecParameters_color_trc(s.codecpar);
        const colorPrimaries = await libav.AVCodecParameters_color_primaries(s.codecpar);
        const colorRange = await libav.AVCodecParameters_color_range(s.codecpar);
        const extradata = await copyExtradata(s.codecpar);
        const bitDepth = pixDepth || rawSampleBits || inferBitDepthFromExtradata(codecName, extradata) || 8;
        const sideInfo = await inspectCodedSideData(s.codecpar);
        const hevcMeta = codecName === 'hevc' ? parseHevcColorMetadata(extradata) : null;
        const doviCfg = sideInfo.doviConfig || hevcMeta?.doviConfig || null;

        let hdrKind = colorTrc === 16 ? 'hdr10' : colorTrc === 18 ? 'hlg' : 'sdr';
        let hdr = hdrKind !== 'sdr' || Boolean(hevcMeta?.masteringDisplay || hevcMeta?.contentLight);
        if (hdr && hdrKind === 'sdr') hdrKind = 'hdr10';
        let doviProfile = doviCfg?.dvProfile ?? null;
        if (doviCfg) {
          if (doviProfile === 5 || (doviCfg.blCompatId === 0 && colorTrc !== 16 && colorTrc !== 18)) {
            hdr = true;
            hdrKind = 'dovi-p5';
            doviProfile = doviProfile || 5;
          } else if (doviCfg.blCompatId === 4 || colorTrc === 18) {
            hdr = true;
            hdrKind = 'dovi-hlg';
          } else if (doviCfg.blCompatId === 2 && colorTrc !== 16) {
            hdr = false;
            hdrKind = 'sdr';
          } else {
            hdr = true;
            hdrKind = 'dovi-hdr10';
          }
        }
        doviRpuCtx = createDoviRpuContext(doviProfile || 0);

        const isAnnexB =
          (codecName === 'h264' || codecName === 'hevc') && !(extradata.length >= 7 && extradata[0] === 1);
        const webCodecsCodec = buildWebCodecsVideoCodec(codecName, extradata, bitDepth, isAnnexB);
        vStream = {
          index: s.index,
          codecId: s.codec_id,
          codecName,
          codecpar: s.codecpar,
          tbNum: s.time_base_num,
          tbDen: s.time_base_den,
          width,
          height,
          bitDepth,
          colorTrc,
          colorPrimaries,
          fullRange: colorRange === 2 || hdrKind === 'dovi-p5',
          hdr,
          hdrKind,
          doviProfile,
          isAnnexB,
          nalLengthSize: hevcMeta?.nalLengthSize || 4,
          maxLuminance: hevcMeta?.masteringDisplay?.maxLuminance,
          minLuminance: hevcMeta?.masteringDisplay?.minLuminance,
          maxCll: hevcMeta?.contentLight?.maxCll,
          maxFall: hevcMeta?.contentLight?.maxFall,
          extradata,
          webCodecsCodec,
          videoMime: webCodecsCodec ? `video/mp4; codecs="${webCodecsCodec}"` : '',
        };
        if (!duration && s.duration > 0) duration = (s.duration * s.time_base_num) / s.time_base_den;
      } else if (s.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
        const channels = (await libav.AVCodecParameters_ch_layout_nb_channels(s.codecpar)) || 2;
        const sampleRate = (await libav.AVCodecParameters_sample_rate(s.codecpar)) || 48000;
        const ordinal = audioStreams.length;
        audioStreams.push({
          id: msg.serverAudioIds?.[ordinal] || `local-a-${s.index}`,
          index: s.index,
          ordinal,
          codecId: s.codec_id,
          codec: codecName === 'dca' ? 'dts' : codecName,
          codecpar: s.codecpar,
          tbNum: s.time_base_num,
          tbDen: s.time_base_den,
          channels,
          sampleRate,
          language: lang,
          title,
          default: Boolean(disp & DISPOSITION_DEFAULT) || ordinal === 0,
          forced: Boolean(disp & DISPOSITION_FORCED),
          commentary: Boolean(disp & DISPOSITION_COMMENT) || /commentary/i.test(title),
          description: Boolean(disp & DISPOSITION_VISUAL_IMPAIRED),
          available: true,
        });
      } else if (s.codec_type === libav.AVMEDIA_TYPE_SUBTITLE) {
        const isAss = codecName === 'ass' || codecName === 'ssa';
        const isPgs = codecName === 'hdmv_pgs_subtitle' || codecName === 'pgssub';
        const isText = ['subrip', 'srt', 'mov_text', 'text', 'webvtt'].includes(codecName);
        if (isAss || isPgs || isText) {
          const extradata = await copyExtradata(s.codecpar);
          const ordinal = subtitleStreams.length;
          subtitleStreams.push({
            id: `local-s-${s.index}`,
            index: s.index,
            ordinal,
            codecId: s.codec_id,
            codec: isPgs ? 'pgs' : isAss ? 'ass' : 'srt',
            delivery: isPgs ? 'pgs' : isAss ? 'ass' : 'cues',
            codecpar: s.codecpar,
            tbNum: s.time_base_num,
            tbDen: s.time_base_den,
            extradata,
            language: lang,
            title,
            default: Boolean(disp & DISPOSITION_DEFAULT),
            forced: Boolean(disp & DISPOSITION_FORCED),
            sdh: Boolean(disp & DISPOSITION_HEARING_IMPAIRED) || /\bsdh\b/i.test(title),
            commentary: Boolean(disp & DISPOSITION_COMMENT),
            available: true,
          });
        }
      } else if (s.codec_type === libav.AVMEDIA_TYPE_ATTACHMENT) {
        const filename = String(meta.filename || meta.FILENAME || '').toLowerCase();
        const mimetype = String(meta.mimetype || meta.MIMETYPE || '').toLowerCase();
        if (/\.(ttf|otf|ttc|woff2?)$/i.test(filename) || /font|truetype|opentype/.test(mimetype)) {
          const bytes = await copyExtradata(s.codecpar);
          if (bytes.length > 0 && bytes.length <= 16 * 1024 * 1024) fontAttachments.push(bytes);
        }
      }
    }

    if (!vStream) throw new Error('No playable video stream was found in this file.');
    if (!vStream.webCodecsCodec) {
      throw Object.assign(new Error(`Unsupported video codec: ${vStream.codecName}.`), {
        kind: 'codec-unsupported',
      });
    }

    if (msg.probeOnly) {
      postMessageFn({
        type: 'probed',
        duration,
        video: {
          codec: vStream.codecName,
          webCodecsCodec: vStream.webCodecsCodec,
          mime: vStream.videoMime,
          width: vStream.width,
          height: vStream.height,
          bitDepth: vStream.bitDepth,
          hdr: vStream.hdr,
          hdrKind: vStream.hdrKind,
          doviProfile: vStream.doviProfile,
          maxLuminance: vStream.maxLuminance,
          minLuminance: vStream.minLuminance,
          maxCll: vStream.maxCll,
          maxFall: vStream.maxFall,
        },
        audioTracks: audioStreams.map(({ codecpar, ...pub }) => pub),
        subtitleTracks: subtitleStreams.map(({ codecpar, extradata, ...pub }) => pub),
        chapters,
      });
      return;
    }

    vReadPkt = await libav.av_packet_alloc();
    await configureStreamDiscards(vFmtCtx, [vStream.index]);

    if (offscreenCanvas) {
      renderer = await createOffscreenRenderer(offscreenCanvas, {
        preferWebGpu: msg.preferWebGpu !== false,
        targetHdr,
      });
    }
    await initVideoDecoder();

    const chosenAudio =
      audioStreams.find(a => a.id === msg.audioId) || audioStreams.find(a => a.default) || audioStreams[0] || null;
    if (chosenAudio) {
      await initAudioDecoder(chosenAudio);
    }

    aheadBudgetSeconds = Math.max(10, Math.min(45, Number(msg.aheadSeconds) || 30));
    if (fileSize > 0 && duration > 0) {
      const bytesPerSec = fileSize / duration;
      if (bytesPerSec > 0) {
        aheadBudgetSeconds = Math.max(
          10,
          Math.min(aheadBudgetSeconds, Math.floor(MAX_VIDEO_PACKET_BYTES / bytesPerSec)),
        );
      }
    }

    const startTime = Math.max(0, Number(msg.startTime) || 0);
    clockAnchorMedia = startTime;
    clockAnchorWallMs = nowMs();
    bufferedStart = startTime;
    videoDemuxUntil = startTime;
    audioDemuxUntil = startTime;

    if (startTime > 0.25) {
      await performSeek(startTime, seekGen);
    }
    targetUntil = startTime + aheadBudgetSeconds;

    postMessageFn({
      type: 'ready',
      duration,
      rendererBackend: renderer?.backend || 'none',
      hdrOutputActive: Boolean(renderer?.hdrOutputActive),
      video: {
        codec: vStream.codecName,
        webCodecsCodec: vStream.webCodecsCodec,
        mime: vStream.videoMime,
        width: vStream.width,
        height: vStream.height,
        bitDepth: vStream.bitDepth,
        hdr: vStream.hdr,
        hdrKind: vStream.hdrKind,
        doviProfile: vStream.doviProfile,
        maxLuminance: vStream.maxLuminance,
        minLuminance: vStream.minLuminance,
        maxCll: vStream.maxCll,
        maxFall: vStream.maxFall,
      },
      surroundDialogueActive: surroundDialogueActive(),
      selectedAudioId: chosenAudio?.id || null,
      audioTracks: audioStreams.map(({ codecpar, ...pub }) => pub),
      subtitleTracks: subtitleStreams.map(({ codecpar, extradata, ...pub }) => pub),
      chapters,
    });

    pumpLoop();
  }

  async function performSeek(seconds, gen) {
    seekGen = gen;
    const clamped = Math.max(0, seconds);
    clockAnchorMedia = clamped;
    clockAnchorWallMs = nowMs();
    bufferedStart = clamped;
    videoDemuxUntil = clamped;
    audioDemuxUntil = clamped;
    subDemuxUntil = clamped;
    videoEof = false;
    audioEof = false;
    subEof = false;
    firstFramePresented = false;

    clearVideoPackets();
    clearDecodedFrames();
    if (videoDecoder && videoDecoder.state === 'configured') {
      try {
        videoDecoder.reset();
        videoDecoder.configure(videoDecoderConfig);
      } catch {}
    }
    waitingForKeyFrame = true;

    await seekFormatContext(vFmtCtx, vStream, clamped);
    if (aFmtCtx && activeAudioStream) {
      if (decCtx) await libav.avcodec_flush_buffers(decCtx);
      if (filterGraph) {
        await libav.avfilter_graph_free_js(filterGraph);
        filterGraph = bufSrc = bufSink = 0;
        filterSig = '';
      }
      await seekAudioContext(activeAudioStream, clamped);
      workletBufferedSeconds = 0;
      audioPort?.postMessage({
        type: 'reset',
        seekGen: gen,
        audioGen,
        startSample: Math.round(clamped * outSampleRate),
      });
    }
    if (sFmtCtx && activeSubStream) {
      await seekFormatContext(sFmtCtx, activeSubStream, clamped);
    }
  }

  async function pumpVideoStep() {
    if (closed || !vFmtCtx || videoEof) return false;
    if (videoDemuxUntil >= targetUntil || videoPacketBytes >= MAX_VIDEO_PACKET_BYTES) return false;
    const curSeekGen = seekGen;
    const [readRes, packetsByStream] = await libav.ff_read_frame_multi(vFmtCtx, vReadPkt, { limit: 524288 });
    if (closed || curSeekGen !== seekGen) return false;
    const isEof = readRes === libav.AVERROR_EOF;
    const pkts = packetsByStream[vStream.index] || [];
    const inspectedBatch = [];

    for (const p of pkts) {
      if (!p.data?.length) continue;
      let packetData = p.data;
      let packetRpu = null;
      if (vStream.codecName === 'hevc' && !vStream.isAnnexB) {
        const inspected = inspectHevcPacket(packetData, vStream.nalLengthSize, doviRpuCtx, {
          patchSpsVui: Boolean(vStream.hdr || (vStream.hdrKind && vStream.hdrKind !== 'sdr')),
          fullRange: Boolean(vStream.fullRange || vStream.hdrKind === 'dovi-p5'),
        });
        packetData = inspected.packetData;
        if (inspected.masteringDisplay) {
          vStream.maxLuminance = inspected.masteringDisplay.maxLuminance;
          vStream.minLuminance = inspected.masteringDisplay.minLuminance;
          vStream.hdr = true;
          if (vStream.hdrKind === 'sdr') vStream.hdrKind = 'hdr10';
        }
        if (inspected.contentLight) {
          vStream.maxCll = inspected.contentLight.maxCll;
          vStream.maxFall = inspected.contentLight.maxFall;
          vStream.hdr = true;
          if (vStream.hdrKind === 'sdr') vStream.hdrKind = 'hdr10';
        }
        if (inspected.rpu) {
          packetRpu = inspected.rpu;
          latestRpu = inspected.rpu;
          if (!vStream.doviProfile && inspected.rpu.profile) {
            vStream.doviProfile = inspected.rpu.profile;
            if (inspected.rpu.profile === 5) {
              vStream.hdr = true;
              vStream.hdrKind = 'dovi-p5';
            }
          }
        }
      }
      const ptsSec = packetPtsSeconds(libav, p, vStream.tbNum, vStream.tbDen) ?? videoDemuxUntil;
      const durSec = p.duration > 0 ? (p.duration * vStream.tbNum) / vStream.tbDen : 1 / 24;
      const isKey = (p.flags & libav.AV_PKT_FLAG_KEY) !== 0;
      if (ptsSec + durSec > videoDemuxUntil) videoDemuxUntil = ptsSec + durSec;
      const entry = { ptsSec, durSec, isKey, data: packetData, rpu: packetRpu };
      if (videoDecoder) {
        videoPacketQueue.push(entry);
        videoPacketBytes += packetData.byteLength;
      }
      if (packetInspectMode) {
        inspectedBatch.push({
          ptsSec,
          durSec,
          isKey,
          byteLength: packetData.byteLength,
          hasRpu: Boolean(packetRpu),
          doviProfile: packetRpu?.profile ?? vStream.doviProfile,
        });
      }
    }

    if (packetInspectMode && (inspectedBatch.length || isEof)) {
      postMessageFn({
        type: 'videoPackets',
        seekGen: curSeekGen,
        packets: inspectedBatch,
        bufferedUntil: videoDemuxUntil,
        eof: isEof,
      });
    }

    if (isEof) {
      videoEof = true;
      feedVideoDecoder();
      if (videoDecoder && videoDecoder.state === 'configured' && videoPacketQueue.length === 0) {
        void videoDecoder.flush().catch(() => {});
      }
    } else {
      feedVideoDecoder();
    }
    return !videoEof && videoDemuxUntil < targetUntil && videoPacketBytes < MAX_VIDEO_PACKET_BYTES;
  }

  async function pumpAudioStep() {
    if (closed || !aFmtCtx || !activeAudioStream || !decCtx || audioEof) return false;
    const mediaNow = currentMediaTime();
    const audioWindowTarget = Math.min(targetUntil, mediaNow + MAX_AUDIO_AHEAD_SECONDS);
    if (audioDemuxUntil >= audioWindowTarget && workletBufferedSeconds >= MAX_AUDIO_AHEAD_SECONDS * 0.75) {
      return false;
    }

    const curSeekGen = seekGen;
    const curAudioGen = audioGen;
    const [readRes, packetsByStream] = await libav.ff_read_frame_multi(aFmtCtx, aReadPkt, { limit: 262144 });
    if (closed || curSeekGen !== seekGen || curAudioGen !== audioGen) return false;
    const isEof = readRes === libav.AVERROR_EOF;
    let aPkts = packetsByStream[activeAudioStream.index] || [];

    if (waitingForAudioSync && aPkts.length) {
      const syncIdx = aPkts.findIndex(p => hasAudioSyncHeader(activeAudioStream, p));
      if (syncIdx >= 0) {
        waitingForAudioSync = false;
        aPkts = syncIdx > 0 ? aPkts.slice(syncIdx) : aPkts;
      } else {
        aPkts = [];
      }
    }

    if (aPkts.length && audioNextSample === null) {
      const firstSec =
        packetPtsSeconds(libav, aPkts[0], activeAudioStream.tbNum, activeAudioStream.tbDen) ?? bufferedStart;
      audioNextSample = Math.max(0, Math.round(firstSec * outSampleRate));
    }

    let emittedAudioBatch = false;
    if (aPkts.length || isEof) {
      const decodedFrames = await libav.ff_decode_multi(decCtx, decPkt, decFrame, aPkts, {
        fin: isEof,
        ignoreErrors: true,
        copyoutFrame: 'ptr',
      });
      if (decodedFrames.length) await ensureAudioFilter(decodedFrames[0]);
      if (filterGraph && (decodedFrames.length || isEof)) {
        const filtered = await libav.ff_filter_multi(bufSrc, bufSink, decFrame, decodedFrames, {
          fin: isEof,
          copyoutFrame: 'ptr',
        });
        const leftParts = [];
        const rightParts = [];
        let totalSamples = 0;
        const batchStartSample = audioNextSample ?? Math.round(audioDemuxUntil * outSampleRate);

        for (const fPtr of filtered) {
          const nbSamples = await libav.AVFrame_nb_samples(fPtr);
          if (nbSamples > 0) {
            const ptrL = await libav.AVFrame_data_a(fPtr, 0);
            const ptrR = await libav.AVFrame_data_a(fPtr, 1);
            const l = new Float32Array(await libav.copyout_f32(ptrL, nbSamples));
            const r = ptrR ? new Float32Array(await libav.copyout_f32(ptrR, nbSamples)) : new Float32Array(l);
            leftParts.push(l);
            rightParts.push(r);
            totalSamples += nbSamples;
          }
          await libav.av_frame_free_js(fPtr);
        }

        if (totalSamples > 0) {
          audioNextSample = batchStartSample + totalSamples;
          let leftOut;
          let rightOut;
          if (leftParts.length === 1) {
            leftOut = leftParts[0];
            rightOut = rightParts[0];
          } else {
            leftOut = new Float32Array(totalSamples);
            rightOut = new Float32Array(totalSamples);
            let off = 0;
            for (let i = 0; i < leftParts.length; i++) {
              leftOut.set(leftParts[i], off);
              rightOut.set(rightParts[i], off);
              off += leftParts[i].length;
            }
          }

          let outStartSample = batchStartSample;
          let outSamples = totalSamples;
          if (audioTrimBeforeSample !== null) {
            if (batchStartSample < audioTrimBeforeSample) {
              const trim = Math.min(totalSamples, audioTrimBeforeSample - batchStartSample);
              outStartSample = batchStartSample + trim;
              outSamples = totalSamples - trim;
              if (outSamples > 0 && trim > 0) {
                leftOut = leftOut.slice(trim);
                rightOut = rightOut.slice(trim);
              }
            }
            if (batchStartSample + totalSamples >= audioTrimBeforeSample) {
              audioTrimBeforeSample = null;
            }
          }

          if (outSamples > 0) {
            emittedAudioBatch = true;
            audioDemuxUntil = Math.max(audioDemuxUntil, (outStartSample + outSamples) / outSampleRate);
            if (audioPort) {
              audioPort.postMessage(
                {
                  type: 'pcm',
                  seekGen: curSeekGen,
                  audioGen: curAudioGen,
                  startSample: outStartSample,
                  left: leftOut,
                  right: rightOut,
                  eof: isEof,
                },
                [leftOut.buffer, rightOut.buffer],
              );
            } else {
              postMessageFn(
                {
                  type: 'audioPcm',
                  seekGen: curSeekGen,
                  audioGen: curAudioGen,
                  startSample: outStartSample,
                  sampleRate: outSampleRate,
                  samples: outSamples,
                  left: leftOut,
                  right: rightOut,
                  bufferedUntil: audioDemuxUntil,
                  eof: isEof,
                },
                [leftOut.buffer, rightOut.buffer],
              );
            }
          }
        }
      } else {
        for (const fPtr of decodedFrames) await libav.av_frame_free_js(fPtr);
      }
    }

    if (isEof) {
      audioEof = true;
      audioTrimBeforeSample = null;
      waitingForAudioSync = false;
      if (!emittedAudioBatch) {
        audioPort?.postMessage({ type: 'eof', seekGen: curSeekGen });
        if (!audioPort) {
          postMessageFn({
            type: 'audioPcm',
            seekGen: curSeekGen,
            audioGen: curAudioGen,
            startSample: audioNextSample ?? Math.round(bufferedStart * outSampleRate),
            sampleRate: outSampleRate,
            samples: 0,
            left: new Float32Array(0),
            right: new Float32Array(0),
            bufferedUntil: audioDemuxUntil,
            eof: true,
          });
        }
      }
    }
    return !audioEof && (audioTrimBeforeSample !== null || audioDemuxUntil < audioWindowTarget);
  }

  async function pumpSubtitleStep() {
    if (closed || !sFmtCtx || !activeSubStream || subEof || subDemuxUntil >= targetUntil + 5) return false;
    const curSeekGen = seekGen;
    const curSubGen = subGen;
    const [readRes, packetsByStream] = await libav.ff_read_frame_multi(sFmtCtx, sReadPkt, { limit: 262144 });
    if (closed || curSeekGen !== seekGen || curSubGen !== subGen) return false;
    const isEof = readRes === libav.AVERROR_EOF;
    const sPkts = packetsByStream[activeSubStream.index] || [];

    if (sPkts.length) {
      if (activeSubStream.delivery === 'cues') {
        const cues = [];
        for (const sp of sPkts) {
          const start = packetPtsSeconds(libav, sp, activeSubStream.tbNum, activeSubStream.tbDen);
          if (start === undefined || !sp.data?.length) continue;
          const dur = sp.duration > 0 ? (sp.duration * activeSubStream.tbNum) / activeSubStream.tbDen : 3.5;
          subDemuxUntil = Math.max(subDemuxUntil, start + dur);
          let raw = sp.data;
          if (activeSubStream.codec === 'srt' && raw.length >= 2 && (raw[0] << 8) + raw[1] <= raw.length - 2) {
            const movLen = (raw[0] << 8) + raw[1];
            if (movLen > 0 && raw[2] >= 0x20) raw = raw.subarray(2, 2 + movLen);
          }
          const text = cleanSubripText(textDecoder.decode(raw));
          if (text) cues.push({ start, end: start + Math.max(0.25, dur), text });
        }
        if (cues.length) postMessageFn({ type: 'subtitleCues', subGen: curSubGen, cues });
      } else if (activeSubStream.delivery === 'ass') {
        let lines = '';
        for (const sp of sPkts) {
          const start = packetPtsSeconds(libav, sp, activeSubStream.tbNum, activeSubStream.tbDen);
          if (start === undefined || !sp.data?.length) continue;
          const dur = sp.duration > 0 ? (sp.duration * activeSubStream.tbNum) / activeSubStream.tbDen : 3.5;
          subDemuxUntil = Math.max(subDemuxUntil, start + dur);
          const line = matroskaAssToDialogue(textDecoder.decode(sp.data), start, start + Math.max(0.05, dur));
          if (line && !seenAssEvents.has(line)) {
            if (seenAssEvents.size > 20000) seenAssEvents.clear();
            seenAssEvents.add(line);
            lines += line;
          }
        }
        if (lines) {
          const chunk = new TextEncoder().encode(lines);
          postMessageFn({ type: 'subtitleData', subGen: curSubGen, format: 'ass', data: chunk }, [chunk.buffer]);
        }
      } else if (activeSubStream.delivery === 'pgs') {
        const parts = [];
        for (const sp of sPkts) {
          const start = packetPtsSeconds(libav, sp, activeSubStream.tbNum, activeSubStream.tbDen) ?? 0;
          subDemuxUntil = Math.max(subDemuxUntil, start);
          const sup = wrapPgsPacketToSup(sp.data, start);
          if (sup?.length) parts.push(sup);
        }
        const chunk = joinChunks(parts);
        if (chunk.length) {
          postMessageFn({ type: 'subtitleData', subGen: curSubGen, format: 'pgs', data: chunk }, [chunk.buffer]);
        }
      }
    }

    if (isEof) subEof = true;
    return !subEof && subDemuxUntil < targetUntil + 5;
  }

  function pumpLoop() {
    if (closed) return;
    if (pumping) {
      pumpRequested = true;
      return;
    }
    pumping = true;
    pumpRequested = false;
    void enqueue(async () => {
      try {
        while (!closed) {
          const moreVideo = await pumpVideoStep();
          const moreAudio = await pumpAudioStep();
          const moreSub = await pumpSubtitleStep();
          emitBufferProgress();
          if (!moreAudio && !moreVideo && !moreSub) break;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } catch (err) {
        if (!closed) {
          postMessageFn({
            type: 'error',
            kind: err?.kind || 'demux-failed',
            message: err?.message || 'Media demuxer failed.',
          });
        }
      } finally {
        pumping = false;
        if (pumpRequested && !closed) {
          pumpLoop();
        }
      }
    });
  }

  async function cleanup() {
    closed = true;
    cancelRenderTick();
    blockReadHandlers.delete(vDevName);
    blockReadHandlers.delete(aDevName);
    blockReadHandlers.delete(sDevName);
    for (const pending of pendingReads.values()) pending.reject(new Error('Worker closed'));
    pendingReads.clear();
    inflightBlocks.clear();
    blockCache.clear();
    seenAssEvents.clear();
    clearVideoPackets();
    clearDecodedFrames();
    if (videoDecoder) {
      try {
        if (videoDecoder.state !== 'closed') videoDecoder.close();
      } catch {}
      videoDecoder = null;
    }
    renderer?.destroy?.();
    renderer = null;
    if (audioPort) {
      try {
        audioPort.onmessage = null;
        audioPort.close?.();
      } catch {}
      audioPort = null;
    }
    if (!libav) return;
    try {
      await freeAudioDecoder();
      if (vReadPkt) (await libav.av_packet_free_js(vReadPkt), (vReadPkt = 0));
      if (aReadPkt) (await libav.av_packet_free_js(aReadPkt), (aReadPkt = 0));
      if (sReadPkt) (await libav.av_packet_free_js(sReadPkt), (sReadPkt = 0));
      for (const [ctx, dev] of [
        [vFmtCtx, vDevName],
        [aFmtCtx, aDevName],
        [sFmtCtx, sDevName],
      ]) {
        if (ctx) await libav.avformat_close_input_js(ctx);
        await libav.unlink(dev).catch(() => {});
      }
      vFmtCtx = aFmtCtx = sFmtCtx = 0;
    } catch {}
  }

  function attachAudioPort(port) {
    if (audioPort) {
      try {
        audioPort.onmessage = null;
      } catch {}
    }
    audioPort = port;
    audioPort.onmessage = ev => {
      const data = ev.data;
      if (data?.type === 'audioState') {
        workletBufferedSeconds = Number(data.bufferedSeconds) || 0;
        if (workletBufferedSeconds < MAX_AUDIO_AHEAD_SECONDS * 0.6) {
          pumpLoop();
        }
      }
    };
  }

  function onMessage(msg, ports) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'attachAudioPort' && (ports?.[0] || msg.port)) {
      attachAudioPort(ports?.[0] || msg.port);
      return;
    }
    if (msg.type === 'readResult') {
      const pending = pendingReads.get(msg.id);
      if (!pending) return;
      pendingReads.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(new Uint8Array(msg.bytes || 0));
      return;
    }
    if (msg.type === 'close') {
      void cleanup();
      return;
    }
    if (msg.type === 'clockSync') {
      if (Number.isFinite(msg.mediaTime)) {
        clockAnchorMedia = Math.max(0, msg.mediaTime);
        clockAnchorWallMs = nowMs();
      }
      if (typeof msg.paused === 'boolean') clockPaused = msg.paused;
      if (Number.isFinite(msg.playbackRate) && msg.playbackRate > 0) clockRate = msg.playbackRate;
      if (!clockPaused) {
        if (clockAnchorMedia + aheadBudgetSeconds * 0.65 > targetUntil - aheadBudgetSeconds * 0.35) {
          targetUntil = Math.max(targetUntil, clockAnchorMedia + aheadBudgetSeconds);
          pumpLoop();
        }
        scheduleRenderTick(0);
      }
      return;
    }
    if (msg.type === 'setHdrTarget') {
      targetHdr = Boolean(msg.targetHdr);
      renderer?.setTargetHdr?.(targetHdr);
      return;
    }
    if (msg.type === 'init') {
      if (ports?.[0] || msg.audioPort) attachAudioPort(ports?.[0] || msg.audioPort);
      void enqueue(async () => {
        try {
          await init(msg);
        } catch (err) {
          if (!closed) {
            postMessageFn({
              type: 'error',
              kind: err?.kind || 'init-failed',
              message: err?.message || 'Could not open media container.',
            });
          }
        }
      });
      return;
    }
    if (msg.type === 'pump') {
      if (Number.isFinite(msg.targetUntil) && msg.targetUntil > targetUntil) {
        targetUntil = msg.targetUntil;
        pumpLoop();
      }
      return;
    }
    if (msg.type === 'seek') {
      seekGen = msg.seekGen;
      targetUntil = Math.max(0, Number(msg.time) || 0) + (msg.aheadSeconds || aheadBudgetSeconds);
      void enqueue(async () => {
        try {
          await performSeek(msg.time, msg.seekGen);
          postMessageFn({ type: 'seeked', seekGen: msg.seekGen, time: Math.max(0, Number(msg.time) || 0) });
        } catch (err) {
          if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Media seek failed.' });
        }
      }).then(() => pumpLoop());
      return;
    }
    if (msg.type === 'selectAudio') {
      // Glitch-free audio switch: ONLY seeks/rebuilds aFmtCtx + audio decoder, NEVER touches vFmtCtx or VideoDecoder!
      audioGen = msg.audioGen;
      void enqueue(async () => {
        try {
          const nextAudio =
            audioStreams.find(a => a.id === msg.audioId) ||
            audioStreams.find(a => a.default) ||
            audioStreams[0] ||
            null;
          const switchTime = Math.max(0, Number(msg.time) || currentMediaTime() || 0);
          await initAudioDecoder(nextAudio);
          if (aFmtCtx && nextAudio) {
            await seekAudioContext(nextAudio, switchTime);
          }
          audioDemuxUntil = switchTime;
          audioEof = false;
          workletBufferedSeconds = 0;
          audioPort?.postMessage({
            type: 'reset',
            seekGen,
            audioGen: msg.audioGen,
            startSample: Math.round(switchTime * outSampleRate),
          });
          targetUntil = Math.max(targetUntil, switchTime + aheadBudgetSeconds);
          postMessageFn({
            type: 'audioSwitched',
            audioGen: msg.audioGen,
            selectedAudioId: nextAudio?.id || null,
            surroundDialogueActive: surroundDialogueActive(),
          });
        } catch (err) {
          if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Audio track switch failed.' });
        }
      }).then(() => pumpLoop());
      return;
    }
    if (msg.type === 'setAudioMode') {
      // Glitch-free audio mode update: rebuilds only the audio filter graph and seeks aFmtCtx to playhead, never video!
      const nextMode = ['normal', 'dialogue', 'night'].includes(msg.mode) ? msg.mode : 'normal';
      if (nextMode === audioMode) return;
      audioMode = nextMode;
      audioGen = msg.audioGen ?? audioGen;
      void enqueue(async () => {
        try {
          const switchTime = Math.max(0, Number(msg.time) || currentMediaTime() || 0);
          if (filterGraph) {
            await libav.avfilter_graph_free_js(filterGraph);
            filterGraph = bufSrc = bufSink = 0;
            filterSig = '';
          }
          if (aFmtCtx && activeAudioStream) {
            if (decCtx) await libav.avcodec_flush_buffers(decCtx);
            await seekAudioContext(activeAudioStream, switchTime);
            audioDemuxUntil = switchTime;
            audioEof = false;
            workletBufferedSeconds = 0;
            audioPort?.postMessage({
              type: 'reset',
              seekGen,
              audioGen,
              startSample: Math.round(switchTime * outSampleRate),
            });
            targetUntil = Math.max(targetUntil, switchTime + aheadBudgetSeconds);
          }
          postMessageFn({
            type: 'audioModeApplied',
            audioMode,
            surroundDialogueActive: surroundDialogueActive(),
          });
        } catch (err) {
          if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Audio mode update failed.' });
        }
      }).then(() => pumpLoop());
      return;
    }
    if (msg.type === 'selectSubtitle') {
      // Glitch-free subtitle switch: uses its own lazy sFmtCtx, never resetting video or audio!
      subGen = msg.subGen;
      void enqueue(async () => {
        seenAssEvents.clear();
        const nextSub = subtitleStreams.find(s => s.id === msg.subtitleId) || null;
        activeSubStream = nextSub;
        if (!nextSub) return;
        if (!sFmtCtx) {
          registerDeviceReader(sDevName);
          await libav.mkblockreaderdev(sDevName, fileSize);
          const [ctx] = await libav.ff_init_demuxer_file(sDevName);
          sFmtCtx = ctx;
          sReadPkt = await libav.av_packet_alloc();
        }
        await configureStreamDiscards(sFmtCtx, [nextSub.index]);
        const fonts = nextSub.delivery === 'ass' ? fontAttachments.map(f => new Uint8Array(f)) : [];
        const header = nextSub.extradata?.length ? new Uint8Array(nextSub.extradata) : undefined;
        postMessageFn({
          type: 'subtitleInit',
          subGen: msg.subGen,
          subtitleId: nextSub.id,
          format: nextSub.delivery,
          header,
          fonts,
        });
        const subStart = Number.isFinite(msg.time) ? Math.max(0, msg.time) : 0;
        subDemuxUntil = subStart;
        subEof = false;
        await seekFormatContext(sFmtCtx, nextSub, subStart);
      }).then(() => pumpLoop());
    }
  }

  return {
    onMessage,
    cleanup,
    _videoStream: () => vStream,
    _latestRpu: () => latestRpu,
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  const engine = createWorkerEngine((msg, transfer) => self.postMessage(msg, transfer || []));
  self.onmessage = event => engine.onMessage(event.data, event.ports);
}
