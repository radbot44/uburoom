'use strict';
const flag = value => value === true || value === 1 || value === '1';
const id = value => (/^\d{1,20}$/.test(String(value ?? '')) ? String(value) : undefined);

/**
 * A Plex media part's audio and subtitle streams as the neutral descriptors
 * server/media-tracks.js catalogs. A stream Plex gives no usable id is left out.
 * @param {any} part
 * @returns {import('../media-tracks').TrackSource[]}
 */
function streams(part) {
  const sources = [];
  for (const stream of part?.Stream || []) {
    const kind = Number(stream.streamType) === 2 ? 'audio' : Number(stream.streamType) === 3 ? 'subtitles' : undefined;
    const streamId = id(stream.id);
    if (!kind || !streamId) continue;
    sources.push({
      kind,
      id: streamId,
      index: stream.index,
      codec: stream.codec,
      language: stream.languageCode || stream.languageTag || stream.language,
      languageName: stream.language,
      title: stream.title,
      label: stream.displayTitle || stream.title || stream.language,
      selected: flag(stream.selected),
      default: flag(stream.default),
      forced: flag(stream.forced),
      sdh: flag(stream.hearingImpaired),
      commentary: flag(stream.commentary),
      description: flag(stream.visualImpaired),
      channels: stream.channels,
      external: typeof stream.key === 'string' && /^\/library\/streams\/\d{1,20}(?:\.[a-z0-9]+)?$/.test(stream.key),
    });
  }
  return sources;
}

module.exports = { streams };
