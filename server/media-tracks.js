'use strict';
const { PlaybackError } = require('./av1');
const clean = value => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : '');
const id = value => (/^[A-Za-z0-9_-]{1,64}$/.test(String(value ?? '')) ? String(value) : undefined);
const plain = new Set(['srt', 'subrip', 'webvtt', 'vtt', 'mov_text', 'text']);
const burnable = new Set([...plain, 'ass', 'ssa', 'pgs', 'hdmv_pgs_subtitle', 'vobsub', 'dvd_subtitle']);
/**
 * One audio or subtitle stream as its provider describes it. `index` is the stream's
 * position in the file, when the provider knows it; `external` marks a sidecar the
 * provider serves separately from the file.
 * @typedef {{kind: 'audio'|'subtitles', id: string, index?: number, codec?: string, language?: string,
 *   languageName?: string, title?: string, label?: string, selected?: boolean, default?: boolean, forced?: boolean,
 *   sdh?: boolean, commentary?: boolean, description?: boolean, channels?: number, external?: boolean}} TrackSource
 */
/**
 * The tracks a viewer may choose from, and how each subtitle can reach their player.
 * @param {TrackSource[]} sources
 */
function catalog(sources, { browserSubtitles = false, extractSubtitles = false } = {}) {
  const tracks = { audio: [], subtitles: [] };
  for (const stream of sources || []) {
    const kind = stream.kind === 'audio' || stream.kind === 'subtitles' ? stream.kind : undefined;
    const streamId = id(stream.id);
    if (!kind || !streamId || tracks[kind].some(t => t.id === streamId)) continue;
    const codec = clean(stream.codec).toLowerCase(),
      language = clean(stream.language).toLowerCase();
    const index =
      Number.isSafeInteger(stream.index) && stream.index >= 0 && stream.index <= 1023 ? stream.index : undefined;
    const external = stream.external === true;
    const track = {
      id: streamId,
      index,
      ordinal: tracks[kind].length,
      codec,
      language,
      languageName: clean(stream.languageName),
      title: clean(stream.title),
      label: clean(stream.label) || (kind === 'audio' ? 'Audio' : 'Subtitles') + ' ' + (tracks[kind].length + 1),
      selected: stream.selected === true,
      default: stream.default === true,
      forced: stream.forced === true,
      sdh: stream.sdh === true,
      commentary: stream.commentary === true,
      description: stream.description === true,
      channels: Number(stream.channels) || undefined,
      external,
      delivery:
        kind === 'subtitles'
          ? external && plain.has(codec)
            ? 'text'
            : browserSubtitles && (external || (extractSubtitles && index !== undefined))
              ? plain.has(codec)
                ? 'cues'
                : ['ass', 'ssa'].includes(codec)
                  ? 'ass'
                  : ['pgs', 'hdmv_pgs_subtitle'].includes(codec)
                    ? 'pgs'
                    : ['vobsub', 'dvd_subtitle'].includes(codec)
                      ? 'vobsub'
                      : 'burn'
              : 'burn'
          : undefined,
      available: kind === 'audio' || burnable.has(codec),
    };
    if (!track.available) track.reason = 'This subtitle format is not supported by the current player.';
    tracks[kind].push(track);
  }
  return tracks;
}
function intent(track) {
  return (
    track && {
      language: track.language,
      title: track.title,
      forced: track.forced,
      sdh: track.sdh,
      commentary: track.commentary,
      description: track.description,
    }
  );
}
function matchIntent(rows, wanted) {
  if (!wanted?.language) return;
  const available = rows.filter(row => row.available);
  const matches = available.filter(
    row =>
      row.language === wanted.language &&
      ['forced', 'sdh', 'commentary', 'description'].every(key => !!row[key] === !!wanted[key]),
  );
  const exact = matches.filter(row => row.title === wanted.title);
  if (exact.length > 0) return exact[0];
  if (matches.length > 0) return matches.find(row => row.selected) || matches.find(row => row.default) || matches[0];
}
function select(tracks, options = {}) {
  const audioChoice = options.audioId ?? 'auto',
    subtitleChoice = options.subtitleId ?? 'auto';
  const choose = (rows, choice, wanted, subtitle) => {
    if (choice === 'off') return;
    if (choice !== 'auto') {
      const row = rows.find(row => row.id === choice);
      if (!row) throw new PlaybackError('That track does not belong to this video.');
      if (!row.available) throw new PlaybackError(row.reason);
      return row;
    }
    return (
      matchIntent(rows, wanted) ||
      rows.find(row => row.selected) ||
      (!subtitle && (rows.find(row => row.default) || rows[0])) ||
      undefined
    );
  };
  const audio = choose(tracks.audio, audioChoice, options.audioIntent, false);
  let subtitle = choose(tracks.subtitles, subtitleChoice, options.subtitleIntent, true);
  if (subtitle && options.subtitleMode === 'burn') subtitle = { ...subtitle, delivery: 'burn' };
  return { audioChoice, subtitleChoice, audio, subtitle };
}
function publicCatalog(tracks) {
  const publicRow = ({ index, ordinal, ...row }) => row;
  return { audio: tracks.audio.map(publicRow), subtitles: tracks.subtitles.map(publicRow) };
}
module.exports = { catalog, select, intent, publicCatalog, matchIntent };
