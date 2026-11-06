// @ts-check
'use strict';
const { localFormat } = require('../web/playback-policy');

/**
 * @typedef {Object} DeliveryRequest
 * @property {string} quality - Normalized quality identifier.
 * @property {boolean} [compatible] - Viewer needs an output the browser can decode.
 * @property {string} [fallback] - Requested local conversion codec.
 * @property {boolean} [burn] - Selected subtitles must be burned into the video.
 * @property {number} audioTracks - Audio tracks offered by the selected source.
 * @property {boolean} [sourceOnly] - Resolve the source without preparing delivery.
 */

/**
 * @typedef {Object} DeliveryPlan
 * @property {'file'|'local'|'plex-hls'} route
 * @property {'source-only'|'original'|'local-fallback'|'burn-in'|'compatible'|'multiple-audio'|'quality-limit'} reason
 */

/**
 * Choose how one viewer receives one source. The reason explains the choice in
 * diagnostics; it is not evidence that the viewer can decode the result.
 * @param {DeliveryRequest} request
 * @returns {DeliveryPlan}
 */
function planDelivery({ quality, compatible, fallback, burn, audioTracks, sourceOnly }) {
  if (sourceOnly) return { route: 'file', reason: 'source-only' };
  if (localFormat(fallback)) return { route: 'local', reason: 'local-fallback' };
  if (burn) return { route: 'plex-hls', reason: 'burn-in' };
  if (compatible) return { route: 'plex-hls', reason: 'compatible' };
  if (quality !== 'direct') return { route: 'plex-hls', reason: 'quality-limit' };
  // Only a conversion can select one audio track from several.
  return audioTracks > 1 ? { route: 'plex-hls', reason: 'multiple-audio' } : { route: 'file', reason: 'original' };
}

module.exports = { planDelivery };
