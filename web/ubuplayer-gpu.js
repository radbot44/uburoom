// @ts-check
/* UbuPlayer GPU color pipeline & Dolby Vision / HDR metadata engine.
 * Implements libplacebo-equivalent static-peak ITU-R BT.2390 EETF (peak_detect=0),
 * Dolby Vision Profile 5 IPTPQc2 + RPU polynomial/MMR reshaping, Profile 7/8 NAL 62/63
 * handling, zero-copy VideoFrame SDR pre-clamping bypass (Chromium Issue 40944011),
 * 10-bit I420P10 planar upload, BT.2020 -> BT.709 gamut mapping, and 1-pass deband + dither
 * across OffscreenCanvas WebGPU with automatic WebGL2 fallback.
 */

const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;
export const SDR_WHITE_NITS = 203.0;

// libplacebo exact IPTPQc2 (with c2 crosstalk) -> PQ-LMS matrix (row-major 3x3)
export const IPTPQ_TO_LMS_MATRIX = Object.freeze([
  1.0, 0.097569, 0.20522643, 1.0, -0.11387689, 0.1332175, 1.0, 0.03261511, -0.67688712,
]);

// libplacebo / Hunt-Pointer-Estevez linear LMS -> linear BT.2020 RGB matrix (row-major 3x3)
export const LMS_TO_BT2020_MATRIX = Object.freeze([
  3.06441879, -2.16597676, 0.10155818, -0.65612108, 1.78554118, -0.12943749, 0.01736321, -0.04725154, 1.03004253,
]);

// Linear BT.2020 RGB -> Linear BT.709 RGB matrix (row-major 3x3)
export const BT2020_TO_BT709_MATRIX = Object.freeze([
  1.660491, -0.5876411, -0.07284986, -0.1245505, 1.1328999, -0.00834942, -0.01815076, -0.1005789, 1.1187297,
]);

// Linear BT.2020 RGB -> Linear Display-P3 RGB matrix (D65, row-major 3x3)
export const BT2020_TO_DISPLAY_P3_MATRIX = Object.freeze([
  1.34357825, -0.28217967, -0.06139858, -0.06529745, 1.07578792, -0.01049046, 0.00282179, -0.01959849, 1.01677671,
]);

export const IDENTITY_3X3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

// BT.2020nc full-range YCbCr -> R'G'B' (offset [0, 0.5, 0.5])
export const BT2020_YCC_TO_RGB = Object.freeze([1.0, 0.0, 1.4746, 1.0, -0.1645531, -0.5713531, 1.0, 1.8814, 0.0]);

// BT.709 full-range YCbCr -> R'G'B' (and exact inverse for Chromium Issue 40944011 zero-copy recovery)
export const BT709_YCC_TO_RGB = Object.freeze([1.0, 0.0, 1.5748, 1.0, -0.1873243, -0.4681243, 1.0, 1.8556, 0.0]);

export const BT709_RGB_TO_YCC_FULL = Object.freeze([
  0.2126, 0.7152, 0.0722, -0.1145721, -0.3854279, 0.5, 0.5, -0.4541529, -0.0458471,
]);

export function pqToNits(e) {
  const v = Math.max(0, Math.min(1, Number(e) || 0));
  if (v <= 0) return 0;
  const p = v ** (1 / PQ_M2);
  const num = Math.max(0, p - PQ_C1);
  const den = PQ_C2 - PQ_C3 * p;
  if (den <= 1e-9) return 10000;
  return 10000 * (num / den) ** (1 / PQ_M1);
}

export function nitsToPq(nits) {
  const y = Math.max(0, Math.min(1, (Number(nits) || 0) / 10000));
  if (y <= 0) return 0;
  const ym = y ** PQ_M1;
  return ((PQ_C1 + PQ_C2 * ym) / (1 + PQ_C3 * ym)) ** PQ_M2;
}

/**
 * Remove H.264/HEVC RBSP emulation prevention bytes (`0x00 0x00 0x03` -> `0x00 0x00`).
 * @param {Uint8Array} src
 * @returns {Uint8Array}
 */
export function removeRbspEmulationPrevention(src) {
  if (!src || src.length < 3) return src || new Uint8Array(0);
  let hasEpb = false;
  for (let i = 2; i < src.length; i++) {
    if (src[i] === 3 && src[i - 1] === 0 && src[i - 2] === 0) {
      hasEpb = true;
      break;
    }
  }
  if (!hasEpb) return src;
  const out = new Uint8Array(src.length);
  let w = 0;
  let zeros = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[w++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, w);
}

/**
 * Insert H.264/HEVC RBSP emulation prevention bytes (`0x00 0x00 0x00..0x03` -> `0x00 0x00 0x03 ...`).
 * @param {Uint8Array} rbsp
 * @returns {Uint8Array}
 */
export function addRbspEmulationPrevention(rbsp) {
  if (!rbsp || rbsp.length < 3) return rbsp ? rbsp.slice() : new Uint8Array(0);
  const out = [];
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i];
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

function writeBitInPlace(bytes, bitPos, bit) {
  const byteIdx = bitPos >> 3;
  const shift = 7 - (bitPos & 7);
  if (bit) bytes[byteIdx] |= 1 << shift;
  else bytes[byteIdx] &= ~(1 << shift);
}

function writeBitsInPlace(bytes, bitPos, count, value) {
  for (let i = 0; i < count; i++) {
    const bit = (value >>> (count - 1 - i)) & 1;
    writeBitInPlace(bytes, bitPos + i, bit);
  }
}

/**
 * Patch an HEVC SPS NAL unit (`NAL 33`, including its 2-byte NAL header) in-place so its
 * VUI colour tags declare full-range BT.709 / sRGB (`full_range=1, primaries=1, transfer=13, matrix=1`).
 * Because HEVC VUI tags are purely display metadata, hardware decoders output identical 10-bit YUV
 * samples while stamping `VideoFrame.colorSpace` as full-range BT.709/sRGB, bypassing Chromium's
 * internal HDR->SDR pre-clamping LUT at zero CPU/bandwidth cost.
 * @param {Uint8Array} nal
 * @returns {{nal: Uint8Array, patched: boolean}}
 */
export function patchHevcSpsVuiToSdrFullRange(nal, { fullRange = false } = {}) {
  if (!nal || nal.length < 16 || ((nal[0] >> 1) & 0x3f) !== 33) {
    return { nal, patched: false };
  }
  const rbspOrig = removeRbspEmulationPrevention(nal.subarray(2));
  const br = new BitReader(rbspOrig);
  try {
    br.skipBits(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = br.readBits(3);
    br.skipBits(1); // sps_temporal_id_nesting_flag

    // profile_tier_level(1, maxSubLayersMinus1)
    br.skipBits(96); // general_profile_space..general_level_idc (12 bytes)
    const subProfilePresent = [];
    const subLevelPresent = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      subProfilePresent.push(br.readBit());
      subLevelPresent.push(br.readBit());
    }
    if (maxSubLayersMinus1 > 0) {
      for (let i = maxSubLayersMinus1; i < 8; i++) br.skipBits(2);
    }
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      if (subProfilePresent[i]) br.skipBits(88);
      if (subLevelPresent[i]) br.skipBits(8);
    }

    br.readUE(); // sps_seq_parameter_set_id
    const chromaFormatIdc = br.readUE();
    if (chromaFormatIdc === 3) br.skipBits(1); // separate_colour_plane_flag
    br.readUE(); // pic_width_in_luma_samples
    br.readUE(); // pic_height_in_luma_samples
    if (br.readBit()) {
      // conformance_window_flag
      br.readUE();
      br.readUE();
      br.readUE();
      br.readUE();
    }
    br.readUE(); // bit_depth_luma_minus8
    br.readUE(); // bit_depth_chroma_minus8
    const log2MaxPocLsbMinus4 = br.readUE();
    const subLayerOrdering = br.readBit();
    for (let i = subLayerOrdering ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
      br.readUE();
      br.readUE();
      br.readUE();
    }
    for (let i = 0; i < 6; i++) br.readUE();
    if (br.readBit()) {
      // scaling_list_enabled_flag
      if (br.readBit()) {
        // sps_scaling_list_data_present_flag
        for (let sizeId = 0; sizeId < 4; sizeId++) {
          const step = sizeId === 3 ? 3 : 1;
          for (let matrixId = 0; matrixId < 6; matrixId += step) {
            if (!br.readBit()) {
              br.readUE(); // scaling_list_pred_matrix_id_delta
            } else {
              const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
              if (sizeId > 1) br.readSE(); // scaling_list_dc_coef_minus8
              for (let k = 0; k < coefNum; k++) br.readSE();
            }
          }
        }
      }
    }
    br.skipBits(2); // amp_enabled_flag, sample_adaptive_offset_enabled_flag
    if (br.readBit()) {
      // pcm_enabled_flag
      br.skipBits(8);
      br.readUE();
      br.readUE();
      br.skipBits(1);
    }
    const numStRps = br.readUE();
    const numDeltaPocs = new Array(numStRps).fill(0);
    for (let idx = 0; idx < numStRps; idx++) {
      const interPred = idx !== 0 ? br.readBit() : 0;
      if (interPred) {
        const refIdx = idx - 1;
        br.skipBits(1); // delta_rps_sign
        br.readUE(); // abs_delta_rps_minus1
        let count = 0;
        const refCount = numDeltaPocs[refIdx] || 0;
        for (let j = 0; j <= refCount; j++) {
          const used = br.readBit();
          const useDelta = used ? 1 : br.readBit();
          if (used || useDelta) count++;
        }
        numDeltaPocs[idx] = count;
      } else {
        const numNeg = br.readUE();
        const numPos = br.readUE();
        for (let i = 0; i < numNeg; i++) {
          br.readUE();
          br.skipBits(1);
        }
        for (let i = 0; i < numPos; i++) {
          br.readUE();
          br.skipBits(1);
        }
        numDeltaPocs[idx] = numNeg + numPos;
      }
    }
    if (br.readBit()) {
      // long_term_ref_pics_present_flag
      const numLt = br.readUE();
      for (let i = 0; i < numLt; i++) {
        br.skipBits(log2MaxPocLsbMinus4 + 4);
        br.skipBits(1);
      }
    }
    br.skipBits(2); // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
    if (!br.readBit()) return { nal, patched: false }; // vui_parameters_present_flag

    // vui_parameters()
    if (br.readBit()) {
      // aspect_ratio_info_present_flag
      const arIdc = br.readBits(8);
      if (arIdc === 255) br.skipBits(32);
    }
    if (br.readBit()) br.skipBits(1); // overscan_info_present_flag
    if (!br.readBit()) return { nal, patched: false }; // video_signal_type_present_flag

    br.skipBits(3); // video_format
    const fullRangePos = br.bitPos;
    br.skipBits(1); // video_full_range_flag
    const colourDescPresent = br.readBit();
    let primariesPos = -1;
    let transferPos = -1;
    let matrixPos = -1;
    if (colourDescPresent) {
      primariesPos = br.bitPos;
      br.skipBits(8);
      transferPos = br.bitPos;
      br.skipBits(8);
      matrixPos = br.bitPos;
      br.skipBits(8);
    }

    const rbspPatched = rbspOrig.slice();
    writeBitInPlace(rbspPatched, fullRangePos, fullRange ? 1 : 0);
    if (colourDescPresent) {
      writeBitsInPlace(rbspPatched, primariesPos, 8, 1); // BT.709 primaries
      writeBitsInPlace(rbspPatched, transferPos, 8, 13); // IEC 61966-2-1 (sRGB)
      writeBitsInPlace(rbspPatched, matrixPos, 8, 1); // BT.709 matrix
    }
    const escaped = addRbspEmulationPrevention(rbspPatched);
    const out = new Uint8Array(2 + escaped.length);
    out[0] = nal[0];
    out[1] = nal[1];
    out.set(escaped, 2);
    return { nal: out, patched: true };
  } catch {
    return { nal, patched: false };
  }
}

