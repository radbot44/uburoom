import LibAV from './vendor/libav/libav-uburoom.mjs';
import LibAVFactory from './vendor/libav/libav-6.11.9.0.2-uburoom.wasm.mjs';

/* Web Worker media engine: demuxes containers (MKV, MP4/MOV, WebM, MPEG-TS, AVI), copies
 * video packets into fragmented MP4 (stripping Dolby Vision Profile 7 EL/RPU NALs when needed),
 * decodes home-theater audio (DTS/DTS-HD MA, TrueHD, E-AC-3, AC-3, FLAC, ALAC, PCM, Opus, AAC)
 * into 48 kHz stereo FLAC or AAC fMP4, and extracts embedded subtitles and MKV font attachments.
 */

const BLOCK_SIZE = 1024 * 1024;
const MAX_CACHED_BLOCKS = 12;
const OUT_SAMPLE_RATE = 48000;
const OUT_CHANNEL_LAYOUT = 0x3; // AV_CH_LAYOUT_STEREO
const PASSTHROUGH_AUDIO_MIMES = Object.freeze({
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  opus: 'audio/mp4; codecs="opus"',
  flac: 'audio/mp4; codecs="flac"',
  mp3: 'audio/mp4; codecs="mp4a.40.34"',
});

const DISPOSITION_DEFAULT = 0x0001;
const DISPOSITION_COMMENT = 0x0008;
const DISPOSITION_FORCED = 0x0040;
const DISPOSITION_HEARING_IMPAIRED = 0x0080;
const DISPOSITION_VISUAL_IMPAIRED = 0x0100;

let sharedLibAVPromise;
let nextEngineSeq = 1;
const blockReadHandlers = new Map();
const writeHandlers = new Map();

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
        la.onwrite = (name, pos, data) => {
          const handler = writeHandlers.get(name);
          if (handler) handler(name, pos, data);
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

function buildVideoMime(codecName, extradata, bitDepth = 8) {
  const name = String(codecName || '').toLowerCase();
  if (name === 'h264' || name === 'avc1') {
    if (extradata && extradata.length >= 4 && extradata[0] === 1) {
      return `video/mp4; codecs="avc1.${hex2(extradata[1])}${hex2(extradata[2])}${hex2(extradata[3])}"`;
    }
    if (extradata && extradata.length >= 7) {
      for (let i = 0; i + 6 < extradata.length; i++) {
        const sc3 = extradata[i] === 0 && extradata[i + 1] === 0 && extradata[i + 2] === 1;
        const sc4 = sc3 && i > 0 && extradata[i - 1] === 0;
        if (sc3 && !sc4 && (extradata[i + 3] & 0x1f) === 7 && i + 6 < extradata.length) {
          return `video/mp4; codecs="avc1.${hex2(extradata[i + 4])}${hex2(extradata[i + 5])}${hex2(extradata[i + 6])}"`;
        }
        if (
          extradata[i] === 0 &&
          extradata[i + 1] === 0 &&
          extradata[i + 2] === 0 &&
          extradata[i + 3] === 1 &&
          i + 7 < extradata.length &&
          (extradata[i + 4] & 0x1f) === 7
        ) {
          return `video/mp4; codecs="avc1.${hex2(extradata[i + 5])}${hex2(extradata[i + 6])}${hex2(extradata[i + 7])}"`;
        }
      }
    }
    return `video/mp4; codecs="${bitDepth > 8 ? 'avc1.6e0028' : 'avc1.640028'}"`;
  }
  if (name === 'hevc' || name === 'h265' || name === 'hvc1' || name === 'hev1') {
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
      return `video/mp4; codecs="hvc1.${space}${profileIdc}.${compatRev}.${tier}${levelIdc}.${constraintStr}"`;
    }
    return `video/mp4; codecs="${bitDepth >= 10 ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L93.B0'}"`;
  }
  if (name === 'av1' || name === 'av01') {
    if (extradata && extradata.length >= 4 && (extradata[0] & 0x80) !== 0) {
      const seqProfile = (extradata[1] >> 5) & 0x7;
      const seqLevelIdx0 = String(extradata[1] & 0x1f).padStart(2, '0');
      const seqTier0 = (extradata[2] >> 7) & 1 ? 'H' : 'M';
      const highBitdepth = (extradata[2] >> 6) & 1;
      const twelveBit = (extradata[2] >> 5) & 1;
      const depth = highBitdepth ? (twelveBit ? '12' : '10') : '08';
      return `video/mp4; codecs="av01.${seqProfile}.${seqLevelIdx0}${seqTier0}.${depth}"`;
    }
    return `video/mp4; codecs="${bitDepth >= 10 ? 'av01.0.12M.10' : 'av01.0.08M.08'}"`;
  }
  if (name === 'vp9') {
    return `video/mp4; codecs="${bitDepth >= 10 ? 'vp09.02.41.10' : 'vp09.00.41.08'}"`;
  }
  if (name === 'mpeg4') return 'video/mp4; codecs="mp4v.20.9"';
  return '';
}

/**
 * Strips Dolby Vision RPU (NAL 62) and Enhancement Layer (NAL 63) units from
 * length-prefixed HEVC packets so Profile 7/8 streams play as clean 10-bit HDR10.
 */
