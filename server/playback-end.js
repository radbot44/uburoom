// @ts-check
'use strict';

/**
 * @typedef {Object} EndObservation
 * @property {string} epoch
 * @property {string} mediaVersion
 * @property {string} streamVersion
 * @property {string} observationEpoch
 * @property {number} sequence
 * @property {number} discontinuity
 * @property {number} sampleAt
 * @property {number} observedAt
 * @property {number} position
 * @property {number} rate
 * @property {number} frames
 * @property {string} state
 */
/**
 * @typedef {Object} EndEvidence
 * @property {object} room
 * @property {string} generation
 * @property {number} discontinuity
 * @property {number} sampleAt
 * @property {number} receivedAt
 * @property {number} position
 * @property {number} rate
 * @property {number} frames
 * @property {number} progress
 */

/** @type {WeakMap<object, EndEvidence>} */
const evidence = new WeakMap();
const REQUIRED_PROGRESS = 2;
const MAX_END_DELAY_MS = 2000;

/**
 * Invalidate evidence when a command changes shared playback intent.
 * @param {import('./types').Room} room
 */
function clearPlaybackEnd(room) {
  for (const viewer of room.viewers.values()) evidence.delete(viewer);
}

/**
 * Consume only observations already accepted by PlaybackTracking. Its credited
 * deltas prove decoded, sequential playback without seeks, gaps or clock jumps.
 * An ended report adds no watch credit and cannot prove an ending by itself.
 * @param {import('./types').Room} room
 * @param {import('./types').Viewer & {observationEpoch?: string}} viewer
 * @param {EndObservation} data
 * @param {{accepted: boolean, playbackId: string, credit: {reason: string, positionDelta?: number}}} result
 * @param {number} [now]
 * @returns {boolean}
 */
function observePlaybackEnd(room, viewer, data, result, now = Date.now()) {
  const previous = evidence.get(viewer);
  evidence.delete(viewer);
  const duration = room.media?.duration;
  if (!result?.accepted || !Number.isFinite(duration) || duration <= 0 ||
      !room.viewers.size || room.manualPaused || room.initialGate || room.pauseAt ||
      data.epoch !== room.s.epoch || data.mediaVersion !== room.mediaVersion ||
      viewer.mediaVersion !== room.mediaVersion || data.streamVersion !== viewer.streamVersion ||
      data.observationEpoch !== viewer.observationEpoch) return false;

  const generation = [data.epoch, data.mediaVersion, data.streamVersion, data.observationEpoch, result.playbackId].join('\0');
  const continuous = previous?.room === room && previous.generation === generation && previous.discontinuity === data.discontinuity;
  const required = Math.min(REQUIRED_PROGRESS, duration / 2);
  if (data.state === 'playing' && result.credit.reason === 'credited') {
    const advanced = result.credit.positionDelta;
    if (typeof advanced !== 'number' || !Number.isFinite(advanced) || advanced <= 0) return false;
    const adjoining = continuous && Math.abs(previous.position - (data.position - advanced)) < .001;
    evidence.set(viewer, {
      room, generation, discontinuity: data.discontinuity, sampleAt: data.sampleAt,
      receivedAt: now, position: data.position, rate: data.rate, frames: data.frames,
      progress: Math.min(required, advanced + (adjoining ? previous.progress : 0))
    });
    return false;
  }
  if (data.state !== 'ended' || !continuous || previous.progress < required) return false;
  const elapsed = data.sampleAt - previous.sampleAt, received = now - previous.receivedAt;
  const advanced = data.position - previous.position;
  // The final, uncredited sliver must follow the last verified playing sample.
  // In particular, an ended event after a jump to the end cannot use old credit.
  return elapsed >= 0 && elapsed <= MAX_END_DELAY_MS && received >= 0 && received <= MAX_END_DELAY_MS &&
    Math.abs(data.position - duration) <= .5 && previous.position >= duration - 1.5 &&
    advanced >= -.01 && advanced <= elapsed / 1000 * (previous.rate + data.rate) / 2 + .25 &&
    data.frames >= previous.frames && (advanced <= .25 || data.frames > previous.frames);
}

module.exports = { observePlaybackEnd, clearPlaybackEnd };