/**
 * Rewrite `NAL 33` (SPS) entries inside an `hvcC` extradata record so hardware HEVC decoders
 * tag output frames as full-range BT.709 / sRGB instead of PQ / BT.2020.
 * @param {Uint8Array} extradata
 * @returns {{extradata: Uint8Array, patched: boolean}}
 */
export function patchHvccForRawHdrDecode(extradata, options = {}) {
  if (!extradata || extradata.length < 23 || extradata[0] !== 1) {
    return { extradata, patched: false };
  }
  const numArrays = extradata[22];
  let offset = 23;
  const parts = [extradata.subarray(0, 23)];
  let total = 23;
  let anyPatched = false;

  for (let a = 0; a < numArrays && offset + 3 <= extradata.length; a++) {
    const arrHeader = extradata.subarray(offset, offset + 3);
    const nalType = arrHeader[0] & 0x3f;
    const numNalus = (arrHeader[1] << 8) | arrHeader[2];
    offset += 3;
    parts.push(arrHeader);
    total += 3;

    for (let n = 0; n < numNalus && offset + 2 <= extradata.length; n++) {
      const len = (extradata[offset] << 8) | extradata[offset + 1];
      offset += 2;
      if (offset + len > extradata.length) return { extradata, patched: false };
      let nal = extradata.subarray(offset, offset + len);
      offset += len;
      if (nalType === 33) {
        const res = patchHevcSpsVuiToSdrFullRange(nal, options);
        if (res.patched) {
          nal = res.nal;
          anyPatched = true;
        }
      }
      const lenBytes = new Uint8Array([(nal.length >> 8) & 0xff, nal.length & 0xff]);
      parts.push(lenBytes, nal);
      total += 2 + nal.length;
    }
  }
  if (!anyPatched) return { extradata, patched: false };
  if (offset < extradata.length) {
    const tail = extradata.subarray(offset);
    parts.push(tail);
    total += tail.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return { extradata: out, patched: true };
}

export class BitReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.bitPos = 0;
    this.totalBits = bytes.length * 8;
  }

  get bitsLeft() {
    return this.totalBits - this.bitPos;
  }

  readBit() {
    if (this.bitPos >= this.totalBits) throw new RangeError('BitReader EOF');
    const byteIdx = this.bitPos >> 3;
    const shift = 7 - (this.bitPos & 7);
    this.bitPos++;
    return (this.bytes[byteIdx] >> shift) & 1;
  }

  /** @param {number} count */
  readBits(count) {
    if (count === 0) return 0;
    if (count < 0 || count > 32 || this.bitPos + count > this.totalBits) {
      throw new RangeError('BitReader out of range');
    }
    let val = 0;
    for (let i = 0; i < count; i++) {
      val = val * 2 + this.readBit();
    }
    return val;
  }

  /** @param {number} count */
  readSignedBits(count) {
    const u = this.readBits(count);
    const signBit = 2 ** (count - 1);
    return u >= signBit ? u - 2 ** count : u;
  }

  skipBits(count) {
    if (this.bitPos + count > this.totalBits) throw new RangeError('BitReader skip EOF');
    this.bitPos += count;
  }

  readUE() {
    let zeros = 0;
    while (this.bitPos < this.totalBits && this.readBit() === 0) {
      zeros++;
      if (zeros > 31) throw new RangeError('Exp-Golomb overflow');
    }
    if (zeros === 0) return 0;
    return 2 ** zeros - 1 + this.readBits(zeros);
  }

  readSE() {
    const code = this.readUE();
    if (code === 0) return 0;
    return code & 1 ? (code + 1) / 2 : -(code / 2);
  }
}

function invMatrix3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;
  return [A * invDet, D * invDet, G * invDet, B * invDet, E * invDet, H * invDet, C * invDet, F * invDet, I * invDet];
}

/**
 * Parse a Dolby Vision configuration record (`dvcC` / `dvvC` or FFmpeg `AVDOVIDecoderConfigurationRecord`).
 * @param {Uint8Array} bytes
 */
export function parseDolbyVisionConfigRecord(bytes) {
  if (!bytes || bytes.length < 4) return null;
  // ISO BMFF dvcC/dvvC 4-byte record:
  // byte 0: dv_version_major, byte 1: dv_version_minor,
  // byte 2..3: profile(7 bits) | level(6 bits) | rpu_present(1) | el_present(1) | bl_present(1),
  // byte 4: bl_signal_compatibility_id(4 bits) | reserved(4)
  if (bytes.length >= 8 && bytes[0] === 1 && bytes[1] === 0 && bytes[2] <= 10 && bytes[3] <= 13 && bytes[4] <= 1) {
    // FFmpeg AVDOVIDecoderConfigurationRecord struct (8 bytes of uint8_t fields)
    return {
      dvVersionMajor: bytes[0],
      dvVersionMinor: bytes[1],
      dvProfile: bytes[2],
      dvLevel: bytes[3],
      rpuPresent: Boolean(bytes[4]),
      elPresent: Boolean(bytes[5]),
      blPresent: Boolean(bytes[6]),
      blCompatId: bytes[7],
    };
  }
  if (bytes.length >= 5 && bytes[0] === 1) {
    const word = (bytes[2] << 8) | bytes[3];
    const dvProfile = (word >> 9) & 0x7f;
    const dvLevel = (word >> 3) & 0x3f;
    if (dvProfile >= 4 && dvProfile <= 10) {
      return {
        dvVersionMajor: bytes[0],
        dvVersionMinor: bytes[1],
        dvProfile,
        dvLevel,
        rpuPresent: Boolean((word >> 2) & 1),
        elPresent: Boolean((word >> 1) & 1),
        blPresent: Boolean(word & 1),
        blCompatId: (bytes[4] >> 4) & 0x0f,
      };
    }
  }
  return null;
}

export function createDoviRpuContext(dvProfile = 0) {
  return {
    dvProfile: Number(dvProfile) || 0,
    header: null,
    vdr: new Map(),
    mapping: null,
    color: null,
  };
}

function readRpuSignedCoef(br, coefDataType, log2Denom) {
  if (coefDataType === 0) {
    const ipart = br.readSE();
    const fpart = log2Denom > 0 ? br.readBits(log2Denom) : 0;
    return ipart + fpart / 2 ** log2Denom;
  }
  const bits = br.readBits(32);
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint32(0, bits >>> 0, false);
  return dv.getFloat32(0, false);
}

function readRpuUnsignedCoef(br, coefDataType, log2Denom) {
  if (coefDataType === 0) {
    const ipart = br.readUE();
    const fpart = log2Denom > 0 ? br.readBits(log2Denom) : 0;
    return ipart + fpart / 2 ** log2Denom;
  }
  const bits = br.readBits(32);
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint32(0, bits >>> 0, false);
  return dv.getFloat32(0, false);
}

function guessDoviProfileFromHeader(hdr) {
  if (hdr.vdrRpuProfile === 0 && hdr.blVideoFullRangeFlag) return 5;
  if (hdr.vdrRpuProfile === 1) {
    if (hdr.elSpatialResamplingFilterFlag && !hdr.disableResidualFlag) {
      return hdr.vdrBitDepth === 12 ? 7 : 4;
    }
    return 8;
  }
  return 0;
}

/**
 * Parse a Dolby Vision `NAL 62` (`UNSPEC62`) RPU unit into normalized GPU reshaping curves
 * and DM color metadata, matching FFmpeg 6.1 `ff_dovi_rpu_parse` & `libplacebo`.
 * Accepts either the full HEVC NAL (`0x7C 0x01 0x19 ...`), `0x19`-prefixed RPU bytes, or raw RBSP.
 * @param {Uint8Array} rawInput
 * @param {ReturnType<typeof createDoviRpuContext>} [ctx]
 */
