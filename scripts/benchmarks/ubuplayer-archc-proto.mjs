import LibAV from '../../web/vendor/libav/libav-uburoom.mjs';
import LibAVFactory from '../../web/vendor/libav/libav-6.11.9.0.2-uburoom.wasm.mjs';

const BLOCK_SIZE = 1024 * 1024;
const MAX_CACHED_BLOCKS = 24;
const SPLIT_LOCALITY_THRESHOLD_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_FONT_BYTES = 16 * 1024 * 1024;

function packetPtsSec(libav, pkt, tbNum, tbDen, originSec = 0) {
  if (pkt.pts !== undefined && pkt.ptshi !== -0x80000000) {
    return (libav.i64tof64(pkt.pts, pkt.ptshi || 0) * tbNum) / tbDen - originSec;
  }
  if (pkt.dts !== undefined && pkt.dtshi !== -0x80000000) {
    return (libav.i64tof64(pkt.dts, pkt.dtshi || 0) * tbNum) / tbDen - originSec;
  }
  return undefined;
}

function packetPosBytes(libav, pkt) {
  if (pkt.pos !== undefined && pkt.poshi !== -0x80000000) {
    const val = libav.i64tof64(pkt.pos, pkt.poshi || 0);
    return val >= 0 ? val : undefined;
  }
  return undefined;
}

/**
 * Isolated Track 2 Demuxer Architecture Prototype Harness.
 * Compares Arch A (3-Ctx Split), Arch B (Pure Unified 1-Ctx), and Arch C (Adaptive Hybrid).
 * Not wired into production UbuPlayer entrypoints.
 */
