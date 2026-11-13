'use strict';
const { qualityDefinition, qualityId } = require('../shared/room-protocol.mjs');
const Sources = require('./plex-source');

// A fixed preference is a ceiling in both resolution and bitrate. Original
// qualifies by source bitrate alone, never as an unbounded fallback.
function candidates(choices, requested, source, { transcode = false } = {}) {
  requested = qualityId(requested);
  if (requested === 'direct') return choices.filter(q => q.id === 'direct');
  const target = qualityDefinition(requested);
  if (!target) return [];
  const original = source?.source && Sources.select(source.source, source.sourceSelection).media;
  const directHeight = Math.max(original?.height || 0, Math.round(((original?.width || 0) * 9) / 16));
  const size = q => (q.id === 'direct' ? { height: directHeight, bitrate: original?.bitrate } : q);
  return choices
    .filter(q => {
      if (transcode && q.id === 'direct') return false;
      const value = size(q);
      return (
        value.bitrate > 0 &&
        value.bitrate <= target.bitrate &&
        (q.id === 'direct' || (value.height > 0 && value.height <= target.height))
      );
    })
    .sort(
      (a, b) =>
        size(b).height - size(a).height ||
        size(b).bitrate - size(a).bitrate ||
        Number(b.id === 'direct') - Number(a.id === 'direct'),
    );
}
function alternatives(choices, requested, source, options) {
  return candidates(choices, requested, source, options).filter(q => q.id !== qualityId(requested));
}
module.exports = { candidates, alternatives };