export function parseDolbyVisionRpu(rawInput, ctx = createDoviRpuContext()) {
  if (!rawInput || rawInput.length < 4) return null;
  let slice = rawInput;
  // Strip 2-byte HEVC UNSPEC62 NAL header (nal_unit_type === 62 -> (b0 >> 1) & 0x3f === 62)
  if (((slice[0] >> 1) & 0x3f) === 62 && slice.length > 3) {
    slice = slice.subarray(2);
  }
  const rbsp = removeRbspEmulationPrevention(slice);
  if (rbsp.length < 4) return null;
  // Trailing 0x80 RBSP stop bit + CRC32 sit at the end; BitReader reads header/payload from bit 0.
  const br = new BitReader(rbsp);
  try {
    if (rbsp[0] === 0x19) {
      br.skipBits(8);
    }
    const rpuType = br.readBits(6);
    if (rpuType !== 2) return null;
    const rpuFormat = br.readBits(11);
    const vdrRpuProfile = br.readBits(4);
    const vdrRpuLevel = br.readBits(4);
    const vdrSeqInfoPresent = br.readBit();

    const hdr = ctx.header
      ? { ...ctx.header }
      : {
          blBitDepth: 10,
          elBitDepth: 10,
          vdrBitDepth: 12,
          coefDataType: 0,
          coefLog2Denom: 23,
          vdrRpuNormalizedIdc: 1,
          blVideoFullRangeFlag: 1,
          spatialResamplingFilterFlag: 0,
          elSpatialResamplingFilterFlag: 0,
          disableResidualFlag: 1,
        };
    hdr.rpuType = rpuType;
    hdr.rpuFormat = rpuFormat;
    hdr.vdrRpuProfile = vdrRpuProfile;
    hdr.vdrRpuLevel = vdrRpuLevel;

    if (vdrSeqInfoPresent) {
      hdr.chromaResamplingExplicitFilterFlag = br.readBit();
      hdr.coefDataType = br.readBits(2);
      if (hdr.coefDataType > 1) return null;
      hdr.coefLog2Denom = hdr.coefDataType === 0 ? br.readUE() : 23;
      if (hdr.coefLog2Denom < 1 || hdr.coefLog2Denom > 32) return null;
      hdr.vdrRpuNormalizedIdc = br.readBits(2);
      hdr.blVideoFullRangeFlag = br.readBit();
      if ((rpuFormat & 0x700) === 0) {
        const blMinus8 = br.readUE();
        const elMinus8Raw = br.readUE();
        const elMinus8 = elMinus8Raw & 0xff;
        const vdrMinus8 = br.readUE();
        if (blMinus8 > 8 || elMinus8 > 8 || vdrMinus8 > 8) return null;
        hdr.blBitDepth = blMinus8 + 8;
        hdr.elBitDepth = elMinus8 + 8;
        hdr.vdrBitDepth = vdrMinus8 + 8;
        hdr.spatialResamplingFilterFlag = br.readBit();
        br.skipBits(3); // reserved_zero_3bits
        hdr.elSpatialResamplingFilterFlag = br.readBit();
        hdr.disableResidualFlag = br.readBit();
      }
    }
    ctx.header = hdr;

    const dmMetadataPresent = br.readBit();
    const usePrevVdrRpu = br.readBit();
    const useNlq = (rpuFormat & 0x700) === 0 && !hdr.disableResidualFlag;
    const profile = ctx.dvProfile || guessDoviProfileFromHeader(hdr) || 5;

    let vdrEntry;
    if (usePrevVdrRpu) {
      const prevId = br.readUE();
      vdrEntry = ctx.vdr.get(prevId);
      if (!vdrEntry) return null;
      ctx.mapping = vdrEntry.mapping;
    } else {
      const vdrRpuId = br.readUE();
      if (vdrRpuId > 15) return null;
      vdrEntry = ctx.vdr.get(vdrRpuId) || { mapping: null, color: null };
      ctx.vdr.set(vdrRpuId, vdrEntry);

      const mappingColorSpace = br.readUE();
      const mappingChromaFormatIdc = br.readUE();
      const maxBlVal = (1 << hdr.blBitDepth) - 1;
      const curves = [];

      for (let c = 0; c < 3; c++) {
        const numPivotsMinus2 = br.readUE();
        if (numPivotsMinus2 > 7) return null;
        const numPivots = numPivotsMinus2 + 2;
        const pivotsNorm = new Float32Array(9);
        let acc = 0;
        for (let i = 0; i < numPivots; i++) {
          acc = Math.min(maxBlVal, acc + br.readBits(hdr.blBitDepth));
          pivotsNorm[i] = acc / maxBlVal;
        }
        for (let i = numPivots; i < 9; i++) pivotsNorm[i] = pivotsNorm[numPivots - 1];
        curves.push({
          numPivots,
          numPieces: numPivots - 1,
          pivots: pivotsNorm,
          mappingIdc: new Uint8Array(8),
          polyOrder: new Uint8Array(8),
          polyCoeffs: Array.from({ length: 8 }, () => [0, 1, 0]),
          mmrOrder: new Uint8Array(8),
          mmrConstant: new Float32Array(8),
          mmrCoeffs: Array.from({ length: 8 }, () => new Float32Array(21)),
        });
      }

      let nlqMethodIdc = -1;
      if (useNlq) {
        nlqMethodIdc = br.readBits(3);
      }
      const numXPartitions = br.readUE() + 1;
      const numYPartitions = br.readUE() + 1;

      for (let c = 0; c < 3; c++) {
        const curve = curves[c];
        for (let i = 0; i < curve.numPieces; i++) {
          const mappingIdc = br.readUE();
          if (mappingIdc > 1) return null;
          curve.mappingIdc[i] = mappingIdc;
          if (mappingIdc === 0) {
            const polyOrderMinus1 = br.readUE();
            if (polyOrderMinus1 > 1) return null;
            const order = polyOrderMinus1 + 1;
            curve.polyOrder[i] = order;
            if (polyOrderMinus1 === 0) {
              const linearInterp = br.readBit();
              if (linearInterp) {
                const x0 = readRpuSignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
                const x1 = readRpuSignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
                const dx = Math.max(1e-6, curve.pivots[i + 1] - curve.pivots[i]);
                const slope = (x1 - x0) / dx;
                curve.polyCoeffs[i] = [x0 - slope * curve.pivots[i], slope, 0];
                continue;
              }
            }
            const c0 = readRpuSignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
            const c1 = readRpuSignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
            const c2 = order === 2 ? readRpuSignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom) : 0;
            curve.polyCoeffs[i] = [c0, c1, c2];
          } else {
            const mmrOrderMinus1 = br.readBits(2);
            if (mmrOrderMinus1 > 2) return null;
            const order = mmrOrderMinus1 + 1;
            curve.mmrOrder[i] = order;
            curve.mmrConstant[i] = readRpuSignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
            for (let j = 0; j < order; j++) {
              for (let k = 0; k < 7; k++) {
                curve.mmrCoeffs[i][j * 7 + k] = readRpuSignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
              }
            }
          }
        }
      }

      if (useNlq) {
        for (let c = 0; c < 3; c++) {
          br.readBits(hdr.elBitDepth); // nlq_offset
          readRpuUnsignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom); // vdr_in_max
          if (nlqMethodIdc === 0) {
            readRpuUnsignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
            readRpuUnsignedCoef(br, hdr.coefDataType, hdr.coefLog2Denom);
          }
        }
      }

      vdrEntry.mapping = {
        vdrRpuId,
        mappingColorSpace,
        mappingChromaFormatIdc,
        numXPartitions,
        numYPartitions,
        curves,
      };
      ctx.mapping = vdrEntry.mapping;
    }

    if (dmMetadataPresent && br.bitsLeft >= 16) {
      const affectedDmId = br.readUE();
      const currentDmId = br.readUE();
      if (affectedDmId <= 15 && currentDmId <= 15) {
        let affected = ctx.vdr.get(affectedDmId);
        if (!affected) {
          affected = { mapping: ctx.mapping, color: null };
          ctx.vdr.set(affectedDmId, affected);
        }
        const sceneRefreshFlag = br.readUE();
        const yccToRgbMatrix = new Array(9);
        for (let i = 0; i < 9; i++) {
          yccToRgbMatrix[i] = br.readSignedBits(16) / 8192;
        }
        const offsetDenom = 2 ** 28;
        const yccToRgbOffset = new Array(3);
        for (let i = 0; i < 3; i++) {
          yccToRgbOffset[i] = br.readBits(32) / offsetDenom;
        }
        const rgbToLmsMatrix = new Array(9);
        for (let i = 0; i < 9; i++) {
          rgbToLmsMatrix[i] = br.readSignedBits(16) / 16384;
        }
        const signalEotf = br.readBits(16);
        const signalEotfParam0 = br.readBits(16);
        const signalEotfParam1 = br.readBits(16);
        const signalEotfParam2 = br.readBits(32);
        const signalBitDepth = br.readBits(5);
        const signalColorSpace = br.readBits(2);
        const signalChromaFormat = br.readBits(2);
        const signalFullRangeFlag = br.readBits(2);
        const sourceMinPq = br.readBits(12);
        const sourceMaxPq = br.readBits(12);
        const sourceDiagonal = br.readBits(10);

        affected.color = {
          dmMetadataId: affectedDmId,
          sceneRefreshFlag,
          yccToRgbMatrix,
          yccToRgbOffset,
          rgbToLmsMatrix,
          signalEotf,
          signalEotfParam0,
          signalEotfParam1,
          signalEotfParam2,
          signalBitDepth,
          signalColorSpace,
          signalChromaFormat,
          signalFullRangeFlag,
          sourceMinPq,
          sourceMaxPq,
          sourceDiagonal,
        };
        const currentEntry = ctx.vdr.get(currentDmId) || affected;
        ctx.color = currentEntry.color || affected.color;
      }
    }

    return {
      profile,
      blBitDepth: hdr.blBitDepth,
      vdrBitDepth: hdr.vdrBitDepth,
      fullRange: Boolean(hdr.blVideoFullRangeFlag),
      disableResidual: Boolean(hdr.disableResidualFlag),
      mapping: ctx.mapping,
      color: ctx.color,
    };
  } catch {
    return null;
  }
}

function parseSeiNal(nalPayload) {
  const rbsp = removeRbspEmulationPrevention(nalPayload);
  let pos = 0;
  let masteringDisplay = null;
  let contentLight = null;
  while (pos + 2 <= rbsp.length) {
    if (rbsp[pos] === 0x80 && pos === rbsp.length - 1) break;
    let payloadType = 0;
    while (pos < rbsp.length && rbsp[pos] === 0xff) {
      payloadType += 255;
      pos++;
    }
    if (pos >= rbsp.length) break;
    payloadType += rbsp[pos++];

    let payloadSize = 0;
    while (pos < rbsp.length && rbsp[pos] === 0xff) {
      payloadSize += 255;
      pos++;
    }
    if (pos >= rbsp.length) break;
    payloadSize += rbsp[pos++];
    if (pos + payloadSize > rbsp.length) break;

    const body = rbsp.subarray(pos, pos + payloadSize);
    if (payloadType === 137 && body.length >= 24) {
      // Mastering display colour volume (SMPTE ST 2086)
      const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const maxLuminance = dv.getUint32(16, false) * 0.0001;
      const minLuminance = dv.getUint32(20, false) * 0.0001;
      if (maxLuminance > 0) {
        masteringDisplay = {
          maxLuminance,
          minLuminance: Math.max(0, minLuminance),
        };
      }
    } else if (payloadType === 144 && body.length >= 4) {
      // Content light level information (CTA-861.3)
      const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const maxCll = dv.getUint16(0, false);
      const maxFall = dv.getUint16(2, false);
      if (maxCll > 0 || maxFall > 0) {
        contentLight = { maxCll, maxFall };
      }
    }
    pos += payloadSize;
  }
  return { masteringDisplay, contentLight };
}

/**
 * Inspect `hvcC` extradata for NAL length size, SEI HDR10 static metadata, and SPS VUI transfer hints.
 * @param {Uint8Array} extradata
 */
export function parseHevcColorMetadata(extradata) {
  const result = {
    nalLengthSize: 4,
    masteringDisplay: null,
    contentLight: null,
    doviConfig: null,
    transferCharacteristics: 0,
    colourPrimaries: 0,
    matrixCoeffs: 0,
    fullRange: false,
  };
  if (!extradata || extradata.length < 23 || extradata[0] !== 1) return result;
  result.nalLengthSize = (extradata[21] & 3) + 1;
  const numArrays = extradata[22];
  let offset = 23;
  for (let a = 0; a < numArrays && offset + 3 <= extradata.length; a++) {
    const nalType = extradata[offset] & 0x3f;
    const numNalus = (extradata[offset + 1] << 8) | extradata[offset + 2];
    offset += 3;
    for (let n = 0; n < numNalus && offset + 2 <= extradata.length; n++) {
      const len = (extradata[offset] << 8) | extradata[offset + 1];
      offset += 2;
      if (offset + len > extradata.length) return result;
      const nal = extradata.subarray(offset, offset + len);
      offset += len;
      if (nalType === 39 && nal.length > 2) {
        const sei = parseSeiNal(nal.subarray(2));
        if (sei.masteringDisplay) result.masteringDisplay = sei.masteringDisplay;
        if (sei.contentLight) result.contentLight = sei.contentLight;
      }
    }
  }
  return result;
}

/**
 * Single-pass inspection of a length-prefixed HEVC packet:
 * - Parses `NAL 39` (`PREFIX_SEI_NUT`) MasteringDisplay & ContentLight metadata
 * - Parses `NAL 62` (`UNSPEC62`) Dolby Vision RPU reshaping & DM metadata
 * - Strips `NAL 62` (RPU) and `NAL 63` (Profile 7 Enhancement Layer) so hardware
 *   `VideoDecoder` receives a clean 10-bit Main10 base-layer packet.
 * @param {Uint8Array} data
 * @param {number} [nalLenSize]
 * @param {ReturnType<typeof createDoviRpuContext>} [rpuCtx]
 */
export function inspectHevcPacket(data, nalLenSize = 4, rpuCtx, options = {}) {
  if (!data || data.length < nalLenSize + 2) {
    return { packetData: data, rpu: null, masteringDisplay: null, contentLight: null };
  }
  const patchSpsVui = Boolean(options?.patchSpsVui);
  let needsRewrite = false;
  let rpu = null;
  let masteringDisplay = null;
  let contentLight = null;
  let offset = 0;

  while (offset + nalLenSize < data.length) {
    let len = 0;
    for (let i = 0; i < nalLenSize; i++) len = len * 256 + data[offset + i];
    if (len <= 0 || offset + nalLenSize + len > data.length) {
      return { packetData: data, rpu, masteringDisplay, contentLight };
    }
    const nalStart = offset + nalLenSize;
    const nalType = (data[nalStart] >> 1) & 0x3f;
    if (nalType === 33 && patchSpsVui) {
      needsRewrite = true;
    } else if (nalType === 39 && len > 2) {
      const sei = parseSeiNal(data.subarray(nalStart + 2, nalStart + len));
      if (sei.masteringDisplay) masteringDisplay = sei.masteringDisplay;
      if (sei.contentLight) contentLight = sei.contentLight;
    } else if (nalType === 62) {
      needsRewrite = true;
      if (len > 3) {
        const parsed = parseDolbyVisionRpu(data.subarray(nalStart, nalStart + len), rpuCtx);
        if (parsed) rpu = parsed;
      }
    } else if (nalType === 63) {
      needsRewrite = true;
    }
    offset += nalLenSize + len;
  }

  if (!needsRewrite) {
    return { packetData: data, rpu, masteringDisplay, contentLight };
  }

  const kept = [];
  let total = 0;
  offset = 0;
  while (offset + nalLenSize <= data.length) {
    let len = 0;
    for (let i = 0; i < nalLenSize; i++) len = len * 256 + data[offset + i];
    if (len <= 0 || offset + nalLenSize + len > data.length) break;
    const nalStart = offset + nalLenSize;
    const nalType = (data[nalStart] >> 1) & 0x3f;
    if (nalType !== 62 && nalType !== 63) {
      if (nalType === 33 && patchSpsVui) {
        const res = patchHevcSpsVuiToSdrFullRange(data.subarray(nalStart, nalStart + len), {
          fullRange: Boolean(options?.fullRange),
        });
        const nalOut = res.nal;
        const lenBuf = new Uint8Array(nalLenSize);
        let v = nalOut.length;
        for (let i = nalLenSize - 1; i >= 0; i--) {
          lenBuf[i] = v & 0xff;
          v >>>= 8;
        }
        kept.push(lenBuf, nalOut);
        total += nalLenSize + nalOut.length;
      } else {
        const slice = data.subarray(offset, offset + nalLenSize + len);
        kept.push(slice);
        total += slice.length;
      }
    }
    offset += nalLenSize + len;
  }
  if (!total) return { packetData: data, rpu, masteringDisplay, contentLight };
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of kept) {
    out.set(part, pos);
    pos += part.length;
  }
  return { packetData: out, rpu, masteringDisplay, contentLight };
}

