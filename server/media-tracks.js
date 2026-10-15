'use strict';
const { PlaybackError } = require('./av1');
const flag = value => value === true || value === 1 || value === '1';
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200) : '';
const id = value => /^\d{1,20}$/.test(String(value ?? '')) ? String(value) : undefined;
const plain = new Set(['srt','subrip','webvtt','vtt','mov_text','text']);
const burnable = new Set([...plain,'ass','ssa','pgs','hdmv_pgs_subtitle','vobsub','dvd_subtitle']);
function catalog(part) {
  const tracks = {audio:[],subtitles:[]};
  for (const stream of part.Stream || []) {
    const kind = Number(stream.streamType) === 2 ? 'audio' : Number(stream.streamType) === 3 ? 'subtitles' : undefined;
    const streamId = id(stream.id); if (!kind || !streamId || tracks[kind].some(t=>t.id===streamId)) continue;
    const codec = clean(stream.codec).toLowerCase(), language = clean(stream.languageCode || stream.languageTag || stream.language).toLowerCase();
    const index = Number.isSafeInteger(stream.index) && stream.index >= 0 && stream.index <= 1023 ? stream.index : undefined;
    const external = typeof stream.key === 'string' && /^\/library\/streams\/\d{1,20}(?:\.[a-z0-9]+)?$/.test(stream.key);
    const track = {id:streamId,index,ordinal:tracks[kind].length,codec,language,languageName:clean(stream.language),
      title:clean(stream.title),label:clean(stream.displayTitle || stream.title || stream.language) || (kind==='audio' ? 'Audio' : 'Subtitles') + ' '+(tracks[kind].length+1),
      selected:flag(stream.selected),default:flag(stream.default),forced:flag(stream.forced),sdh:flag(stream.hearingImpaired),
      commentary:flag(stream.commentary),description:flag(stream.visualImpaired),channels:Number(stream.channels) || undefined,external,
      delivery:kind==='subtitles' ? external && plain.has(codec) ? 'text' : 'burn' : undefined,
      available:kind==='audio' || burnable.has(codec)};
    if (!track.available) track.reason = 'This subtitle format is not supported by the current player.';
    tracks[kind].push(track);
  }
  return tracks;
}
function intent(track) {
  return track && {language:track.language,title:track.title,forced:track.forced,sdh:track.sdh,commentary:track.commentary,description:track.description};
}
function matchIntent(rows, wanted) {
  if (!wanted?.language) return;
  const matches = rows.filter(row => row.language===wanted.language && ['forced','sdh','commentary','description'].every(key=>!!row[key]===!!wanted[key]));
  const exact = matches.filter(row=>row.title===wanted.title);
  return exact.length===1 ? exact[0] : matches.length===1 ? matches[0] : undefined;
}
function select(tracks, options = {}) {
  const audioChoice = options.audioId ?? 'auto', subtitleChoice = options.subtitleId ?? 'auto';
  const choose = (rows,choice,wanted,subtitle) => {
    if (choice === 'off') return;
    if (choice !== 'auto') {
      const row = rows.find(row=>row.id===choice);
      if (!row) throw new PlaybackError('That track does not belong to this video.');
      if (!row.available) throw new PlaybackError(row.reason);
      return row;
    }
    return matchIntent(rows,wanted) || rows.find(row=>row.selected) || (!subtitle && (rows.find(row=>row.default) || rows[0])) || undefined;
  };
  const audio = choose(tracks.audio,audioChoice,options.audioIntent,false), subtitle = choose(tracks.subtitles,subtitleChoice,options.subtitleIntent,true);
  return {audioChoice,subtitleChoice,audio,subtitle};
}
function publicCatalog(tracks) {
  const publicRow = ({index,ordinal,...row}) => row;
  return {audio:tracks.audio.map(publicRow),subtitles:tracks.subtitles.map(publicRow)};
}
module.exports = {catalog,select,intent,publicCatalog};
