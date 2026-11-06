// @ts-check
'use strict';
const { localFormat } = require('../web/playback-policy');

/**
 * @typedef {Object} DeliveryRequest
 * @property {string} quality - Normalized quality identifier.
 * @property {boolean} [compatible] - Viewer needs an output the browser can decode.
 * @property {string} [fallback] - Output this viewer fell back to: a local codec or 'plex'.
 * @property {boolean} [burn] - Selected subtitles must be burned into the video.
 * @property {number} audioTracks - Audio tracks offered by the selected source.
 * @property {boolean} [sourceOnly] - Resolve the source without preparing delivery.
 * @property {string[]} [outputs] - Outputs usable for this viewer, in configured priority order.
 */

/**
 * @typedef {Object} DeliveryPlan
 * @property {'file'|'local'|'plex-hls'} route
 * @property {string} [codec] - Local output codec.
 * @property {'source-only'|'original'|'local-fallback'|'plex-fallback'|'burn-in'|'compatible'|'multiple-audio'|'quality-limit'} reason
 */

/**
 * Choose how one viewer receives one source. The reason explains the choice in
 * diagnostics; it is not evidence that the viewer can decode the result.
 * @param {DeliveryRequest} request
 * @returns {DeliveryPlan}
 */
function planDelivery({ quality, compatible, fallback, burn, audioTracks, sourceOnly, outputs = ['plex'] }) {
  if (sourceOnly) return { route: 'file', reason: 'source-only' };
  if (localFormat(fallback)) return { route: 'local', codec: fallback, reason: 'local-fallback' };
  if (fallback === 'plex') return { route: 'plex-hls', reason: 'plex-fallback' };
  const reason = burn ? 'burn-in' : compatible ? 'compatible' : quality !== 'direct' ? 'quality-limit' : audioTracks > 1 ? 'multiple-audio' : undefined;
  if (!reason) return { route: 'file', reason: 'original' };
  // Choosing one audio track can keep the video untouched only through Plex.
  if (reason === 'multiple-audio' && outputs.includes('plex')) return { route: 'plex-hls', reason };
  const first = outputs[0];
  return localFormat(first) ? { route: 'local', codec: first, reason } : { route: 'plex-hls', reason };
}

module.exports = { planDelivery };