function stripDolbyVisionNals(data, nalLenSize = 4) {
  if (!data || data.length < nalLenSize + 2) return data;
  let hasDv = false;
  let offset = 0;
  while (offset + nalLenSize < data.length) {
    let len = 0;
    for (let i = 0; i < nalLenSize; i++) len = len * 256 + data[offset + i];
    if (len <= 0 || offset + nalLenSize + len > data.length) return data;
    const nalType = (data[offset + nalLenSize] >> 1) & 0x3f;
    if (nalType === 62 || nalType === 63) {
      hasDv = true;
      break;
    }
    offset += nalLenSize + len;
  }
  if (!hasDv) return data;
  const kept = [];
  let total = 0;
  offset = 0;
  while (offset + nalLenSize <= data.length) {
    let len = 0;
    for (let i = 0; i < nalLenSize; i++) len = len * 256 + data[offset + i];
    if (len <= 0 || offset + nalLenSize + len > data.length) break;
    const nalType = (data[offset + nalLenSize] >> 1) & 0x3f;
    if (nalType !== 62 && nalType !== 63) {
      const slice = data.subarray(offset, offset + nalLenSize + len);
      kept.push(slice);
      total += slice.length;
    }
    offset += nalLenSize + len;
  }
  if (!total) return data;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of kept) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
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
  // Matroska ASS packet format: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
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
  // Already contains 'PG' 13-byte SUP header?
  if (data.length >= 13 && data[0] === 0x50 && data[1] === 0x47) return data;
  const pts90k = Math.max(0, Math.round(ptsSeconds * 90000)) >>> 0;
  const segments = [];
  let total = 0;
  let offset = 0;
  while (offset + 3 <= data.length) {
    const segLen = (data[offset + 1] << 8) | data[offset + 2];
    if (offset + 3 + segLen > data.length) break;
    const out = new Uint8Array(10 + 3 + segLen);
    out[0] = 0x50; // 'P'
    out[1] = 0x47; // 'G'
    out[2] = (pts90k >>> 24) & 0xff;
    out[3] = (pts90k >>> 16) & 0xff;
    out[4] = (pts90k >>> 8) & 0xff;
    out[5] = pts90k & 0xff;
    // DTS = 0
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

function packetPtsSeconds(pkt, tbNum, tbDen) {
  if (pkt.pts !== undefined && pkt.ptshi !== -0x80000000) {
    const raw = pkt.pts + (pkt.ptshi || 0) * 0x100000000;
    return (raw * tbNum) / tbDen;
  }
  if (pkt.dts !== undefined && pkt.dtshi !== -0x80000000) {
    const raw = pkt.dts + (pkt.dtshi || 0) * 0x100000000;
    return (raw * tbNum) / tbDen;
  }
  return undefined;
}

export function createWorkerEngine(postMessageFn) {
  const engineId = nextEngineSeq++;
  const inDevName = `in_${engineId}.media`;
  const vOutName = `v_out_${engineId}.mp4`;
  const aOutName = `a_out_${engineId}.mp4`;
  let libav;
  let closed = false;
  let fileSize = 0;
  let nextReadId = 1;
  const pendingReads = new Map();
  const blockCache = new Map();

  let fmtCtx = 0;
  let vStream = null;
  let audioStreams = [];
  let subtitleStreams = [];
  let fontAttachments = [];
  let chapters = [];

  let vCodecName = '';
  let vNalLenSize = 4;
  let vCodecParCopy = 0;
  let vOc = 0,
    vPb = 0,
    vOutSt = 0,
    vOutTbNum = 1,
    vOutTbDen = 90000;
  let vInitSent = false;
  const vChunks = [];

  let activeAudioStream = null;
  let outAudioCodec = 'aac';
  let audioMode = 'normal';
  let passthroughAudioCodecs = new Set();
  let audioPassthrough = false;
  let activeAudioMime = '';
  let aCodecParCopy = 0;
  let lastAudioDts = null;
  let suppressVideoUntil = 0;
  let decCtx = 0,
    decPkt = 0,
    decFrame = 0;
  let encCtx = 0,
    encFrame = 0,
    encPkt = 0,
    encFrameSize = 1024;
  let filterGraph = 0,
    bufSrc = 0,
    bufSink = 0;
  let filterSig = '';
  let aOc = 0,
    aPb = 0,
    aOutSt = 0,
    aOutTbNum = 1,
    aOutTbDen = OUT_SAMPLE_RATE;
  let audioNextPts = null;
  const aChunks = [];

  let activeSubStream = null;
  let subGen = 0;
  let seekGen = 0;
  let audioGen = 0;
  let readPkt = 0;
  let muxPkt = 0;
  let eofReached = false;
  let lastVideoDts = null;
  let synthesizeVideoDts = false;
  let bufferedUntil = 0;
  let targetUntil = 0;
  let pumping = false;
  let pumpRequested = false;
  let opChain = Promise.resolve();

  const textDecoder = new TextDecoder('utf-8', { fatal: false });

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
    const start = blockIndex * BLOCK_SIZE;
    const end = Math.min(fileSize, start + BLOCK_SIZE);
    if (start >= fileSize) return Promise.resolve(new Uint8Array(0));
    const id = nextReadId++;
    return new Promise((resolve, reject) => {
      pendingReads.set(id, {
        resolve: bytes => {
          cacheBlock(blockIndex, bytes);
          resolve(bytes);
        },
        reject,
      });
      postMessageFn({ type: 'read', id, start, end });
    });
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

  async function freeAudioPipeline() {
    if (filterGraph) {
      await libav.avfilter_graph_free_js(filterGraph);
      filterGraph = bufSrc = bufSink = 0;
      filterSig = '';
    }
    if (decCtx) {
      await libav.ff_free_decoder(decCtx, decPkt, decFrame);
      decCtx = decPkt = decFrame = 0;
    }
    if (encCtx) {
      await libav.ff_free_encoder(encCtx, encFrame, encPkt);
      encCtx = encFrame = encPkt = 0;
    }
    if (aCodecParCopy) {
      await libav.avcodec_parameters_free_js(aCodecParCopy);
      aCodecParCopy = 0;
    }
    if (aOc) {
      await libav.ff_free_muxer(aOc, aPb);
      aOc = aPb = aOutSt = 0;
      await libav.unlink(aOutName).catch(() => {});
    }
    aChunks.length = 0;
    audioNextPts = null;
    lastAudioDts = null;
    audioPassthrough = false;
    activeAudioMime = '';
  }

  function surroundDialogueActive() {
    return Boolean(
      activeAudioStream && activeAudioStream.channels > 2 && !audioPassthrough && audioMode === 'dialogue',
    );
  }

  async function canPassthroughAudio(streamInfo) {
    if (!streamInfo || !passthroughAudioCodecs.has(streamInfo.codec)) return false;
    if (streamInfo.channels > 2 && audioMode !== 'normal') return false;
    if (!PASSTHROUGH_AUDIO_MIMES[streamInfo.codec]) return false;
    if (streamInfo.codec !== 'mp3') {
      const extSize = await libav.AVCodecParameters_extradata_size(streamInfo.codecpar);
      if (extSize <= 0) return false;
    }
    return true;
  }

  async function initAudioPipeline(streamInfo) {
    await freeAudioPipeline();
    activeAudioStream = streamInfo;
    if (!streamInfo) return null;

    if (await canPassthroughAudio(streamInfo)) {
      aCodecParCopy = await libav.avcodec_parameters_alloc();
      await libav.avcodec_parameters_copy(aCodecParCopy, streamInfo.codecpar);
      await libav.AVCodecParameters_codec_tag_s(aCodecParCopy, 0);
      const mux = await libav.ff_init_muxer(
        { format_name: 'mp4', filename: aOutName, open: true, device: true, codecpars: true },
        [[aCodecParCopy, streamInfo.tbNum, streamInfo.tbDen]],
      );
      aOc = mux[0];
      aPb = mux[2];
      aOutSt = mux[3][0];
      await libav.av_opt_set(aOc, 'avoid_negative_ts', 'disabled', 0);
      await libav.av_opt_set(aOc, 'movflags', 'frag_keyframe+empty_moov+default_base_moof+frag_discont', 1);
      const ret = await libav.avformat_write_header(aOc, 0);
      if (ret >= 0) {
        await libav.avio_flush(aPb);
        aOutTbNum = await libav.AVStream_time_base_num(aOutSt);
        aOutTbDen = await libav.AVStream_time_base_den(aOutSt);
        audioPassthrough = true;
        activeAudioMime = PASSTHROUGH_AUDIO_MIMES[streamInfo.codec];
        return joinChunks(aChunks.splice(0));
      }
      await freeAudioPipeline();
      activeAudioStream = streamInfo;
    }

    const dec = await libav.ff_init_decoder(streamInfo.codecId, {
      codecpar: streamInfo.codecpar,
      time_base: [streamInfo.tbNum, streamInfo.tbDen],
    });
    decCtx = dec[1];
    decPkt = dec[2];
    decFrame = dec[3];

    const isFlac = outAudioCodec === 'flac';
    const outSampleFmt = isFlac ? libav.AV_SAMPLE_FMT_S16 : libav.AV_SAMPLE_FMT_FLTP;
    const enc = await libav.ff_init_encoder(outAudioCodec, {
      ctx: {
        sample_fmt: outSampleFmt,
        sample_rate: OUT_SAMPLE_RATE,
        bit_rate: isFlac ? 0 : 256000,
        channel_layout: OUT_CHANNEL_LAYOUT,
      },
      time_base: [1, OUT_SAMPLE_RATE],
    });
    encCtx = enc[1];
    encFrame = enc[2];
    encPkt = enc[3];
    encFrameSize = enc[4] || 4096;

    const mux = await libav.ff_init_muxer({ format_name: 'mp4', filename: aOutName, open: true, device: true }, [
      [encCtx, 1, OUT_SAMPLE_RATE],
    ]);
    aOc = mux[0];
    aPb = mux[2];
    aOutSt = mux[3][0];
    await libav.av_opt_set(aOc, 'avoid_negative_ts', 'disabled', 0);
    await libav.av_opt_set(aOc, 'movflags', 'frag_keyframe+empty_moov+default_base_moof+frag_discont', 1);
    const ret = await libav.avformat_write_header(aOc, 0);
    if (ret < 0) throw new Error('Audio fMP4 header initialization failed.');
    await libav.avio_flush(aPb);
    aOutTbNum = await libav.AVStream_time_base_num(aOutSt);
    aOutTbDen = await libav.AVStream_time_base_den(aOutSt);
    activeAudioMime = isFlac ? 'audio/mp4; codecs="flac"' : 'audio/mp4; codecs="mp4a.40.2"';
    return joinChunks(aChunks.splice(0));
  }

  async function ensureVideoMuxer(firstPkt) {
    if (vOc) return null;
    const extSize = await libav.AVCodecParameters_extradata_size(vCodecParCopy);
    if (extSize === 0 && firstPkt && /^(h264|hevc|av1)$/i.test(vCodecName)) {
      const bsf = await libav.av_bsf_get_by_name?.('extract_extradata');
      if (bsf) {
        const bsfPtrPtr = await libav.malloc(4);
        await libav.av_bsf_alloc(bsf, bsfPtrPtr);
        const bsfCtx = (await libav.copyout_u32(bsfPtrPtr, 1))[0];
        await libav.free(bsfPtrPtr);
        if (bsfCtx) {
          const parIn = await libav.AVBSFContext_par_in(bsfCtx);
          await libav.avcodec_parameters_copy(parIn, vCodecParCopy);
          if ((await libav.av_bsf_init(bsfCtx)) >= 0) {
            const tmpPkt = await libav.av_packet_alloc();
            await libav.ff_copyin_packet(tmpPkt, firstPkt);
            await libav.av_bsf_send_packet(bsfCtx, tmpPkt);
            while ((await libav.av_bsf_receive_packet(bsfCtx, tmpPkt)) >= 0) {
              await libav.av_packet_unref(tmpPkt);
            }
            const parOut = await libav.AVBSFContext_par_out(bsfCtx);
            const outExtSize = await libav.AVCodecParameters_extradata_size(parOut);
            if (outExtSize > 0) await libav.avcodec_parameters_copy(vCodecParCopy, parOut);
            await libav.av_packet_free_js(tmpPkt);
          }
          await libav.av_bsf_free_js(bsfCtx);
        }
      }
    }
    if (vCodecName === 'hevc') {
      await libav.AVCodecParameters_codec_tag_s(vCodecParCopy, 0x31637668); // 'hvc1'
      // Strip Dolby Vision dvcC/dvvC side-data so HDR10 hvc1 playback isn't rejected after stripping NAL 62/63.
      if (typeof libav.AVCodecParameters_nb_coded_side_data_s === 'function') {
        await libav.AVCodecParameters_nb_coded_side_data_s(vCodecParCopy, 0);
        await libav.AVCodecParameters_coded_side_data_s(vCodecParCopy, 0);
      }
    } else {
      await libav.AVCodecParameters_codec_tag_s(vCodecParCopy, 0);
    }
    const mux = await libav.ff_init_muxer(
      { format_name: 'mp4', filename: vOutName, open: true, device: true, codecpars: true },
      [[vCodecParCopy, vStream.tbNum, vStream.tbDen]],
    );
    vOc = mux[0];
    vPb = mux[2];
    vOutSt = mux[3][0];
    if (vCodecName === 'hevc') {
      const outPar = await libav.AVStream_codecpar(vOutSt);
      await libav.AVCodecParameters_codec_tag_s(outPar, 0x31637668);
    }
    await libav.av_opt_set(vOc, 'avoid_negative_ts', 'disabled', 0);
    await libav.av_opt_set(
      vOc,
      'movflags',
      'frag_keyframe+empty_moov+default_base_moof+frag_discont+negative_cts_offsets',
      1,
    );
    const ret = await libav.avformat_write_header(vOc, 0);
    if (ret < 0) throw new Error('Video fMP4 header initialization failed.');
    await libav.avio_flush(vPb);
    vOutTbNum = await libav.AVStream_time_base_num(vOutSt);
    vOutTbDen = await libav.AVStream_time_base_den(vOutSt);
    return joinChunks(vChunks.splice(0));
  }

  async function init(msg) {
    libav = await getSharedLibAV();
    fileSize = msg.fileSize;
    outAudioCodec = msg.flacSupported ? 'flac' : 'aac';
    audioMode = ['normal', 'dialogue', 'night'].includes(msg.audioMode) ? msg.audioMode : 'normal';
    passthroughAudioCodecs = new Set(
      Array.isArray(msg.passthroughAudioCodecs)
        ? msg.passthroughAudioCodecs.map(c => String(c || '').toLowerCase())
        : [],
    );
    blockCache.clear();
    if (msg.initialBytes) {
      const initView = msg.initialBytes instanceof Uint8Array ? msg.initialBytes : new Uint8Array(msg.initialBytes);
      const expectedBlock0 = Math.min(fileSize, BLOCK_SIZE);
      if (expectedBlock0 > 0 && initView.byteLength >= expectedBlock0) {
        cacheBlock(0, initView.byteLength === expectedBlock0 ? initView : initView.subarray(0, expectedBlock0));
      }
    }

    blockReadHandlers.set(inDevName, async (name, pos, len) => {
      try {
        const bytes = await readBytes(pos, len);
        await libav.ff_block_reader_dev_send(name, pos, bytes);
      } catch (err) {
        await libav.ff_block_reader_dev_send(name, pos, null, { error: err });
      }
    });
    writeHandlers.set(vOutName, (_name, _pos, data) => {
      vChunks.push(new Uint8Array(data));
    });
    writeHandlers.set(aOutName, (_name, _pos, data) => {
      aChunks.push(new Uint8Array(data));
    });

    await libav.mkblockreaderdev(inDevName, fileSize);
    const [ctx, streams] = await libav.ff_init_demuxer_file(inDevName);
    fmtCtx = ctx;

    const fmtDurLo = await libav.AVFormatContext_duration(fmtCtx);
    const fmtDurHi = await libav.AVFormatContext_durationhi(fmtCtx);
    const rawFmtDur = libav.i64tof64(fmtDurLo, fmtDurHi);
    let duration = rawFmtDur > 0 ? rawFmtDur / libav.AV_TIME_BASE : 0;

    try {
      const rawChapters = await libav.ff_get_demuxer_chapters(fmtCtx);
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
      const stPtr = (await libav.AVFormatContext_streams_a(fmtCtx, i)) || 0;
      const metaPtr = stPtr ? await libav.AVStream_metadata(stPtr) : 0;
      const meta = await readMetadataDict(metaPtr);
      const disp = stPtr && libav.AVStream_disposition ? await libav.AVStream_disposition(stPtr) : 0;
      const codecName = String((await libav.avcodec_get_name(s.codec_id)) || '').toLowerCase();
      const lang = (meta.language || meta.LANGUAGE || 'und').toLowerCase();
      const title = meta.title || meta.TITLE || '';

      if (s.codec_type === libav.AVMEDIA_TYPE_VIDEO && !vStream && !(disp & 0x0400 /* ATTACHED_PIC */)) {
        const width = await libav.AVCodecParameters_width(s.codecpar);
        const height = await libav.AVCodecParameters_height(s.codecpar);
        const pixFmt = await libav.AVCodecParameters_format(s.codecpar);
        const pixDesc = pixFmt >= 0 ? await libav.av_pix_fmt_desc_get(pixFmt) : 0;
        const bitDepth = pixDesc ? (await libav.AVPixFmtDescriptor_comp_depth(pixDesc)) || 8 : 8;
        const colorTrc = await libav.AVCodecParameters_color_trc(s.codecpar);
        const hdr = colorTrc === 16 /* SMPTE2084 PQ */ || colorTrc === 18; /* ARIB-STD-B67 HLG */
        const extradata = await copyExtradata(s.codecpar);
        if (codecName === 'hevc' && extradata.length >= 22 && extradata[0] === 1) {
          vNalLenSize = (extradata[21] & 3) + 1;
        }
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
          hdr,
          hdrKind: colorTrc === 16 ? 'hdr10' : colorTrc === 18 ? 'hlg' : 'sdr',
          extradata,
          videoMime: buildVideoMime(codecName, extradata, bitDepth),
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
    if (!vStream.videoMime) throw new Error(`Unsupported video codec: ${vStream.codecName}.`);
    vCodecName = vStream.codecName;

    vCodecParCopy = await libav.avcodec_parameters_alloc();
    await libav.avcodec_parameters_copy(vCodecParCopy, vStream.codecpar);
    readPkt = await libav.av_packet_alloc();
    muxPkt = await libav.av_packet_alloc();

    let videoInit = null;
    if (vStream.extradata.length > 0) {
      videoInit = await ensureVideoMuxer(null);
      vInitSent = true;
    }

    const chosenAudio =
      audioStreams.find(a => a.id === msg.audioId) || audioStreams.find(a => a.default) || audioStreams[0] || null;
    const audioInit = chosenAudio ? await initAudioPipeline(chosenAudio) : null;
    const audioMime = chosenAudio ? activeAudioMime : '';

    if (msg.probeOnly) {
      postMessageFn({
        type: 'probed',
        duration,
        video: {
          codec: vStream.codecName,
          mime: vStream.videoMime,
          width: vStream.width,
          height: vStream.height,
          bitDepth: vStream.bitDepth,
          hdr: vStream.hdr,
          hdrKind: vStream.hdrKind,
        },
        audioTracks: audioStreams.map(({ codecpar, ...pub }) => pub),
        subtitleTracks: subtitleStreams.map(({ codecpar, extradata, ...pub }) => pub),
        chapters,
      });
      return;
    }

    const transfers = [];
    if (videoInit?.byteLength) transfers.push(videoInit.buffer);
    if (audioInit?.byteLength) transfers.push(audioInit.buffer);

    postMessageFn(
      {
        type: 'ready',
        duration,
        video: {
          codec: vStream.codecName,
          mime: vStream.videoMime,
          width: vStream.width,
          height: vStream.height,
          bitDepth: vStream.bitDepth,
          hdr: vStream.hdr,
          hdrKind: vStream.hdrKind,
        },
        audioMime,
        audioPassthrough,
        surroundDialogueActive: surroundDialogueActive(),
        selectedAudioId: chosenAudio?.id || null,
        audioTracks: audioStreams.map(({ codecpar, ...pub }) => pub),
        subtitleTracks: subtitleStreams.map(({ codecpar, extradata, ...pub }) => pub),
        chapters,
        videoInit,
        audioInit,
      },
      transfers,
    );

    if (Number.isFinite(msg.startTime) && msg.startTime > 0.5) {
      await performSeek(msg.startTime, seekGen);
    }
    let effectiveAhead = msg.aheadSeconds || 30;
    if (fileSize > 0 && duration > 0) {
      const budgetSec = Math.max(4, Math.floor((72 * 1024 * 1024) / (fileSize / duration)));
      effectiveAhead = Math.min(effectiveAhead, budgetSec);
    }
    targetUntil = (msg.startTime || 0) + effectiveAhead;
    setTimeout(() => pumpLoop(), 0);
  }

  async function performSeek(seconds, gen) {
    if (!fmtCtx || !vStream) return;
    seekGen = gen;
    const clamped = Math.max(0, seconds);
    const ts = Math.round((clamped * vStream.tbDen) / vStream.tbNum);
    const [tsLo, tsHi] = libav.f64toi64(ts);
    let seekRet = await libav.avformat_seek_file_max(fmtCtx, vStream.index, tsLo, tsHi);
    if (seekRet < 0) {
      await libav.avformat_seek_file_approx(fmtCtx, vStream.index, tsLo, tsHi);
    }
    if (decCtx) await libav.avcodec_flush_buffers(decCtx);
    if (filterGraph) {
      await libav.avfilter_graph_free_js(filterGraph);
      filterGraph = bufSrc = bufSink = 0;
      filterSig = '';
    }
    audioNextPts = null;
    lastAudioDts = null;
    lastVideoDts = null;
    eofReached = false;
    bufferedUntil = clamped;
  }

  async function ensureAudioFilter(f0) {
    const fRate = (await libav.AVFrame_sample_rate(f0)) || 48000;
    const fFmt = await libav.AVFrame_format(f0);
    const fCh = (await libav.AVFrame_ch_layout_nb_channels(f0)) || 2;
    const fMask = (await libav.AVFrame_channel_layoutmask(f0)) || defaultMaskForChannels(fCh);
    const sig = `${fRate}:${fFmt}:${fMask}:${audioMode}`;
    if (filterGraph && filterSig === sig) return;
    if (filterGraph) {
      await libav.avfilter_graph_free_js(filterGraph);
      filterGraph = bufSrc = bufSink = 0;
    }
    const isFlac = outAudioCodec === 'flac';
    const outSampleFmt = isFlac ? libav.AV_SAMPLE_FMT_S16 : libav.AV_SAMPLE_FMT_FLTP;
    const filterDesc =
      fCh > 2
        ? audioMode === 'dialogue'
          ? 'aresample=48000:clev=1.414214:slev=0.5:lfe_mix_level=0.5'
          : audioMode === 'night'
            ? 'aresample=48000:clev=1.0:slev=0.707107:lfe_mix_level=0.5'
            : 'aresample=48000:clev=0.707107:slev=0.707107'
        : 'aresample=48000';
    const graph = await libav.ff_init_filter_graph(
      filterDesc,
      {
        sample_rate: fRate,
        sample_fmt: fFmt,
        channel_layout: fMask,
        time_base: [1, fRate],
      },
      {
        sample_rate: OUT_SAMPLE_RATE,
        sample_fmt: outSampleFmt,
        channel_layout: OUT_CHANNEL_LAYOUT,
        frame_size: encFrameSize || 4096,
      },
    );
    filterGraph = graph[0];
    bufSrc = graph[1];
    bufSink = graph[2];
    filterSig = sig;
  }

  async function pumpStep() {
    if (closed || !fmtCtx || eofReached || bufferedUntil >= targetUntil) return false;
    const curSeekGen = seekGen;
    const curAudioGen = audioGen;
    const [readRes, packetsByStream] = await libav.ff_read_frame_multi(fmtCtx, readPkt, { limit: 262144 });
    if (closed || curSeekGen !== seekGen) return false;
    const isEof = readRes === libav.AVERROR_EOF;

    const vPkts = packetsByStream[vStream.index] || [];
    let lazyVideoInit = null;
    if (vPkts.length && !vOc) {
      lazyVideoInit = await ensureVideoMuxer(vPkts[0]);
      vStream.videoMime =
        buildVideoMime(vCodecName, await copyExtradata(vCodecParCopy), vStream.bitDepth) || vStream.videoMime;
    }

    let maxVideoSec = bufferedUntil;
    if (vPkts.length && vOc) {
      let writePkts = vPkts;
      if (suppressVideoUntil > 0) {
        let resumeIdx = -1;
        for (let i = 0; i < vPkts.length; i++) {
          const sec = packetPtsSeconds(vPkts[i], vStream.tbNum, vStream.tbDen);
          if (sec !== undefined && sec > maxVideoSec) maxVideoSec = sec;
          if (
            resumeIdx < 0 &&
            (vPkts[i].flags & libav.AV_PKT_FLAG_KEY) !== 0 &&
            sec !== undefined &&
            sec >= suppressVideoUntil - 1.0
          ) {
            resumeIdx = i;
          }
        }
        if (resumeIdx >= 0) {
          writePkts = vPkts.slice(resumeIdx);
          suppressVideoUntil = 0;
        } else {
          writePkts = [];
        }
      }
      if (writePkts.length) {
        const scale = (vStream.tbNum * vOutTbDen) / (vStream.tbDen * vOutTbNum);
        // Pre-scan batch: Matroska does not store DTS, so FFmpeg's demuxer guesses dts=pts without
        // a decoder; detect missing or non-monotonic/out-of-order DTS before emitting packet 0 so
        // synthetic monotonic DTS starts cleanly with an 8-frame reorder lead.
        if (!synthesizeVideoDts) {
          let prevScanDts = lastVideoDts;
          for (const p of writePkts) {
            const hasPts = p.pts !== undefined && p.ptshi !== -0x80000000;
            const hasDts = p.dts !== undefined && p.dtshi !== -0x80000000;
            if (!hasDts) {
              synthesizeVideoDts = true;
              break;
            }
            const dtsScaled = Math.round(libav.i64tof64(p.dts, p.dtshi || 0) * scale);
            const ptsScaled = hasPts ? Math.round(libav.i64tof64(p.pts, p.ptshi || 0) * scale) : undefined;
            if (
              (ptsScaled !== undefined && dtsScaled > ptsScaled) ||
              (prevScanDts !== null && dtsScaled <= prevScanDts)
            ) {
              synthesizeVideoDts = true;
              break;
            }
            prevScanDts = dtsScaled;
          }
        }
        let syntheticStartDts = null;
        if (synthesizeVideoDts && lastVideoDts === null) {
          let offset = 0;
          let minLead = Infinity;
          for (const p of writePkts) {
            const hasPts = p.pts !== undefined && p.ptshi !== -0x80000000;
            const dur =
              p.duration > 0 ? Math.max(1, Math.round(p.duration * scale)) : Math.max(1, Math.round(vOutTbDen / 60));
            if (hasPts) {
              const sp = Math.max(0, Math.round(libav.i64tof64(p.pts, p.ptshi || 0) * scale));
              if (sp - offset < minLead) minLead = sp - offset;
            }
            offset += dur;
          }
          if (Number.isFinite(minLead)) syntheticStartDts = minLead;
        }
        for (const p of writePkts) {
          p.stream_index = 0;
          if (vCodecName === 'hevc' && p.data) {
            p.data = stripDolbyVisionNals(p.data, vNalLenSize);
          }
          const sec = packetPtsSeconds(p, vStream.tbNum, vStream.tbDen);
          if (sec !== undefined && sec > maxVideoSec) maxVideoSec = sec;
          const hasPts = p.pts !== undefined && p.ptshi !== -0x80000000;
          const hasDts = p.dts !== undefined && p.dtshi !== -0x80000000;
          const rawPts = hasPts ? libav.i64tof64(p.pts, p.ptshi || 0) : undefined;
          const rawDts = hasDts ? libav.i64tof64(p.dts, p.dtshi || 0) : undefined;
          const dur =
            p.duration > 0 ? Math.max(1, Math.round(p.duration * scale)) : Math.max(1, Math.round(vOutTbDen / 60));
          p.duration = dur;
          const sp =
            rawPts !== undefined
              ? Math.max(0, Math.round(rawPts * scale))
              : lastVideoDts !== null
                ? lastVideoDts + dur
                : 0;
          let sd;
          if (!synthesizeVideoDts && rawDts !== undefined) {
            sd = Math.round(rawDts * scale);
            if (lastVideoDts !== null && sd <= lastVideoDts) sd = lastVideoDts + 1;
          } else {
            sd = lastVideoDts === null ? (syntheticStartDts ?? sp - 2 * dur) : lastVideoDts + dur;
          }
          lastVideoDts = sd;
          // Preserve exact presentation timestamp (never clamp sp to sd) so >2 B-frame pyramids stay in order.
          const [ptsLo, ptsHi] = libav.f64toi64(sp);
          const [dtsLo, dtsHi] = libav.f64toi64(sd);
          p.pts = ptsLo;
          p.ptshi = ptsHi;
          p.dts = dtsLo;
          p.dtshi = dtsHi;
          p.time_base_num = vOutTbNum;
          p.time_base_den = vOutTbDen;
        }
        await libav.ff_write_multi(vOc, muxPkt, writePkts, false);
        await libav.av_write_frame(vOc, 0);
        await libav.avio_flush(vPb);
      }
    }

    let maxAudioSec = bufferedUntil;
    if (activeAudioStream && aOc) {
      const aPkts = packetsByStream[activeAudioStream.index] || [];
      if (audioPassthrough) {
        if (aPkts.length) {
          const scale = (activeAudioStream.tbNum * aOutTbDen) / (activeAudioStream.tbDen * aOutTbNum);
          for (const ap of aPkts) {
            ap.stream_index = 0;
            const sec = packetPtsSeconds(ap, activeAudioStream.tbNum, activeAudioStream.tbDen);
            if (sec !== undefined && sec > maxAudioSec) maxAudioSec = sec;
            const hasPts = ap.pts !== undefined && ap.ptshi !== -0x80000000;
            const hasDts = ap.dts !== undefined && ap.dtshi !== -0x80000000;
            const rawPts = hasPts ? ap.pts + (ap.ptshi || 0) * 0x100000000 : undefined;
            const rawDts = hasDts ? ap.dts + (ap.dtshi || 0) * 0x100000000 : undefined;
            const dur =
              ap.duration > 0 ? Math.max(1, Math.round(ap.duration * scale)) : Math.max(1, Math.round(aOutTbDen / 50));
            ap.duration = dur;
            const rawTs = rawPts ?? rawDts;
            let sp =
              rawTs !== undefined
                ? Math.max(0, Math.round(rawTs * scale))
                : lastAudioDts !== null
                  ? lastAudioDts + dur
                  : 0;
            if (lastAudioDts !== null && sp <= lastAudioDts) sp = lastAudioDts + 1;
            lastAudioDts = sp;
            ap.pts = sp >>> 0;
            ap.ptshi = Math.floor(sp / 0x100000000);
            ap.dts = ap.pts;
            ap.dtshi = ap.ptshi;
            ap.time_base_num = aOutTbNum;
            ap.time_base_den = aOutTbDen;
          }
          await libav.ff_write_multi(aOc, muxPkt, aPkts, false);
          await libav.av_write_frame(aOc, 0);
          await libav.avio_flush(aPb);
        }
      } else {
        if (aPkts.length && audioNextPts === null) {
          const firstSec =
            packetPtsSeconds(aPkts[0], activeAudioStream.tbNum, activeAudioStream.tbDen) ?? bufferedUntil;
          audioNextPts = Math.max(0, Math.round(firstSec * OUT_SAMPLE_RATE));
        }
        if (aPkts.length || isEof) {
          const decodedFrames = await libav.ff_decode_multi(decCtx, decPkt, decFrame, aPkts, {
            fin: isEof,
            ignoreErrors: true,
            copyoutFrame: 'ptr',
          });
          if (decodedFrames.length) await ensureAudioFilter(decodedFrames[0]);
          if (filterGraph && (decodedFrames.length || isEof)) {
            // ff_filter_multi and ff_encode_multi consume AVFrame* pointers via ff_copyin_frame.
            const filtered = await libav.ff_filter_multi(bufSrc, bufSink, decFrame, decodedFrames, {
              fin: isEof,
              copyoutFrame: 'ptr',
            });
            for (const fPtr of filtered) {
              const nbSamples = await libav.AVFrame_nb_samples(fPtr);
              const pts = audioNextPts ?? 0;
              await libav.AVFrame_pts_s(fPtr, pts >>> 0);
              await libav.AVFrame_ptshi_s(fPtr, Math.floor(pts / 0x100000000));
              audioNextPts = pts + nbSamples;
              maxAudioSec = Math.max(maxAudioSec, audioNextPts / OUT_SAMPLE_RATE);
            }
            const encoded = await libav.ff_encode_multi(encCtx, encFrame, encPkt, filtered, isEof);
            if (encoded.length) {
              const scale = aOutTbDen / (OUT_SAMPLE_RATE * aOutTbNum);
              for (const ep of encoded) {
                ep.stream_index = 0;
                const pts = ep.pts !== undefined ? ep.pts + (ep.ptshi || 0) * 0x100000000 : 0;
                const sp = Math.max(0, Math.round(pts * scale));
                ep.pts = sp >>> 0;
                ep.ptshi = Math.floor(sp / 0x100000000);
                ep.dts = ep.pts;
                ep.dtshi = ep.ptshi;
                ep.time_base_num = aOutTbNum;
                ep.time_base_den = aOutTbDen;
                if (ep.duration > 0) ep.duration = Math.round(ep.duration * scale);
              }
              await libav.ff_write_multi(aOc, muxPkt, encoded, false);
              await libav.av_write_frame(aOc, 0);
              await libav.avio_flush(aPb);
            }
          } else {
            for (const fPtr of decodedFrames) await libav.av_frame_free_js(fPtr);
          }
        }
      }
    }

    if (activeSubStream && packetsByStream[activeSubStream.index]?.length) {
      const sPkts = packetsByStream[activeSubStream.index];
      if (activeSubStream.delivery === 'cues') {
        const cues = [];
        for (const sp of sPkts) {
          const start = packetPtsSeconds(sp, activeSubStream.tbNum, activeSubStream.tbDen);
          if (start === undefined || !sp.data?.length) continue;
          const dur = sp.duration > 0 ? (sp.duration * activeSubStream.tbNum) / activeSubStream.tbDen : 3.5;
          let raw = sp.data;
          // mov_text prepends a 2-byte big-endian UTF-8 byte length
          if (activeSubStream.codec === 'srt' && raw.length >= 2 && (raw[0] << 8) + raw[1] <= raw.length - 2) {
            const movLen = (raw[0] << 8) + raw[1];
            if (movLen > 0 && raw[2] >= 0x20) raw = raw.subarray(2, 2 + movLen);
          }
          const text = cleanSubripText(textDecoder.decode(raw));
          if (text) cues.push({ start, end: start + Math.max(0.25, dur), text });
        }
        if (cues.length) postMessageFn({ type: 'subtitleCues', subGen, cues });
      } else if (activeSubStream.delivery === 'ass') {
        let lines = '';
        for (const sp of sPkts) {
          const start = packetPtsSeconds(sp, activeSubStream.tbNum, activeSubStream.tbDen);
          if (start === undefined || !sp.data?.length) continue;
          const dur = sp.duration > 0 ? (sp.duration * activeSubStream.tbNum) / activeSubStream.tbDen : 3.5;
          lines += matroskaAssToDialogue(textDecoder.decode(sp.data), start, start + Math.max(0.05, dur));
        }
        if (lines) {
          const chunk = new TextEncoder().encode(lines);
          postMessageFn({ type: 'subtitleData', subGen, format: 'ass', data: chunk }, [chunk.buffer]);
        }
      } else if (activeSubStream.delivery === 'pgs') {
        const parts = [];
        for (const sp of sPkts) {
          const start = packetPtsSeconds(sp, activeSubStream.tbNum, activeSubStream.tbDen) ?? 0;
          const sup = wrapPgsPacketToSup(sp.data, start);
          if (sup?.length) parts.push(sup);
        }
        const chunk = joinChunks(parts);
        if (chunk.length) {
          postMessageFn({ type: 'subtitleData', subGen, format: 'pgs', data: chunk }, [chunk.buffer]);
        }
      }
    }

    const videoBytes = joinChunks(vChunks.splice(0));
    const audioBytes = joinChunks(aChunks.splice(0));
    bufferedUntil = Math.max(bufferedUntil, maxVideoSec, maxAudioSec);
    if (isEof) eofReached = true;

    const transfers = [];
    if (lazyVideoInit?.byteLength) transfers.push(lazyVideoInit.buffer);
    if (videoBytes.byteLength) transfers.push(videoBytes.buffer);
    if (audioBytes.byteLength) transfers.push(audioBytes.buffer);

    if (lazyVideoInit || videoBytes.byteLength || audioBytes.byteLength || isEof) {
      postMessageFn(
        {
          type: 'segment',
          seekGen: curSeekGen,
          audioGen: curAudioGen,
          videoInit: lazyVideoInit,
          videoMime: lazyVideoInit ? vStream.videoMime : undefined,
          videoBytes,
          audioBytes,
          bufferedUntil,
          eof: isEof,
        },
        transfers,
      );
      if (lazyVideoInit) vInitSent = true;
    }
    return !eofReached && bufferedUntil < targetUntil;
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
        while (!closed && !eofReached && bufferedUntil < targetUntil) {
          const more = await pumpStep();
          if (!more) break;
          // Yield between batches so seek/selectAudio messages can interleave immediately!
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } catch (err) {
        if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Media demuxer failed.' });
      } finally {
        pumping = false;
        if (pumpRequested && !closed && !eofReached && bufferedUntil < targetUntil) {
          pumpLoop();
        }
      }
    });
  }

  async function cleanup() {
    closed = true;
    blockReadHandlers.delete(inDevName);
    writeHandlers.delete(vOutName);
    writeHandlers.delete(aOutName);
    for (const pending of pendingReads.values()) pending.reject(new Error('Worker closed'));
    pendingReads.clear();
    blockCache.clear();
    if (!libav) return;
    try {
      await freeAudioPipeline();
      if (readPkt) (await libav.av_packet_free_js(readPkt), (readPkt = 0));
      if (muxPkt) (await libav.av_packet_free_js(muxPkt), (muxPkt = 0));
      if (vCodecParCopy) (await libav.avcodec_parameters_free_js(vCodecParCopy), (vCodecParCopy = 0));
      if (vOc) {
        await libav.ff_free_muxer(vOc, vPb);
        vOc = vPb = vOutSt = 0;
        await libav.unlink(vOutName).catch(() => {});
      }
      if (fmtCtx) {
        await libav.avformat_close_input_js(fmtCtx);
        fmtCtx = 0;
      }
      await libav.unlink(inDevName).catch(() => {});
    } catch {}
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
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
    if (msg.type === 'init') {
      void enqueue(async () => {
        try {
          await init(msg);
        } catch (err) {
          if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Could not open media container.' });
        }
      });
      return;
    }
    if (msg.type === 'pause') {
      if (Number.isInteger(msg.seekGen) && msg.seekGen > seekGen) seekGen = msg.seekGen;
      targetUntil = bufferedUntil;
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
      suppressVideoUntil = 0;
      targetUntil = msg.time + (msg.aheadSeconds || 30);
      void enqueue(async () => {
        try {
          await performSeek(msg.time, msg.seekGen);
          postMessageFn({ type: 'seeked', seekGen: msg.seekGen, time: msg.time });
        } catch (err) {
          if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Media seek failed.' });
        }
      }).then(() => pumpLoop());
      return;
    }
    if (msg.type === 'selectAudio') {
      audioGen = msg.audioGen;
      void enqueue(async () => {
        try {
          const prevBuffered = bufferedUntil;
          const nextAudio =
            audioStreams.find(a => a.id === msg.audioId) ||
            audioStreams.find(a => a.default) ||
            audioStreams[0] ||
            null;
          const audioInit = nextAudio ? await initAudioPipeline(nextAudio) : null;
          suppressVideoUntil = msg.time > 0 && prevBuffered > msg.time + 0.5 ? prevBuffered : 0;
          await performSeek(msg.time || 0, msg.seekGen ?? seekGen);
          targetUntil = (msg.time || 0) + (msg.aheadSeconds || 30);
          const transfers = audioInit?.byteLength ? [audioInit.buffer] : [];
          postMessageFn(
            {
              type: 'audioSwitched',
              audioGen: msg.audioGen,
              seekGen: msg.seekGen ?? seekGen,
              selectedAudioId: nextAudio?.id || null,
              audioMime: activeAudioMime,
              audioPassthrough,
              surroundDialogueActive: surroundDialogueActive(),
              audioInit,
            },
            transfers,
          );
        } catch (err) {
          if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Audio track switch failed.' });
        }
      }).then(() => pumpLoop());
      return;
    }
    if (msg.type === 'setAudioMode') {
      const nextMode = ['normal', 'dialogue', 'night'].includes(msg.mode) ? msg.mode : 'normal';
      if (nextMode === audioMode) return;
      audioMode = nextMode;
      audioGen = msg.audioGen ?? audioGen;
      void enqueue(async () => {
        try {
          if (!activeAudioStream || activeAudioStream.channels <= 2) {
            postMessageFn({
              type: 'audioModeApplied',
              audioMode,
              audioPassthrough,
              surroundDialogueActive: surroundDialogueActive(),
            });
            return;
          }
          const prevBuffered = bufferedUntil;
          const audioInit = await initAudioPipeline(activeAudioStream);
          suppressVideoUntil = msg.time > 0 && prevBuffered > msg.time + 0.5 ? prevBuffered : 0;
          await performSeek(msg.time || 0, msg.seekGen ?? seekGen);
          targetUntil = (msg.time || 0) + (msg.aheadSeconds || 30);
          const transfers = audioInit?.byteLength ? [audioInit.buffer] : [];
          postMessageFn(
            {
              type: 'audioSwitched',
              audioGen: msg.audioGen ?? audioGen,
              seekGen: msg.seekGen ?? seekGen,
              selectedAudioId: activeAudioStream.id,
              audioMime: activeAudioMime,
              audioPassthrough,
              surroundDialogueActive: surroundDialogueActive(),
              audioInit,
            },
            transfers,
          );
        } catch (err) {
          if (!closed) postMessageFn({ type: 'error', message: err?.message || 'Audio mode update failed.' });
        }
      }).then(() => pumpLoop());
      return;
    }
    if (msg.type === 'selectSubtitle') {
      subGen = msg.subGen;
      suppressVideoUntil = 0;
      void enqueue(async () => {
        const nextSub = subtitleStreams.find(s => s.id === msg.subtitleId) || null;
        activeSubStream = nextSub;
        if (!nextSub) return;
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
        if (Number.isFinite(msg.time)) {
          await performSeek(msg.time, ++seekGen);
          targetUntil = msg.time + (msg.aheadSeconds || 30);
          postMessageFn({ type: 'subtitleReseed', seekGen, time: msg.time });
        }
      }).then(() => pumpLoop());
    }
  }

  return { onMessage, cleanup, _hasInit: () => vInitSent };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  const engine = createWorkerEngine((msg, transfer) => self.postMessage(msg, transfer || []));
  self.onmessage = event => engine.onMessage(event.data);
}
