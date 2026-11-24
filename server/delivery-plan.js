// @ts-check
'use strict';
const { localFormat } = require('../shared/playback-policy.mjs');

/**
 * @typedef {Object} DeliveryRequest
 * @property {string} quality - Normalized quality identifier.
 * @property {boolean} [compatible] - Viewer needs an output the browser can decode.
 * @property {string} [fallback] - Output this viewer fell back to: a local codec, 'provider' for its own transcoder, or 'audio' for the provider keeping the video and converting only audio.
 * @property {boolean} [burn] - Selected subtitles must be burned into the video.
 * @property {number} audioTracks - Audio tracks offered by the selected source.
 * @property {boolean} [sourceOnly] - Resolve the source without preparing delivery.
 * @property {boolean} [remux] - uburoom can copy this picture and convert only the sound (server/remux.js).
 * @property {boolean} [ubuplayer] - Viewer's UbuPlayer WebCodecs/AudioWorklet engine can demux containers, select audio tracks, and decode home-theater audio from the original file.
 * @property {boolean} [clientRemux] - Legacy alias for UbuPlayer container/audio demux capability.
 * @property {boolean} [gpuTonemap] - Viewer's UbuPlayer OffscreenCanvas GPU pipeline supports libplacebo-equivalent BT.2390 tonemapping and Dolby Vision reshaping.
 * @property {boolean} [ubuplayerAllowed] - Server operator policy allowing UbuPlayer capabilities (true by default).
 * @property {boolean} [hdr] - Whether the source video is HDR.
 * @property {string} [hdrKind] - Source HDR format ('sdr', 'hdr10', 'hlg', 'dovi-p5', 'dovi-hdr10', 'dovi-hlg', 'dovi-sdr').
 * @property {boolean} [hdrDisplay] - When provided, whether the viewer's display/mode outputs native HDR.
 * @property {boolean} [doviNative] - When provided, whether the viewer's native media element decodes Dolby Vision Profile 5 directly.
 * @property {string[]} [outputs] - Outputs usable for this viewer, in configured priority order.
 */

/**
 * @typedef {Object} DeliveryPlan
 * @property {'file'|'local'|'provider-hls'|'remux'} route - The original file, uburoom's own conversion, or the provider's HLS transcode.
 * @property {string} [codec] - Local output codec.
 * @property {'source-only'|'original'|'local-fallback'|'provider-fallback'|'audio-conversion'|'burn-in'|'compatible'|'multiple-audio'|'quality-limit'} reason
 */

/**
 * Choose how one viewer receives one source. The reason explains the choice in
 * diagnostics; it is not evidence that the viewer can decode the result.
 * @param {DeliveryRequest} request
 * @returns {DeliveryPlan}
 */
function planDelivery({
  quality,
  compatible,
  fallback,
  burn,
  audioTracks,
  sourceOnly,
  remux,
  ubuplayer,
  clientRemux,
  gpuTonemap,
  ubuplayerAllowed = true,
  hdr,
  hdrKind,
  hdrDisplay,
  doviNative,
  outputs = ['provider'],
}) {
  if (sourceOnly) return { route: 'file', reason: 'source-only' };
  if (localFormat(fallback)) return { route: 'local', codec: fallback, reason: 'local-fallback' };
  if (fallback === 'provider') return { route: 'provider-hls', reason: 'provider-fallback' };
  const canUbuPlayer = ubuplayerAllowed !== false && Boolean(ubuplayer ?? clientRemux);
  const canGpuTonemap = canUbuPlayer && Boolean(gpuTonemap);
  if (fallback === 'audio' && quality === 'direct' && !burn)
    return { route: remux ? 'remux' : 'provider-hls', reason: 'audio-conversion' };
  const hdrIncompatible =
    hdrKind === 'dovi-p5'
      ? hdrDisplay !== undefined
        ? !(canGpuTonemap || (doviNative && hdrDisplay))
        : gpuTonemap === false && !doviNative
      : Boolean(hdr && hdrDisplay === false && !canGpuTonemap);
  const needsCompat = Boolean(compatible || hdrIncompatible);
  const reason = burn
    ? 'burn-in'
    : needsCompat
      ? 'compatible'
      : quality !== 'direct'
        ? 'quality-limit'
        : audioTracks > 1 && !canUbuPlayer
          ? 'multiple-audio'
          : undefined;
  if (!reason) return { route: 'file', reason: 'original' };
  // Choosing one audio track can keep the video untouched only through the provider's transcoder.
  if (reason === 'multiple-audio' && remux) return { route: 'remux', reason };
  if (reason === 'multiple-audio' && outputs.includes('provider')) return { route: 'provider-hls', reason };
  const first = outputs[0];
  return localFormat(first) ? { route: 'local', codec: first, reason } : { route: 'provider-hls', reason };
}

module.exports = { planDelivery };