export async function runDemuxArchWorkload({
  arch = 'arch-c',
  buffer,
  windowSeconds = 12,
  switchAtSec = 5.0,
  switchAudioOrdinal = 1,
  enableLocalSubtitle = true,
  reopenCount = 1,
}) {
  const libav = await LibAV.LibAV({ noworker: true, factory: LibAVFactory });
  await libav.av_log_set_level(libav.AV_LOG_QUIET ?? -8);

  const metrics = {
    arch,
    mode: arch === 'arch-c' ? 'unified-interleaved' : arch,
    fileSize: buffer.byteLength,
    uniqueReadBytes: 0,
    onblockreadCalls: 0,
    bridgeCopyBytes: 0,
    duplicateVideoBytes: 0,
    videoPacketBytes: 0,
    audioPacketsRead: 0,
    subtitlePacketsRead: 0,
    fontAttachmentsBytes: 0,
    fontsTruncated: false,
    formatOriginSec: 0,
    firstAudioSampleSec: null,
    peakHeapU8Bytes: libav.HEAPU8?.byteLength || 0,
    switchWallMs: 0,
    totalWallMs: 0,
  };

  const trackHeap = () => {
    const h = libav.HEAPU8?.byteLength || 0;
    if (h > metrics.peakHeapU8Bytes) metrics.peakHeapU8Bytes = h;
  };

  for (let runIdx = 0; runIdx < reopenCount; runIdx++) {
    const t0 = performance.now();
    const blockCache = new Map();
    const handlers = new Map();
    const seenVideoKeys = new Set();

    libav.onblockread = async (name, pos, len) => {
      metrics.onblockreadCalls++;
      const handler = handlers.get(name);
      if (!handler) {
        await libav.ff_block_reader_dev_send(name, pos, new Uint8Array(0));
        return;
      }
      return handler(name, pos, len);
    };

    const readBytes = async (pos, len) => {
      if (pos >= buffer.byteLength) return new Uint8Array(0);
      const wantEnd = Math.min(buffer.byteLength, pos + Math.max(len, 65536));
      const firstBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOffset = pos - firstBlock * BLOCK_SIZE;
      const getBlock = idx => {
        if (blockCache.has(idx)) {
          const hit = blockCache.get(idx);
          blockCache.delete(idx);
          blockCache.set(idx, hit);
          return hit;
        }
        const s = idx * BLOCK_SIZE;
        const e = Math.min(buffer.byteLength, s + BLOCK_SIZE);
        if (s >= buffer.byteLength) return new Uint8Array(0);
        const slice = new Uint8Array(buffer.subarray(s, e));
        metrics.uniqueReadBytes += slice.byteLength;
        blockCache.set(idx, slice);
        if (blockCache.size > MAX_CACHED_BLOCKS) {
          blockCache.delete(blockCache.keys().next().value);
        }
        return slice;
      };
      const b0 = getBlock(firstBlock);
      const avail = b0.subarray(blockOffset);
      if (avail.length >= wantEnd - pos || firstBlock * BLOCK_SIZE + b0.length >= buffer.byteLength) {
        metrics.bridgeCopyBytes += avail.length;
        return avail;
      }
      const b1 = getBlock(firstBlock + 1);
      const joined = new Uint8Array(avail.length + b1.length);
      joined.set(avail, 0);
      joined.set(b1, avail.length);
      metrics.bridgeCopyBytes += joined.length;
      return joined;
    };

    const openDevice = async devName => {
      handlers.set(devName, async (name, pos, len) => {
        const bytes = await readBytes(pos, len);
        await libav.ff_block_reader_dev_send(name, pos, bytes);
        trackHeap();
      });
      await libav.mkblockreaderdev(devName, buffer.byteLength);
      const [ctx, streams] = await libav.ff_init_demuxer_file(devName);
      trackHeap();
      return { ctx, streams };
    };

    const closeDevice = async (ctx, devName) => {
      handlers.delete(devName);
      if (ctx) await libav.avformat_close_input_js(ctx).catch(() => {});
      await libav.unlink(devName).catch(() => {});
      if (libav.blockReadBuffers) delete libav.blockReadBuffers[devName];
    };

    const setDiscards = async (ctx, totalStreams, keepSet) => {
      for (let i = 0; i < totalStreams; i++) {
        const stPtr = await libav.AVFormatContext_streams_a(ctx, i);
        if (stPtr) {
          await libav.AVStream_discard_s(stPtr, keepSet.has(i) ? libav.AVDISCARD_DEFAULT : libav.AVDISCARD_ALL);
        }
      }
    };

    const seekCtx = async (ctx, vStream, sec, originSec) => {
      const target = Math.max(0, sec) + originSec;
      const ts = Math.round((target * vStream.time_base_den) / vStream.time_base_num);
      const [lo, hi] = libav.f64toi64(ts);
      const ret = await libav.avformat_seek_file_max(ctx, vStream.index, lo, hi);
      if (ret < 0) await libav.avformat_seek_file_approx(ctx, vStream.index, lo, hi);
    };

    const primaryDev = `bench_p_${runIdx}.media`;
    const auxDev = `bench_a_${runIdx}.media`;
    const subDev = `bench_s_${runIdx}.media`;

    const { ctx: pCtx, streams } = await openDevice(primaryDev);
    let aCtx = 0;
    let sCtx = 0;
    const pPkt = await libav.av_packet_alloc();
    let aPkt = 0;
    let sPkt = 0;

    try {
      let originSec = 0;
      if (typeof libav.AVFormatContext_start_time === 'function') {
        const stLo = await libav.AVFormatContext_start_time(pCtx);
        const stHi = await libav.AVFormatContext_start_timehi(pCtx);
        if (stHi !== -0x80000000 || stLo !== 0) {
          const raw = libav.i64tof64(stLo, stHi);
          if (Number.isFinite(raw) && raw > 0) originSec = raw / (libav.AV_TIME_BASE || 1e6);
        }
      }
      metrics.formatOriginSec = originSec;

      const vStream = streams.find(s => s.codec_type === libav.AVMEDIA_TYPE_VIDEO);
      const aStreams = streams.filter(s => s.codec_type === libav.AVMEDIA_TYPE_AUDIO);
      const sStreams = streams.filter(s => s.codec_type === libav.AVMEDIA_TYPE_SUBTITLE);
      let totalFonts = 0;
      for (let i = 0; i < streams.length; i++) {
        if (streams[i].codec_type === libav.AVMEDIA_TYPE_ATTACHMENT) {
          const size = await libav.AVCodecParameters_extradata_size(streams[i].codecpar);
          if (size > 0 && totalFonts + size <= MAX_TOTAL_FONT_BYTES) {
            totalFonts += size;
          } else if (size > 0) {
            metrics.fontsTruncated = true;
          }
        }
      }
      metrics.fontAttachmentsBytes = totalFonts;

      let activeAudio = aStreams[0] || null;
      const activeSub = enableLocalSubtitle ? sStreams[0] || null : null;

      // Locality Probe for Arch C
      let splitAudioMode = arch === 'arch-a';
      if (arch === 'arch-c' && vStream && activeAudio && totalFonts === 0) {
        let firstVPos;
        let firstAPos;
        for (let step = 0; step < 8 && (firstVPos === undefined || firstAPos === undefined); step++) {
          const [res, byStream] = await libav.ff_read_frame_multi(pCtx, pPkt, { limit: 262144 });
          for (const vp of byStream[vStream.index] || []) {
            if (firstVPos === undefined) firstVPos = packetPosBytes(libav, vp);
          }
          for (const ap of byStream[activeAudio.index] || []) {
            if (firstAPos === undefined) firstAPos = packetPosBytes(libav, ap);
          }
          if (res === libav.AVERROR_EOF) break;
        }
        if (
          firstVPos !== undefined &&
          firstAPos !== undefined &&
          Math.abs(firstVPos - firstAPos) > SPLIT_LOCALITY_THRESHOLD_BYTES
        ) {
          splitAudioMode = true;
          metrics.mode = 'persistent-split-audio';
        }
        await seekCtx(pCtx, vStream, 0, originSec);
      }

      const recordVideoPackets = pkts => {
        for (const vp of pkts) {
          const pts = packetPtsSec(libav, vp, vStream.time_base_num, vStream.time_base_den, originSec) ?? 0;
          const key = `${Math.round(pts * 1e6)}:${vp.data?.byteLength || 0}`;
          const len = vp.data?.byteLength || 0;
          if (seenVideoKeys.has(key)) metrics.duplicateVideoBytes += len;
          else seenVideoKeys.add(key);
          metrics.videoPacketBytes += len;
        }
      };

      const recordAudioPackets = (pkts, st) => {
        for (const ap of pkts) {
          metrics.audioPacketsRead++;
          if (metrics.firstAudioSampleSec === null) {
            const pts = packetPtsSec(libav, ap, st.time_base_num, st.time_base_den, originSec);
            if (pts !== undefined) metrics.firstAudioSampleSec = pts;
          }
        }
      };

      let videoUntil = 0;
      let audioUntil = 0;
      let subUntil = 0;

      if (arch === 'arch-a') {
        await setDiscards(pCtx, streams.length, new Set([vStream.index]));
        if (activeAudio) {
          ({ ctx: aCtx } = await openDevice(auxDev));
          aPkt = await libav.av_packet_alloc();
          await setDiscards(aCtx, streams.length, new Set([activeAudio.index]));
        }
        if (activeSub) {
          ({ ctx: sCtx } = await openDevice(subDev));
          sPkt = await libav.av_packet_alloc();
          await setDiscards(sCtx, streams.length, new Set([activeSub.index]));
        }
      } else if (arch === 'arch-b') {
        const keep = new Set([vStream.index]);
        if (activeAudio) keep.add(activeAudio.index);
        if (activeSub) keep.add(activeSub.index);
        await setDiscards(pCtx, streams.length, keep);
      } else {
        // Arch C
        if (splitAudioMode) {
          const keepPrimary = new Set([vStream.index]);
          if (activeSub) keepPrimary.add(activeSub.index);
          await setDiscards(pCtx, streams.length, keepPrimary);
          if (activeAudio) {
            ({ ctx: aCtx } = await openDevice(auxDev));
            aPkt = await libav.av_packet_alloc();
            await setDiscards(aCtx, streams.length, new Set([activeAudio.index]));
          }
        } else {
          const keep = new Set([vStream.index]);
          if (activeAudio) keep.add(activeAudio.index);
          if (activeSub) keep.add(activeSub.index);
          await setDiscards(pCtx, streams.length, keep);
        }
      }

      const pumpTo = async targetSec => {
        for (let iter = 0; iter < 400; iter++) {
          let progressed = false;
          if (videoUntil < targetSec) {
            const [res, by] = await libav.ff_read_frame_multi(pCtx, pPkt, { limit: 524288 });
            const vpk = by[vStream.index] || [];
            recordVideoPackets(vpk);
            for (const vp of vpk) {
              const pts =
                packetPtsSec(libav, vp, vStream.time_base_num, vStream.time_base_den, originSec) ?? videoUntil;
              videoUntil = Math.max(videoUntil, pts);
            }
            if (activeAudio && !aCtx) {
              const apk = by[activeAudio.index] || [];
              recordAudioPackets(apk, activeAudio);
              for (const ap of apk) {
                const pts =
                  packetPtsSec(libav, ap, activeAudio.time_base_num, activeAudio.time_base_den, originSec) ??
                  audioUntil;
                audioUntil = Math.max(audioUntil, pts);
              }
            }
            if (activeSub && !sCtx) {
              const spk = by[activeSub.index] || [];
              metrics.subtitlePacketsRead += spk.length;
              subUntil = Math.max(subUntil, Math.min(videoUntil, audioUntil || videoUntil));
            }
            if (res !== libav.AVERROR_EOF) progressed = true;
            else videoUntil = Math.max(videoUntil, targetSec);
          }
          if (aCtx && activeAudio && audioUntil < targetSec) {
            const [res, by] = await libav.ff_read_frame_multi(aCtx, aPkt, { limit: 262144 });
            const apk = by[activeAudio.index] || [];
            recordAudioPackets(apk, activeAudio);
            for (const ap of apk) {
              const pts =
                packetPtsSec(libav, ap, activeAudio.time_base_num, activeAudio.time_base_den, originSec) ?? audioUntil;
              audioUntil = Math.max(audioUntil, pts);
            }
            if (res !== libav.AVERROR_EOF) progressed = true;
            else audioUntil = Math.max(audioUntil, targetSec);
          }
          if (sCtx && activeSub && subUntil < targetSec) {
            const [res, by] = await libav.ff_read_frame_multi(sCtx, sPkt, { limit: 262144 });
            const spk = by[activeSub.index] || [];
            metrics.subtitlePacketsRead += spk.length;
            if (res === libav.AVERROR_EOF) subUntil = Math.max(subUntil, targetSec);
            else if (spk.length === 0) subUntil = Math.max(subUntil, videoUntil);
            else progressed = true;
          }
          if (!progressed || (videoUntil >= targetSec && (!activeAudio || audioUntil >= targetSec))) break;
        }
      };

      const hasSwitchTarget = switchAtSec > 0 && aStreams.length > switchAudioOrdinal;
      await pumpTo(hasSwitchTarget ? Math.min(windowSeconds, switchAtSec + 2) : windowSeconds);

      if (hasSwitchTarget) {
        const sw0 = performance.now();
        activeAudio = aStreams[switchAudioOrdinal];
        if (arch === 'arch-a') {
          await setDiscards(aCtx, streams.length, new Set([activeAudio.index]));
          await seekCtx(aCtx, vStream, switchAtSec, originSec);
          audioUntil = switchAtSec;
        } else if (arch === 'arch-b') {
          const keep = new Set([vStream.index, activeAudio.index]);
          if (activeSub) keep.add(activeSub.index);
          await setDiscards(pCtx, streams.length, keep);
          await seekCtx(pCtx, vStream, switchAtSec, originSec);
          videoUntil = switchAtSec;
          audioUntil = switchAtSec;
        } else {
          // Arch C Hitless Live Audio Switch
          if (splitAudioMode) {
            await setDiscards(aCtx, streams.length, new Set([activeAudio.index]));
            await seekCtx(aCtx, vStream, switchAtSec, originSec);
            audioUntil = switchAtSec;
          } else {
            const handoffMediaSec = videoUntil;
            const keep = new Set([vStream.index, activeAudio.index]);
            if (activeSub) keep.add(activeSub.index);
            await setDiscards(pCtx, streams.length, keep);

            // Ephemeral auxFmtCtx fills [switchAtSec + 0.25 .. handoffMediaSec] without re-reading video!
            const ephDev = `bench_eph_${runIdx}.media`;
            const { ctx: eCtx } = await openDevice(ephDev);
            const ePkt = await libav.av_packet_alloc();
            await setDiscards(eCtx, streams.length, new Set([activeAudio.index]));
            await seekCtx(eCtx, vStream, Math.max(0, switchAtSec - 1.5), originSec);
            let eUntil = 0;
            for (let k = 0; k < 200 && eUntil < handoffMediaSec; k++) {
              const [res, by] = await libav.ff_read_frame_multi(eCtx, ePkt, { limit: 262144 });
              const apk = by[activeAudio.index] || [];
              recordAudioPackets(apk, activeAudio);
              for (const ap of apk) {
                const pts =
                  packetPtsSec(libav, ap, activeAudio.time_base_num, activeAudio.time_base_den, originSec) ?? eUntil;
                eUntil = Math.max(eUntil, pts);
              }
              if (res === libav.AVERROR_EOF) break;
            }
            await libav.av_packet_free_js(ePkt);
            await closeDevice(eCtx, ephDev);
            audioUntil = Math.max(audioUntil, handoffMediaSec);
          }
        }
        metrics.switchWallMs = performance.now() - sw0;
        await pumpTo(windowSeconds);
      }
    } finally {
      if (pPkt) await libav.av_packet_free_js(pPkt);
      if (aPkt) await libav.av_packet_free_js(aPkt);
      if (sPkt) await libav.av_packet_free_js(sPkt);
      await closeDevice(pCtx, primaryDev);
      if (aCtx) await closeDevice(aCtx, auxDev);
      if (sCtx) await closeDevice(sCtx, subDev);
      trackHeap();
      metrics.totalWallMs += performance.now() - t0;
    }
  }

  return metrics;
}