/**
 * Compute GPU shader uniforms matching `server/av1.js` `libplacebo`:
 * `tonemapping=bt.2390:peak_detect=0:apply_dolbyvision=1` -> `BT.709` (or extended HDR passthrough).
 * @param {{
 *   hdr?: boolean,
 *   hdrKind?: string,
 *   doviProfile?: number | null,
 *   bitDepth?: number,
 *   fullRange?: boolean,
 *   maxCll?: number,
 *   maxFall?: number,
 *   maxLuminance?: number,
 *   minLuminance?: number,
 * }} colorMeta
 * @param {ReturnType<typeof parseDolbyVisionRpu> | null} [rpuMeta]
 * @param {{targetHdr?: boolean, sdrWhiteNits?: number, inputMode?: 'bt709-override'|'planar10'|'passthrough'}} [options]
 */
export function computeTonemapUniforms(colorMeta = {}, rpuMeta = null, options = {}) {
  const targetHdr = Boolean(options.targetHdr);
  const sdrWhite = Number(options.sdrWhiteNits) > 0 ? Number(options.sdrWhiteNits) : SDR_WHITE_NITS;
  const hdrKind = String(colorMeta.hdrKind || 'sdr').toLowerCase();
  const doviProfile = Number(colorMeta.doviProfile || rpuMeta?.profile || 0) || null;
  const isDoviP5 = hdrKind === 'dovi-p5' || doviProfile === 5 || rpuMeta?.mapping?.mappingColorSpace === 1;
  const isHlg = hdrKind === 'hlg' || hdrKind === 'dovi-hlg';
  const isPq = !isHlg && (isDoviP5 || Boolean(colorMeta.hdr) || hdrKind === 'hdr10' || hdrKind === 'dovi-hdr10');

  // Static peak selection (peak_detect=0: strictly static metadata, never dynamic frame-by-frame pumping)
  let srcPeakNits = 1000;
  if (Number(colorMeta.maxCll) >= 100 && Number(colorMeta.maxCll) <= 10000) {
    srcPeakNits = Number(colorMeta.maxCll);
  } else if (Number(colorMeta.maxLuminance) >= 100 && Number(colorMeta.maxLuminance) <= 10000) {
    srcPeakNits = Number(colorMeta.maxLuminance);
  } else if (rpuMeta?.color?.sourceMaxPq > 0) {
    srcPeakNits = Math.max(sdrWhite, pqToNits(rpuMeta.color.sourceMaxPq / 4095));
  } else if (isHlg) {
    srcPeakNits = 1000;
  }
  srcPeakNits = Math.max(sdrWhite, Math.min(10000, srcPeakNits));

  let srcMinNits = 0.005;
  if (Number.isFinite(colorMeta.minLuminance) && Number(colorMeta.minLuminance) >= 0) {
    srcMinNits = Math.min(1.0, Math.max(0.0001, Number(colorMeta.minLuminance)));
  } else if (rpuMeta?.color?.sourceMinPq >= 0 && rpuMeta?.color?.sourceMaxPq > 0) {
    srcMinNits = Math.min(1.0, Math.max(0.0001, pqToNits(rpuMeta.color.sourceMinPq / 4095)));
  }

  const dstPeakNits = targetHdr ? srcPeakNits : sdrWhite;
  const srcMinPq = nitsToPq(srcMinNits);
  const srcMaxPq = Math.max(srcMinPq + 0.01, nitsToPq(srcPeakNits));
  const dstMaxPq = nitsToPq(dstPeakNits);
  // ITU-R BT.2390-10 normalized maxLum and knee start KS
  const maxLumNorm = Math.min(1.0, Math.max(0.05, (dstMaxPq - srcMinPq) / (srcMaxPq - srcMinPq)));
  const kneeStart = Math.max(0.0, Math.min(0.999, 1.5 * maxLumNorm - 0.5));
  const applyBt2390 = (isPq || isHlg) && !targetHdr && srcPeakNits > dstPeakNits + 1.0;

  // Color space & Dolby Vision matrices
  let yccToRgbMatrix = isPq || isHlg ? BT2020_YCC_TO_RGB : BT709_YCC_TO_RGB;
  let yccToRgbOffset = isDoviP5 ? [0, 0, 0] : [0, 0.5, 0.5];
  let lmsToRgbMatrix = IDENTITY_3X3;

  if (isDoviP5) {
    if (rpuMeta?.color?.yccToRgbMatrix && rpuMeta.color.rgbToLmsMatrix) {
      yccToRgbMatrix = rpuMeta.color.yccToRgbMatrix;
      yccToRgbOffset = rpuMeta.color.yccToRgbOffset || [0, 0, 0];
      const invRgbToLms = invMatrix3x3(rpuMeta.color.rgbToLmsMatrix);
      // DM rgb_to_lms_matrix is BT.2020/P3 -> LMS; invert to LMS -> linear BT.2020
      lmsToRgbMatrix = invRgbToLms || LMS_TO_BT2020_MATRIX;
    } else {
      // Standard IPTPQc2 -> LMS' with neutral chroma offset [0, 0.5, 0.5]
      yccToRgbMatrix = IPTPQ_TO_LMS_MATRIX;
      yccToRgbOffset = [0, 0.5, 0.5];
      lmsToRgbMatrix = LMS_TO_BT2020_MATRIX;
    }
  } else if (rpuMeta?.mapping && rpuMeta?.color?.yccToRgbMatrix && rpuMeta.color.signalColorSpace === 0) {
    // Profile 7 / 8.1 with RPU reshaping paired with DM YCbCr -> RGB matrix & offset
    yccToRgbMatrix = rpuMeta.color.yccToRgbMatrix;
    yccToRgbOffset = rpuMeta.color.yccToRgbOffset || [0, 0.5, 0.5];
  }

  const gamutMatrix = isPq || isHlg ? (targetHdr ? BT2020_TO_DISPLAY_P3_MATRIX : BT2020_TO_BT709_MATRIX) : IDENTITY_3X3;
  const fullRange = isDoviP5 ? Boolean(rpuMeta?.fullRange ?? true) : Boolean(colorMeta.fullRange);
  const useDoviReshape = Boolean(
    rpuMeta?.mapping?.curves?.length === 3 &&
    (isDoviP5 || (rpuMeta?.color?.yccToRgbMatrix && rpuMeta.color.signalColorSpace === 0)),
  );

  // Pack RPU 3x9 pivots (3 vec4s per channel -> 9 vec4s = 36 floats),
  // 3x8 polynomial pieces (24 vec4s: [c0, c1, c2, mappingIdc]),
  // and 2 chroma channels x 8 pieces MMR constants + order-1..3 terms (compact uniform array).
  const pivotsFlat = new Float32Array(27); // 3 * 9
  const pieceCounts = [0, 0, 0];
  const polyFlat = new Float32Array(3 * 8 * 4); // [c0, c1, c2, mappingIdc_or_mmrConst]
  // For chroma MMR (channels 1 & 2, 8 pieces each, 21 coeffs = 3 orders * 7 terms): 2 * 8 * 24 floats (6 vec4s per piece)
  const mmrFlat = new Float32Array(2 * 8 * 24);

  if (useDoviReshape && rpuMeta?.mapping) {
    for (let c = 0; c < 3; c++) {
      const curve = rpuMeta.mapping.curves[c];
      pieceCounts[c] = curve.numPieces;
      for (let p = 0; p < 9; p++) pivotsFlat[c * 9 + p] = curve.pivots[p];
      for (let i = 0; i < 8; i++) {
        const base = (c * 8 + i) * 4;
        if (i < curve.numPieces) {
          if (curve.mappingIdc[i] === 0) {
            polyFlat[base + 0] = curve.polyCoeffs[i][0];
            polyFlat[base + 1] = curve.polyCoeffs[i][1];
            polyFlat[base + 2] = curve.polyCoeffs[i][2];
            polyFlat[base + 3] = 0; // polynomial
          } else {
            polyFlat[base + 0] = curve.mmrConstant[i];
            polyFlat[base + 1] = curve.mmrOrder[i];
            polyFlat[base + 2] = 0;
            polyFlat[base + 3] = 1; // MMR
            if (c >= 1) {
              const mmrBase = ((c - 1) * 8 + i) * 24;
              for (let k = 0; k < 21; k++) {
                mmrFlat[mmrBase + k] = curve.mmrCoeffs[i][k];
              }
            }
          }
        } else {
          polyFlat[base + 1] = 1; // identity y = x
        }
      }
    }
  } else {
    for (let c = 0; c < 3; c++) {
      pieceCounts[c] = 1;
      pivotsFlat[c * 9 + 0] = 0;
      for (let p = 1; p < 9; p++) pivotsFlat[c * 9 + p] = 1;
      polyFlat[c * 8 * 4 + 1] = 1;
    }
  }

  return {
    isHdr: isPq || isHlg,
    isPq,
    isHlg,
    isDoviP5,
    doviProfile,
    targetHdr,
    applyBt2390,
    useDoviReshape,
    fullRange,
    inputMode: options.inputMode || (isPq || isHlg ? 'bt709-override' : 'passthrough'),
    srcPeakNits,
    srcMinNits,
    dstPeakNits,
    sdrWhiteNits: sdrWhite,
    srcMinPq,
    srcMaxPq,
    dstMaxPq,
    maxLumNorm,
    kneeStart,
    debandEnabled: (isPq || isHlg) && !targetHdr,
    debandThreshold: 0.0035,
    ditherStrength: targetHdr ? 0.0 : 1.0 / 255.0,
    yccToRgbMatrix,
    yccToRgbOffset,
    lmsToRgbMatrix,
    gamutMatrix,
    pieceCounts,
    pivotsFlat,
    polyFlat,
    mmrFlat,
  };
}

function isBt709SrgbOverride(cs) {
  return Boolean(
    cs &&
    cs.primaries === 'bt709' &&
    cs.matrix === 'bt709' &&
    (cs.transfer === 'iec61966-2-1' || cs.transfer === 'srgb'),
  );
}

/**
 * Wrap an HDR/DoVi `VideoFrame` with a zero-copy `BT.709` colorSpace metadata override
 * so Chromium/WebKit skip their internal SDR pre-clamping LUT (Chromium Issue 40944011),
 * allowing our shader to invert the exact `BT.709` matrix and recover 10-bit YCbCr on the GPU.
 * @param {any} frame
 * @param {{hdr?: boolean, hdrKind?: string, fullRange?: boolean}} colorMeta
 * @param {{allowPlanar10?: boolean}} [options]
 */
