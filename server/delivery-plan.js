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
function planDelivery({ quality, compatible, fallback, burn, audioTracks, sourceOnly, remux, outputs = ['provider'] }) {
  if (sourceOnly) return { route: 'file', reason: 'source-only' };
  if (localFormat(fallback)) return { route: 'local', codec: fallback, reason: 'local-fallback' };
  if (fallback === 'provider') return { route: 'provider-hls', reason: 'provider-fallback' };
  if (fallback === 'audio' && quality === 'direct' && !burn)
    return { route: remux ? 'remux' : 'provider-hls', reason: 'audio-conversion' };
  const reason = burn
    ? 'burn-in'
    : compatible
      ? 'compatible'
      : quality !== 'direct'
        ? 'quality-limit'
        : audioTracks > 1
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