export function wrapFramePreventingSdrClamp(frame, colorMeta = {}, options = {}) {
  const fmt = String(frame?.format || '');
  if (options.allowPlanar10 !== false && /^I4(20|22|44)P10$/i.test(fmt)) {
    return { frame, owned: false, inputMode: 'planar10', rangeAlreadyExpanded: false };
  }
  const isHdr = Boolean(colorMeta.hdr || (colorMeta.hdrKind && colorMeta.hdrKind !== 'sdr'));
  if (!isHdr) {
    return { frame, owned: false, inputMode: 'passthrough', rangeAlreadyExpanded: false };
  }
  // If SPS VUI patching + VideoDecoderConfig.colorSpace already stamped the hardware VideoFrame
  // as BT.709/sRGB, use it directly with zero cloning. When frame.colorSpace.fullRange is false,
  // Chromium's YUV->RGB stage already expanded studio [64..940] -> [0..1], so skip shader range expansion!
  if (isBt709SrgbOverride(frame?.colorSpace)) {
    return {
      frame,
      owned: false,
      inputMode: 'bt709-override',
      rangeAlreadyExpanded: frame.colorSpace.fullRange === false,
    };
  }
  if (typeof globalThis.VideoFrame !== 'function') {
    return { frame, owned: false, inputMode: 'passthrough', rangeAlreadyExpanded: false };
  }
  try {
    const wrapped = new globalThis.VideoFrame(frame, {
      timestamp: frame.timestamp,
      duration: frame.duration ?? undefined,
      colorSpace: {
        primaries: 'bt709',
        transfer: 'srgb',
        matrix: 'bt709',
        fullRange: true,
      },
    });
    if (!isBt709SrgbOverride(wrapped?.colorSpace)) {
      try {
        wrapped.close?.();
      } catch {}
      return { frame, owned: false, inputMode: 'passthrough', rangeAlreadyExpanded: false };
    }
    return {
      frame: wrapped,
      owned: true,
      inputMode: 'bt709-override',
      rangeAlreadyExpanded: wrapped.colorSpace.fullRange === false,
    };
  } catch {
    return { frame, owned: false, inputMode: 'passthrough', rangeAlreadyExpanded: false };
  }
}

const GLSL_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUv = vec2((pos.x + 1.0) * 0.5, 1.0 - (pos.y + 1.0) * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const GLSL_FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexRgb;
uniform usampler2D uPlaneY;
uniform usampler2D uPlaneU;
uniform usampler2D uPlaneV;

uniform vec2 uResolution;
uniform int uInputMode;      // 0 = passthrough SDR, 1 = bt709-override YCbCr recovery, 2 = 10-bit planar I420P10
uniform int uTransferType;   // 0 = sdr, 1 = pq (HDR10/DoVi), 2 = hlg
uniform int uIsDoviP5;       // 1 = IPTPQc2 -> LMS -> PQ -> BT.2020
uniform int uUseDoviReshape; // 1 = evaluate RPU polynomial / MMR curves
uniform int uFullRange;      // 1 = full range, 0 = studio/limited range
uniform int uApplyBt2390;    // 1 = static-peak ITU-R BT.2390 EETF
uniform int uTargetHdr;      // 1 = preserve linear/extended HDR output
uniform int uDeband;         // 1 = 1-pass gradient deband

uniform vec4 uToneParams;    // x = srcMinPq, y = srcMaxPq, z = maxLumNorm, w = kneeStart
uniform vec4 uScaleParams;   // x = sdrWhiteNits, y = debandThreshold, z = ditherStrength, w = frameSeed
uniform mat3 uYccToRgb;
uniform vec3 uYccOffset;
uniform mat3 uLmsToRgb;
uniform mat3 uGamutMatrix;

uniform ivec3 uPieceCounts;
uniform float uPivots[27];
uniform vec4 uPoly[24];      // 3 * 8 pieces: [c0, c1, c2, isMmr]
uniform vec4 uMmr[96];       // 2 chroma * 8 pieces * 6 vec4s (orders 1..3: 21 terms + pad)

const float PQ_M1 = 0.1593017578125;
const float PQ_M2 = 78.84375;
const float PQ_C1 = 0.8359375;
const float PQ_C2 = 18.8515625;
const float PQ_C3 = 18.6875;

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(lo, hi, greaterThan(c, vec3(0.04045)));
}

vec3 linearToBt1886(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(1.0 / 2.4));
}

float pqEotf(float e) {
  float v = clamp(e, 0.0, 1.0);
  if (v <= 0.0) return 0.0;
  float p = pow(v, 1.0 / PQ_M2);
  float num = max(p - PQ_C1, 0.0);
  float den = max(PQ_C2 - PQ_C3 * p, 1e-6);
  return pow(num / den, 1.0 / PQ_M1); // 1.0 == 10000 nits
}

vec3 pqEotf3(vec3 e) {
  return vec3(pqEotf(e.r), pqEotf(e.g), pqEotf(e.b));
}

float pqOetf(float y) {
  float v = clamp(y, 0.0, 1.0);
  if (v <= 0.0) return 0.0;
  float ym = pow(v, PQ_M1);
  return pow((PQ_C1 + PQ_C2 * ym) / (1.0 + PQ_C3 * ym), PQ_M2);
}

vec3 hlgToLinearNits(vec3 e) {
  e = clamp(e, 0.0, 1.0);
  const float a = 0.17883277;
  const float b = 0.28466892;
  const float c = 0.55991073;
  vec3 scene;
  scene.r = (e.r <= 0.5) ? (e.r * e.r) / 3.0 : (exp((e.r - c) / a) + b) / 12.0;
  scene.g = (e.g <= 0.5) ? (e.g * e.g) / 3.0 : (exp((e.g - c) / a) + b) / 12.0;
  scene.b = (e.b <= 0.5) ? (e.b * e.b) / 3.0 : (exp((e.b - c) / a) + b) / 12.0;
  float ys = max(1e-6, dot(scene, vec3(0.2627, 0.6780, 0.0593)));
  // BT.2100 HLG OOTF at 1000 cd/m^2 nominal peak (gamma = 1.2), normalized to 10000 nits
  return scene * pow(ys, 0.2) * 0.1;
}

vec3 sampleRawYcc(vec2 uv) {
  if (uInputMode == 2) {
    float y = float(texture(uPlaneY, uv).r) / 1023.0;
    float u = float(texture(uPlaneU, uv).r) / 1023.0;
    float v = float(texture(uPlaneV, uv).r) / 1023.0;
    return vec3(y, u, v);
  }
  vec3 rgb = texture(uTexRgb, uv).rgb;
  // Invert exact full-range BT.709 RGB -> raw 10-bit YCbCr codewords [0..1]
  float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float cb = dot(rgb, vec3(-0.1145721, -0.3854279, 0.5)) + 0.5;
  float cr = dot(rgb, vec3(0.5, -0.4541529, -0.0458471)) + 0.5;
  return clamp(vec3(y, cb, cr), 0.0, 1.0);
}

vec3 applyDoviReshaping(vec3 v) {
  vec3 outVal = v;
  for (int c = 0; c < 3; c++) {
    float x = v[c];
    int count = uPieceCounts[c];
    int piece = 0;
    for (int p = 0; p < 7; p++) {
      if (p + 1 < count && x >= uPivots[c * 9 + p + 1]) {
        piece = p + 1;
      }
    }
    vec4 poly = uPoly[c * 8 + piece];
    if (poly.w < 0.5 || c == 0) {
      outVal[c] = clamp(poly.x + poly.y * x + poly.z * x * x, 0.0, 1.0);
    } else {
      int mmrIdx = ((c - 1) * 8 + piece) * 6;
      vec4 m0 = uMmr[mmrIdx];
      vec4 m1 = uMmr[mmrIdx + 1];
      float t = poly.x
        + m0.x * v.x + m0.y * v.y + m0.z * v.z
        + m0.w * (v.x * v.y) + m1.x * (v.x * v.z) + m1.y * (v.y * v.z)
        + m1.z * (v.x * v.y * v.z);
      if (poly.y >= 1.5) {
        vec3 v2 = v * v;
        vec4 m2 = uMmr[mmrIdx + 2];
        vec4 m3 = uMmr[mmrIdx + 3];
        t += m1.w * v2.x + m2.x * v2.y + m2.y * v2.z
          + m2.z * (v2.x * v2.y) + m2.w * (v2.x * v2.z) + m3.x * (v2.y * v2.z)
          + m3.y * (v2.x * v2.y * v2.z);
        if (poly.y >= 2.5) {
          vec3 v3 = v2 * v;
          vec4 m4 = uMmr[mmrIdx + 4];
          vec4 m5 = uMmr[mmrIdx + 5];
          t += m3.z * v3.x + m3.w * v3.y + m4.x * v3.z
            + m4.y * (v3.x * v3.y) + m4.z * (v3.x * v3.z) + m4.w * (v3.y * v3.z)
            + m5.x * (v3.x * v3.y * v3.z);
        }
      }
      outVal[c] = clamp(t, 0.0, 1.0);
    }
  }
  return outVal;
}

float bt2390Spline(float e) {
  float minPq = uToneParams.x;
  float maxPq = uToneParams.y;
  float maxLum = uToneParams.z;
  float ks = uToneParams.w;
  float e1 = clamp((e - minPq) / max(1e-5, maxPq - minPq), 0.0, 1.0);
  float e2 = e1;
  if (e1 > ks) {
    float t = (e1 - ks) / max(1e-5, 1.0 - ks);
    float t2 = t * t;
    float t3 = t2 * t;
    e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks
       + (t3 - 2.0 * t2 + t) * (1.0 - ks)
       + (-2.0 * t3 + 3.0 * t2) * maxLum;
  }
  return clamp(e2 * (maxPq - minPq) + minPq, 0.0, 1.0);
}

vec3 softClipGamut(vec3 rgb) {
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float minComp = min(min(rgb.r, rgb.g), rgb.b);
  if (minComp < 0.0 && luma > 0.0) {
    float t = luma / max(1e-6, luma - minComp);
    rgb = mix(vec3(luma), rgb, clamp(t, 0.0, 1.0));
  }
  return max(rgb, vec3(0.0));
}

float ignNoise(vec2 fragCoord, float seed) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(fragCoord + vec2(seed * 17.0, seed * 31.0), magic.xy)));
}

void main() {
  if (uInputMode == 0) {
    fragColor = texture(uTexRgb, vUv);
    return;
  }

  vec3 ycc = sampleRawYcc(vUv);
  if (uDeband == 1) {
    vec2 px = 12.0 / max(uResolution, vec2(1.0));
    float h = ignNoise(gl_FragCoord.xy, uScaleParams.w) * 6.2831853;
    vec2 dir = vec2(cos(h), sin(h)) * px;
    vec3 n1 = sampleRawYcc(clamp(vUv + dir, 0.0, 1.0));
    vec3 n2 = sampleRawYcc(clamp(vUv - dir, 0.0, 1.0));
    vec3 avg = 0.5 * (n1 + n2);
    vec3 diff = abs(ycc - avg);
    bvec3 smoothMask = lessThan(diff, vec3(uScaleParams.y));
    ycc = vec3(
      smoothMask.x ? avg.x : ycc.x,
      smoothMask.y ? avg.y : ycc.y,
      smoothMask.z ? avg.z : ycc.z
    );
  }

  if (uUseDoviReshape == 1) {
    ycc = applyDoviReshaping(ycc);
  } else if (uFullRange == 0) {
    ycc.x = clamp((ycc.x - (64.0 / 1023.0)) * (1023.0 / 876.0), 0.0, 1.0);
    ycc.yz = clamp((ycc.yz - (512.0 / 1023.0)) * (1023.0 / 896.0) + 0.5, 0.0, 1.0);
  }

  vec3 linearBt2020;
  if (uIsDoviP5 == 1) {
    // Row-major matrix multiply on reshaped IPTPQc2
    vec3 centered = ycc - uYccOffset;
    vec3 lmsPrime = vec3(
      dot(uYccToRgb[0], centered),
      dot(uYccToRgb[1], centered),
      dot(uYccToRgb[2], centered)
    );
    vec3 lmsLinear = pqEotf3(lmsPrime);
    linearBt2020 = vec3(
      dot(uLmsToRgb[0], lmsLinear),
      dot(uLmsToRgb[1], lmsLinear),
      dot(uLmsToRgb[2], lmsLinear)
    );
  } else {
    vec3 centered = ycc - uYccOffset;
    vec3 nonLinearRgb = clamp(vec3(
      dot(uYccToRgb[0], centered),
      dot(uYccToRgb[1], centered),
      dot(uYccToRgb[2], centered)
    ), 0.0, 1.0);
    if (uTransferType == 1) {
      linearBt2020 = pqEotf3(nonLinearRgb);
    } else if (uTransferType == 2) {
      linearBt2020 = hlgToLinearNits(nonLinearRgb);
    } else {
      linearBt2020 = srgbToLinear(nonLinearRgb) * (uScaleParams.x / 10000.0);
    }
  }
  linearBt2020 = max(linearBt2020, vec3(0.0));

  if (uApplyBt2390 == 1) {
    // Exact ITU-R BT.2100 / BT.2390-10 §5.4.1 ICtCp tone mapping (matches libplacebo bt.2390)
    vec3 lmsLin = vec3(
      dot(vec3(0.41210938, 0.52392578, 0.06396484), linearBt2020),
      dot(vec3(0.16674805, 0.72045898, 0.11279297), linearBt2020),
      dot(vec3(0.02416992, 0.07543945, 0.90039063), linearBt2020)
    );
    vec3 lmsPq = vec3(pqOetf(lmsLin.x), pqOetf(lmsLin.y), pqOetf(lmsLin.z));
    float iVal = 0.5 * (lmsPq.x + lmsPq.y);
    float ct = dot(vec3(1.61376953, -3.32348633, 1.70971680), lmsPq);
    float cp = dot(vec3(4.37817383, -4.24560547, -0.13256836), lmsPq);
    float iMapped = bt2390Spline(iVal);
    float cScale = (iVal > 1e-6) ? min(iMapped / iVal, iVal / max(iMapped, 1e-6)) : 1.0;
    vec3 ictcp = vec3(iMapped, ct * cScale, cp * cScale);
    vec3 lmsPqOut = vec3(
      ictcp.x + 0.00860904 * ictcp.y + 0.11102963 * ictcp.z,
      ictcp.x - 0.00860904 * ictcp.y - 0.11102963 * ictcp.z,
      ictcp.x + 0.56003134 * ictcp.y - 0.32062717 * ictcp.z
    );
    vec3 lmsLinOut = pqEotf3(lmsPqOut);
    linearBt2020 = max(vec3(
      dot(vec3(3.43660669, -2.50645212, 0.06984542), lmsLinOut),
      dot(vec3(-0.79132956, 1.98360045, -0.19227090), lmsLinOut),
      dot(vec3(-0.02594990, -0.09891371, 1.12486361), lmsLinOut)
    ), vec3(0.0));
  }

  // Normalize from 10000-nit PQ scale to SDR reference white (1.0 == sdrWhiteNits = 203 cd/m^2)
  vec3 normLinear = linearBt2020 * (10000.0 / uScaleParams.x);
  vec3 outLinear = vec3(
    dot(uGamutMatrix[0], normLinear),
    dot(uGamutMatrix[1], normLinear),
    dot(uGamutMatrix[2], normLinear)
  );
  outLinear = softClipGamut(outLinear);

  if (uTargetHdr == 1) {
    fragColor = vec4(outLinear, 1.0);
    return;
  }

  vec3 sdrOut = linearToBt1886(clamp(outLinear, 0.0, 1.0));
  float dither = (ignNoise(gl_FragCoord.xy, uScaleParams.w) - 0.5) * uScaleParams.z;
  fragColor = vec4(clamp(sdrOut + dither, 0.0, 1.0), 1.0);
}
`;

const WGSL_SHADER = /* wgsl */ `
struct Uniforms {
  resolution: vec2<f32>,
  inputMode: u32,
  transferType: u32,
  isDoviP5: u32,
  useDoviReshape: u32,
  fullRange: u32,
  applyBt2390: u32,
  targetHdr: u32,
  deband: u32,
  pieceCountsX: u32,
  pieceCountsY: u32,
  pieceCountsZ: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  toneParams: vec4<f32>,
  scaleParams: vec4<f32>,
  yccRow0: vec4<f32>,
  yccRow1: vec4<f32>,
  yccRow2: vec4<f32>,
  yccOffset: vec4<f32>,
  lmsRow0: vec4<f32>,
  lmsRow1: vec4<f32>,
  lmsRow2: vec4<f32>,
  gamutRow0: vec4<f32>,
  gamutRow1: vec4<f32>,
  gamutRow2: vec4<f32>,
  pivots: array<vec4<f32>, 9>,
  poly: array<vec4<f32>, 24>,
  mmr: array<vec4<f32>, 96>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texRgb: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VsOut {
  var out: VsOut;
  let x = select(-1.0, 3.0, vid == 1u);
  let y = select(-1.0, 3.0, vid == 2u);
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

const PQ_M1: f32 = 0.1593017578125;
const PQ_M2: f32 = 78.84375;
const PQ_C1: f32 = 0.8359375;
const PQ_C2: f32 = 18.8515625;
const PQ_C3: f32 = 18.6875;

fn linearToBt1886(cIn: vec3<f32>) -> vec3<f32> {
  return pow(max(cIn, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4));
}

fn srgbToLinear(cIn: vec3<f32>) -> vec3<f32> {
  let c = max(cIn, vec3<f32>(0.0));
  let lo = c / 12.92;
  let hi = pow(max((c + 0.055) / 1.055, vec3<f32>(0.0)), vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}

fn pqEotf(e: f32) -> f32 {
  let v = clamp(e, 0.0, 1.0);
  if (v <= 0.0) { return 0.0; }
  let p = pow(v, 1.0 / PQ_M2);
  let num = max(p - PQ_C1, 0.0);
  let den = max(PQ_C2 - PQ_C3 * p, 1e-6);
  return pow(num / den, 1.0 / PQ_M1);
}

fn pqOetf(y: f32) -> f32 {
  let v = clamp(y, 0.0, 1.0);
  if (v <= 0.0) { return 0.0; }
  let ym = pow(v, PQ_M1);
  return pow((PQ_C1 + PQ_C2 * ym) / (1.0 + PQ_C3 * ym), PQ_M2);
}

fn hlgChannel(v: f32) -> f32 {
  if (v <= 0.5) { return (v * v) / 3.0; }
  return (exp((v - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
}

fn hlgToLinearNits(eIn: vec3<f32>) -> vec3<f32> {
  let e = clamp(eIn, vec3<f32>(0.0), vec3<f32>(1.0));
  let scene = vec3<f32>(hlgChannel(e.r), hlgChannel(e.g), hlgChannel(e.b));
  let ys = max(1e-6, dot(scene, vec3<f32>(0.2627, 0.6780, 0.0593)));
  return scene * pow(ys, 0.2) * 0.1;
}

fn getPivot(c: u32, p: u32) -> f32 {
  let idx = c * 9u + p;
  let vecIdx = idx / 4u;
  let lane = idx % 4u;
  return u.pivots[vecIdx][lane];
}

fn sampleRawYcc(uv: vec2<f32>) -> vec3<f32> {
  let rgb = textureSampleLevel(texRgb, samp, uv, 0.0).rgb;
  let y = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  let cb = dot(rgb, vec3<f32>(-0.1145721, -0.3854279, 0.5)) + 0.5;
  let cr = dot(rgb, vec3<f32>(0.5, -0.4541529, -0.0458471)) + 0.5;
  return clamp(vec3<f32>(y, cb, cr), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn applyDoviReshaping(v: vec3<f32>) -> vec3<f32> {
  var outVal = v;
  let counts = array<u32, 3>(u.pieceCountsX, u.pieceCountsY, u.pieceCountsZ);
  for (var c = 0u; c < 3u; c = c + 1u) {
    let x = v[c];
    let count = counts[c];
    var piece = 0u;
    for (var p = 0u; p < 7u; p = p + 1u) {
      if (p + 1u < count && x >= getPivot(c, p + 1u)) {
        piece = p + 1u;
      }
    }
    let poly = u.poly[c * 8u + piece];
    if (poly.w < 0.5 || c == 0u) {
      outVal[c] = clamp(poly.x + poly.y * x + poly.z * x * x, 0.0, 1.0);
    } else {
      let mmrIdx = ((c - 1u) * 8u + piece) * 6u;
      let m0 = u.mmr[mmrIdx];
      let m1 = u.mmr[mmrIdx + 1u];
      var t = poly.x
        + m0.x * v.x + m0.y * v.y + m0.z * v.z
        + m0.w * (v.x * v.y) + m1.x * (v.x * v.z) + m1.y * (v.y * v.z)
        + m1.z * (v.x * v.y * v.z);
      if (poly.y >= 1.5) {
        let v2 = v * v;
        let m2 = u.mmr[mmrIdx + 2u];
        let m3 = u.mmr[mmrIdx + 3u];
        t = t + m1.w * v2.x + m2.x * v2.y + m2.y * v2.z
          + m2.z * (v2.x * v2.y) + m2.w * (v2.x * v2.z) + m3.x * (v2.y * v2.z)
          + m3.y * (v2.x * v2.y * v2.z);
        if (poly.y >= 2.5) {
          let v3 = v2 * v;
          let m4 = u.mmr[mmrIdx + 4u];
          let m5 = u.mmr[mmrIdx + 5u];
          t = t + m3.z * v3.x + m3.w * v3.y + m4.x * v3.z
            + m4.y * (v3.x * v3.y) + m4.z * (v3.x * v3.z) + m4.w * (v3.y * v3.z)
            + m5.x * (v3.x * v3.y * v3.z);
        }
      }
      outVal[c] = clamp(t, 0.0, 1.0);
    }
  }
  return outVal;
}

fn bt2390Spline(e: f32) -> f32 {
  let minPq = u.toneParams.x;
  let maxPq = u.toneParams.y;
  let maxLum = u.toneParams.z;
  let ks = u.toneParams.w;
  let e1 = clamp((e - minPq) / max(1e-5, maxPq - minPq), 0.0, 1.0);
  var e2 = e1;
  if (e1 > ks) {
    let t = (e1 - ks) / max(1e-5, 1.0 - ks);
    let t2 = t * t;
    let t3 = t2 * t;
    e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks
       + (t3 - 2.0 * t2 + t) * (1.0 - ks)
       + (-2.0 * t3 + 3.0 * t2) * maxLum;
  }
  return clamp(e2 * (maxPq - minPq) + minPq, 0.0, 1.0);
}

fn ignNoise(coord: vec2<f32>, seed: f32) -> f32 {
  let magic = vec3<f32>(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(coord + vec2<f32>(seed * 17.0, seed * 31.0), magic.xy)));
}

@fragment
fn fsMain(in: VsOut) -> @location(0) vec4<f32> {
  if (u.inputMode == 0u) {
    return textureSampleLevel(texRgb, samp, in.uv, 0.0);
  }

  var ycc = sampleRawYcc(in.uv);
  if (u.deband == 1u) {
    let px = 12.0 / max(u.resolution, vec2<f32>(1.0));
    let ang = ignNoise(in.pos.xy, u.scaleParams.w) * 6.2831853;
    let dir = vec2<f32>(cos(ang), sin(ang)) * px;
    let n1 = sampleRawYcc(clamp(in.uv + dir, vec2<f32>(0.0), vec2<f32>(1.0)));
    let n2 = sampleRawYcc(clamp(in.uv - dir, vec2<f32>(0.0), vec2<f32>(1.0)));
    let avg = 0.5 * (n1 + n2);
    let diff = abs(ycc - avg);
    ycc = select(ycc, avg, diff < vec3<f32>(u.scaleParams.y));
  }

  if (u.useDoviReshape == 1u) {
    ycc = applyDoviReshaping(ycc);
  } else if (u.fullRange == 0u) {
    ycc.x = clamp((ycc.x - (64.0 / 1023.0)) * (1023.0 / 876.0), 0.0, 1.0);
    ycc.y = clamp((ycc.y - (512.0 / 1023.0)) * (1023.0 / 896.0) + 0.5, 0.0, 1.0);
    ycc.z = clamp((ycc.z - (512.0 / 1023.0)) * (1023.0 / 896.0) + 0.5, 0.0, 1.0);
  }

  let centered = ycc - u.yccOffset.xyz;
  var linearBt2020: vec3<f32>;
  if (u.isDoviP5 == 1u) {
    let lmsPrime = vec3<f32>(
      dot(u.yccRow0.xyz, centered),
      dot(u.yccRow1.xyz, centered),
      dot(u.yccRow2.xyz, centered)
    );
    let lmsLin = vec3<f32>(pqEotf(lmsPrime.x), pqEotf(lmsPrime.y), pqEotf(lmsPrime.z));
    linearBt2020 = vec3<f32>(
      dot(u.lmsRow0.xyz, lmsLin),
      dot(u.lmsRow1.xyz, lmsLin),
      dot(u.lmsRow2.xyz, lmsLin)
    );
  } else {
    let nlRgb = clamp(vec3<f32>(
      dot(u.yccRow0.xyz, centered),
      dot(u.yccRow1.xyz, centered),
      dot(u.yccRow2.xyz, centered)
    ), vec3<f32>(0.0), vec3<f32>(1.0));
    if (u.transferType == 1u) {
      linearBt2020 = vec3<f32>(pqEotf(nlRgb.x), pqEotf(nlRgb.y), pqEotf(nlRgb.z));
    } else if (u.transferType == 2u) {
      linearBt2020 = hlgToLinearNits(nlRgb);
    } else {
      linearBt2020 = srgbToLinear(nlRgb) * (u.scaleParams.x / 10000.0);
    }
  }
  linearBt2020 = max(linearBt2020, vec3<f32>(0.0));

  if (u.applyBt2390 == 1u) {
    // Exact ITU-R BT.2100 / BT.2390-10 §5.4.1 ICtCp tone mapping (matches libplacebo bt.2390)
    let lmsLin = vec3<f32>(
      dot(vec3<f32>(0.41210938, 0.52392578, 0.06396484), linearBt2020),
      dot(vec3<f32>(0.16674805, 0.72045898, 0.11279297), linearBt2020),
      dot(vec3<f32>(0.02416992, 0.07543945, 0.90039063), linearBt2020)
    );
    let lmsPq = vec3<f32>(pqOetf(lmsLin.x), pqOetf(lmsLin.y), pqOetf(lmsLin.z));
    let iVal = 0.5 * (lmsPq.x + lmsPq.y);
    let ct = dot(vec3<f32>(1.61376953, -3.32348633, 1.70971680), lmsPq);
    let cp = dot(vec3<f32>(4.37817383, -4.24560547, -0.13256836), lmsPq);
    let iMapped = bt2390Spline(iVal);
    let cScale = select(1.0, min(iMapped / iVal, iVal / max(iMapped, 1e-6)), iVal > 1e-6);
    let ictcp = vec3<f32>(iMapped, ct * cScale, cp * cScale);
    let lmsPqOut = vec3<f32>(
      ictcp.x + 0.00860904 * ictcp.y + 0.11102963 * ictcp.z,
      ictcp.x - 0.00860904 * ictcp.y - 0.11102963 * ictcp.z,
      ictcp.x + 0.56003134 * ictcp.y - 0.32062717 * ictcp.z
    );
    let lmsLinOut = vec3<f32>(pqEotf(lmsPqOut.x), pqEotf(lmsPqOut.y), pqEotf(lmsPqOut.z));
    linearBt2020 = max(vec3<f32>(
      dot(vec3<f32>(3.43660669, -2.50645212, 0.06984542), lmsLinOut),
      dot(vec3<f32>(-0.79132956, 1.98360045, -0.19227090), lmsLinOut),
      dot(vec3<f32>(-0.02594990, -0.09891371, 1.12486361), lmsLinOut)
    ), vec3<f32>(0.0));
  }

  let normLinear = linearBt2020 * (10000.0 / u.scaleParams.x);
  var outLin = vec3<f32>(
    dot(u.gamutRow0.xyz, normLinear),
    dot(u.gamutRow1.xyz, normLinear),
    dot(u.gamutRow2.xyz, normLinear)
  );
  let luma = dot(outLin, vec3<f32>(0.2126, 0.7152, 0.0722));
  let minComp = min(min(outLin.r, outLin.g), outLin.b);
  if (minComp < 0.0 && luma > 0.0) {
    let t = clamp(luma / max(1e-6, luma - minComp), 0.0, 1.0);
    outLin = mix(vec3<f32>(luma), outLin, t);
  }
  outLin = max(outLin, vec3<f32>(0.0));

  if (u.targetHdr == 1u) {
    return vec4<f32>(outLin, 1.0);
  }

  let sdrOut = linearToBt1886(clamp(outLin, vec3<f32>(0.0), vec3<f32>(1.0)));
  let dither = (ignNoise(in.pos.xy, u.scaleParams.w) - 0.5) * u.scaleParams.z;
  return vec4<f32>(clamp(sdrOut + dither, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

function createWebGl2Renderer(canvas, initialTargetHdr = false) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  let hdrConfigured = false;
  function configureCanvasHdr(wantHdr) {
    hdrConfigured = false;
    if (wantHdr) {
      try {
        if ('drawingBufferColorSpace' in gl) {
          gl.drawingBufferColorSpace = 'display-p3';
        }
        if (typeof gl.drawingBufferStorage === 'function' && gl.getExtension('EXT_color_buffer_half_float')) {
          gl.drawingBufferStorage(gl.RGBA16F, canvas.width || 2, canvas.height || 2);
          if (typeof canvas.configureHighDynamicRange === 'function') {
            canvas.configureHighDynamicRange({ mode: 'extended' });
          }
          hdrConfigured = true;
        }
      } catch {
        hdrConfigured = false;
      }
    }
  }
  configureCanvasHdr(initialTargetHdr);

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`WebGL2 shader compile failed: ${info}`);
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, GLSL_VERT);
  const fs = compile(gl.FRAGMENT_SHADER, GLSL_FRAG);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL2 program link failed: ${info}`);
  }

  const vao = gl.createVertexArray();
  const makeTex = (unit, isUint = false) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, isUint ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, isUint ? gl.NEAREST : gl.LINEAR);
    return tex;
  };

  const texRgb = makeTex(0, false);
  const texY = makeTex(1, true);
  const texU = makeTex(2, true);
  const texV = makeTex(3, true);
  // Seed dummy 1x1 uint textures so unbound units stay valid on all drivers
  const zeroU16 = new Uint16Array([0]);
  for (const [unit, tex] of [
    [1, texY],
    [2, texU],
    [3, texV],
  ]) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, zeroU16);
  }

  gl.useProgram(prog);
  gl.uniform1i(gl.getUniformLocation(prog, 'uTexRgb'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'uPlaneY'), 1);
  gl.uniform1i(gl.getUniformLocation(prog, 'uPlaneU'), 2);
  gl.uniform1i(gl.getUniformLocation(prog, 'uPlaneV'), 3);

  const locs = {
    uResolution: gl.getUniformLocation(prog, 'uResolution'),
    uInputMode: gl.getUniformLocation(prog, 'uInputMode'),
    uTransferType: gl.getUniformLocation(prog, 'uTransferType'),
    uIsDoviP5: gl.getUniformLocation(prog, 'uIsDoviP5'),
    uUseDoviReshape: gl.getUniformLocation(prog, 'uUseDoviReshape'),
    uFullRange: gl.getUniformLocation(prog, 'uFullRange'),
    uApplyBt2390: gl.getUniformLocation(prog, 'uApplyBt2390'),
    uTargetHdr: gl.getUniformLocation(prog, 'uTargetHdr'),
    uDeband: gl.getUniformLocation(prog, 'uDeband'),
    uToneParams: gl.getUniformLocation(prog, 'uToneParams'),
    uScaleParams: gl.getUniformLocation(prog, 'uScaleParams'),
    uYccToRgb: gl.getUniformLocation(prog, 'uYccToRgb'),
    uYccOffset: gl.getUniformLocation(prog, 'uYccOffset'),
    uLmsToRgb: gl.getUniformLocation(prog, 'uLmsToRgb'),
    uGamutMatrix: gl.getUniformLocation(prog, 'uGamutMatrix'),
    uPieceCounts: gl.getUniformLocation(prog, 'uPieceCounts'),
    uPivots: gl.getUniformLocation(prog, 'uPivots[0]'),
    uPoly: gl.getUniformLocation(prog, 'uPoly[0]'),
    uMmr: gl.getUniformLocation(prog, 'uMmr[0]'),
  };

  let planeScratch = null;
  let frameCounter = 0;

  // GLSL mat3(array) is column-major; transpose row-major JS 3x3 so dot(uMat[row], v) reads row `row`!
  const toRowsInCols = m => new Float32Array([m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]]);

  let canHalfFloatVideoUpload = true;

  return {
    backend: 'webgl2',
    get hdrOutputActive() {
      return hdrConfigured;
    },
    setTargetHdr(wantHdr) {
      configureCanvasHdr(wantHdr);
    },
    async renderFrame(rawFrame, colorMeta, rpuMeta, wantHdr = false) {
      const w = rawFrame.displayWidth || rawFrame.codedWidth || 2;
      const h = rawFrame.displayHeight || rawFrame.codedHeight || 2;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        if (wantHdr) configureCanvasHdr(true);
      }

      const wrapped = wrapFramePreventingSdrClamp(rawFrame, colorMeta);
      let inputModeCode = wrapped.inputMode === 'bt709-override' ? 1 : wrapped.inputMode === 'planar10' ? 2 : 0;

      try {
        if (inputModeCode === 2 && typeof rawFrame.allocationSize === 'function') {
          const needed = rawFrame.allocationSize();
          if (!planeScratch || planeScratch.byteLength < needed) {
            planeScratch = new Uint8Array(needed);
          }
          const layout = await rawFrame.copyTo(planeScratch);
          if (layout?.length >= 3) {
            const cw = rawFrame.codedWidth || w;
            const ch = rawFrame.codedHeight || h;
            const fmt = String(rawFrame.format || '');
            const uvW = /444/.test(fmt) ? cw : cw >> 1;
            const uvH = /420/.test(fmt) ? ch >> 1 : ch;
            const uploadPlane = (unit, tex, planeLayout, pw, ph) => {
              gl.activeTexture(gl.TEXTURE0 + unit);
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.pixelStorei(gl.UNPACK_ROW_LENGTH, Math.floor(planeLayout.stride / 2));
              const view = new Uint16Array(
                planeScratch.buffer,
                planeScratch.byteOffset + planeLayout.offset,
                Math.floor((planeScratch.byteLength - planeLayout.offset) / 2),
              );
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, pw, ph, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, view);
              gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
            };
            uploadPlane(1, texY, layout[0], cw, ch);
            uploadPlane(2, texU, layout[1], uvW, uvH);
            uploadPlane(3, texV, layout[2], uvW, uvH);
          } else {
            inputModeCode = 0;
          }
        }
        if (inputModeCode !== 2) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texRgb);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          if (inputModeCode === 1 && canHalfFloatVideoUpload && gl.RGBA16F && gl.HALF_FLOAT) {
            try {
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, wrapped.frame);
              if (typeof gl.getError === 'function' && gl.getError() !== gl.NO_ERROR) {
                canHalfFloatVideoUpload = false;
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, wrapped.frame);
              }
            } catch {
              canHalfFloatVideoUpload = false;
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, wrapped.frame);
            }
          } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, wrapped.frame);
          }
        }

        const effectiveHdr = Boolean(wantHdr && hdrConfigured);
        const u = computeTonemapUniforms(
          wrapped.rangeAlreadyExpanded ? { ...colorMeta, fullRange: true } : colorMeta,
          rpuMeta,
          {
            targetHdr: effectiveHdr,
            inputMode: inputModeCode === 2 ? 'planar10' : inputModeCode === 1 ? 'bt709-override' : 'passthrough',
          },
        );

        frameCounter = (frameCounter + 1) % 1024;
        gl.viewport(0, 0, w, h);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.uniform2f(locs.uResolution, w, h);
        gl.uniform1i(locs.uInputMode, inputModeCode);
        gl.uniform1i(locs.uTransferType, u.isPq ? 1 : u.isHlg ? 2 : 0);
        gl.uniform1i(locs.uIsDoviP5, u.isDoviP5 ? 1 : 0);
        gl.uniform1i(locs.uUseDoviReshape, u.useDoviReshape ? 1 : 0);
        gl.uniform1i(locs.uFullRange, u.fullRange ? 1 : 0);
        gl.uniform1i(locs.uApplyBt2390, u.applyBt2390 ? 1 : 0);
        gl.uniform1i(locs.uTargetHdr, u.targetHdr ? 1 : 0);
        gl.uniform1i(locs.uDeband, u.debandEnabled ? 1 : 0);
        gl.uniform4f(locs.uToneParams, u.srcMinPq, u.srcMaxPq, u.maxLumNorm, u.kneeStart);
        gl.uniform4f(locs.uScaleParams, u.sdrWhiteNits, u.debandThreshold, u.ditherStrength, frameCounter);
        gl.uniformMatrix3fv(locs.uYccToRgb, false, toRowsInCols(u.yccToRgbMatrix));
        gl.uniform3fv(locs.uYccOffset, u.yccToRgbOffset);
        gl.uniformMatrix3fv(locs.uLmsToRgb, false, toRowsInCols(u.lmsToRgbMatrix));
        gl.uniformMatrix3fv(locs.uGamutMatrix, false, toRowsInCols(u.gamutMatrix));
        gl.uniform3iv(locs.uPieceCounts, u.pieceCounts);
        gl.uniform1fv(locs.uPivots, u.pivotsFlat);
        gl.uniform4fv(locs.uPoly, u.polyFlat);
        gl.uniform4fv(locs.uMmr, u.mmrFlat);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } finally {
        if (wrapped.owned) {
          try {
            wrapped.frame.close();
          } catch {}
        }
      }
    },
    destroy() {
      try {
        gl.deleteTexture(texRgb);
        gl.deleteTexture(texY);
        gl.deleteTexture(texU);
        gl.deleteTexture(texV);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(prog);
      } catch {}
    },
  };
}

async function createWebGpuRenderer(canvas, initialTargetHdr = false) {
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return null;
  const adapter = await globalThis.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const probeModule = device.createShaderModule({ code: WGSL_SHADER });
  if (!probeModule) {
    device.destroy?.();
    return null;
  }
  if (typeof probeModule.getCompilationInfo === 'function') {
    const info = await probeModule.getCompilationInfo();
    if (info?.messages?.some(m => m.type === 'error')) {
      device.destroy?.();
      return null;
    }
  }
  const ctx = canvas.getContext('webgpu');
  if (!ctx) {
    device.destroy?.();
    return null;
  }

  let currentFormat = globalThis.navigator.gpu.getPreferredCanvasFormat?.() || 'bgra8unorm';
  let hdrConfigured = false;
  function configureContext(wantHdr) {
    hdrConfigured = false;
    if (wantHdr) {
      try {
        ctx.configure({
          device,
          format: 'rgba16float',
          colorSpace: 'display-p3',
          toneMapping: { mode: 'extended' },
          alphaMode: 'opaque',
        });
        currentFormat = 'rgba16float';
        hdrConfigured = true;
        return;
      } catch {
        hdrConfigured = false;
      }
    }
    currentFormat = globalThis.navigator.gpu.getPreferredCanvasFormat?.() || 'bgra8unorm';
    ctx.configure({
      device,
      format: currentFormat,
      alphaMode: 'opaque',
    });
  }
  configureContext(initialTargetHdr);

  const shaderModule = probeModule;
  const pipelines = new Map();
  function getPipeline(format) {
    let p = pipelines.get(format);
    if (!p) {
      p = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shaderModule, entryPoint: 'vsMain' },
        fragment: {
          module: shaderModule,
          entryPoint: 'fsMain',
          targets: [{ format }],
        },
        primitive: { topology: 'triangle-list' },
      });
      pipelines.set(format, p);
    }
    return p;
  }

  // Uniform buffer size: 145 vec4s (16 header/matrix + 9 pivots + 24 poly + 96 MMR) = 2320 bytes
  const UNIFORM_FLOATS = 145 * 4;
  const uniformArray = new ArrayBuffer(UNIFORM_FLOATS * 4);
  const uF32 = new Float32Array(uniformArray);
  const uU32 = new Uint32Array(uniformArray);
  const uniformBuffer = device.createBuffer({
    size: uniformArray.byteLength,
    usage: globalThis.GPUBufferUsage.UNIFORM | globalThis.GPUBufferUsage.COPY_DST,
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  let frameTex = null;
  let frameTexW = 0;
  let frameTexH = 0;
  let bindGroup = null;
  let bindGroupFormat = '';
  let frameCounter = 0;

  function ensureFrameTexture(w, h, format) {
    if (frameTex && frameTexW === w && frameTexH === h && bindGroup && bindGroupFormat === format) return;
    frameTex?.destroy?.();
    frameTex = device.createTexture({
      size: [w, h, 1],
      format: 'rgba16float',
      usage:
        globalThis.GPUTextureUsage.TEXTURE_BINDING |
        globalThis.GPUTextureUsage.COPY_DST |
        globalThis.GPUTextureUsage.RENDER_ATTACHMENT,
    });
    frameTexW = w;
    frameTexH = h;
    bindGroupFormat = format;
    const pipeline = getPipeline(format);
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: frameTex.createView() },
      ],
    });
  }

  return {
    backend: 'webgpu',
    get hdrOutputActive() {
      return hdrConfigured;
    },
    setTargetHdr(wantHdr) {
      if (Boolean(wantHdr) !== hdrConfigured) {
        configureContext(wantHdr);
        bindGroup = null;
      }
    },
    async renderFrame(rawFrame, colorMeta, rpuMeta, wantHdr = false) {
      const w = rawFrame.displayWidth || rawFrame.codedWidth || 2;
      const h = rawFrame.displayHeight || rawFrame.codedHeight || 2;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        configureContext(wantHdr);
        bindGroup = null;
      } else if (Boolean(wantHdr) && !hdrConfigured) {
        // Already probed/configured
      }
      const wrapped = wrapFramePreventingSdrClamp(rawFrame, colorMeta, { allowPlanar10: false });
      const inputModeCode = wrapped.inputMode === 'bt709-override' ? 1 : 0;
      const effectiveHdr = Boolean(wantHdr && hdrConfigured);
      try {
        ensureFrameTexture(w, h, currentFormat);
        device.queue.copyExternalImageToTexture({ source: wrapped.frame }, { texture: frameTex, colorSpace: 'srgb' }, [
          w,
          h,
        ]);

        const u = computeTonemapUniforms(
          wrapped.rangeAlreadyExpanded ? { ...colorMeta, fullRange: true } : colorMeta,
          rpuMeta,
          {
            targetHdr: effectiveHdr,
            inputMode: wrapped.inputMode,
          },
        );

        frameCounter = (frameCounter + 1) % 1024;
        uF32.fill(0);
        uF32[0] = w;
        uF32[1] = h;
        uU32[2] = inputModeCode;
        uU32[3] = u.isPq ? 1 : u.isHlg ? 2 : 0;
        uU32[4] = u.isDoviP5 ? 1 : 0;
        uU32[5] = u.useDoviReshape ? 1 : 0;
        uU32[6] = u.fullRange ? 1 : 0;
        uU32[7] = u.applyBt2390 ? 1 : 0;
        uU32[8] = u.targetHdr ? 1 : 0;
        uU32[9] = u.debandEnabled ? 1 : 0;
        uU32[10] = u.pieceCounts[0];
        uU32[11] = u.pieceCounts[1];
        uU32[12] = u.pieceCounts[2];

        // toneParams @ vec4[4] (float index 16)
        uF32[16] = u.srcMinPq;
        uF32[17] = u.srcMaxPq;
        uF32[18] = u.maxLumNorm;
        uF32[19] = u.kneeStart;
        // scaleParams @ vec4[5] (float index 20)
        uF32[20] = u.sdrWhiteNits;
        uF32[21] = u.debandThreshold;
        uF32[22] = u.ditherStrength;
        uF32[23] = frameCounter;

        const setMat = (baseVec4, m) => {
          const f = baseVec4 * 4;
          uF32[f + 0] = m[0];
          uF32[f + 1] = m[1];
          uF32[f + 2] = m[2];
          uF32[f + 4] = m[3];
          uF32[f + 5] = m[4];
          uF32[f + 6] = m[5];
          uF32[f + 8] = m[6];
          uF32[f + 9] = m[7];
          uF32[f + 10] = m[8];
        };
        setMat(6, u.yccToRgbMatrix); // vec4 6..8
        uF32[36] = u.yccToRgbOffset[0];
        uF32[37] = u.yccToRgbOffset[1];
        uF32[38] = u.yccToRgbOffset[2];
        setMat(10, u.lmsToRgbMatrix); // vec4 10..12
        setMat(13, u.gamutMatrix); // vec4 13..15

        // pivots: 9 vec4s starting at vec4[16] (float 64..99)
        for (let i = 0; i < 27; i++) uF32[64 + i] = u.pivotsFlat[i];
        // poly: 24 vec4s starting at vec4[25] (float 100..195)
        uF32.set(u.polyFlat, 100);
        // mmr: 96 vec4s starting at vec4[49] (float 196..579)
        uF32.set(u.mmrFlat, 196);

        device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: ctx.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        pass.setPipeline(getPipeline(currentFormat));
        pass.setBindGroup(0, bindGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();
        device.queue.submit([encoder.finish()]);
      } finally {
        if (wrapped.owned) {
          try {
            wrapped.frame.close();
          } catch {}
        }
      }
    },
    destroy() {
      try {
        frameTex?.destroy?.();
        uniformBuffer?.destroy?.();
        ctx?.unconfigure?.();
        device?.destroy?.();
      } catch {}
    },
  };
}

/**
 * Create an `OffscreenCanvas` GPU video renderer (WebGPU preferred, automatic WebGL2 fallback).
 * @param {any} canvas
 * @param {{preferWebGpu?: boolean, targetHdr?: boolean}} [options]
 */
export async function createOffscreenRenderer(canvas, { preferWebGpu = true, targetHdr = false } = {}) {
  if (!canvas) return null;
  if (preferWebGpu) {
    try {
      const gpu = await createWebGpuRenderer(canvas, targetHdr);
      if (gpu) return gpu;
    } catch {
      /* Fall back to WebGL2 on a separate context if untouched or when WebGPU adapter fails. */
    }
  }
  try {
    const gl2 = createWebGl2Renderer(canvas, targetHdr);
    if (gl2) return gl2;
  } catch {}
  return null;
}
