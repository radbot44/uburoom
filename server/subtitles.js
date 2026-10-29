'use strict';
const { PlaybackError } = require('./av1');
const Sources = require('./plex-source');
const LIMIT = 4 * 1024 * 1024;
function timestamp(value) {
  const m = /^(?:(\d{1,6}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  return m && Number(m[2])<60 && Number(m[3])<60 ? Number(m[1]||0)*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000 : NaN;
}
function parse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text)>LIMIT) throw new PlaybackError('Subtitle file exceeds the supported size.');
  text = text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
    const at = lines.findIndex(line=>line.includes('-->')); if (at<0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/.exec(lines[at]);
    if (!match) throw new PlaybackError('Subtitle timing is invalid.');
    const start = timestamp(match[1]), end = timestamp(match[2]), value = lines.slice(at+1).join('\n');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || end>1e9 || value.length>16000 || cues.length>=10000) throw new PlaybackError('Subtitle timing or content is invalid.');
    if (value) cues.push({start,end,text:value,settings:match[3]||''});
  }
  if (!cues.length && !text.startsWith('WEBVTT')) throw new PlaybackError('The server did not return usable text subtitles.');
  return cues;
}
async function readText(response,signal) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    if (signal.aborted) throw new PlaybackError('Subtitle loading was cancelled.');
    size += chunk.length;
    if (size>LIMIT) { await response.body.cancel?.().catch(()=>{}); throw new PlaybackError('Subtitle file exceeds the supported size.'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function load(plex,media,signal) {
  const track = media.selection?.subtitle;
  if (!track?.available || track.delivery!=='text') throw new PlaybackError(track?.reason || 'No external text subtitle is selected.');
  const key = 'sidecar:'+track.id;
  media.subtitleCache ||= new Map();
  if (media.subtitleCache.has(key)) return media.subtitleCache.get(key);
  const abort = AbortSignal.any([signal,media.subtitleAbort.signal,AbortSignal.timeout(30000)]);
  const part = media.sourceSelection ? Sources.select(media.source, media.sourceSelection).part : media.source?.Media?.[0]?.Part?.[0];
  const source = part?.Stream?.find(s=>String(s.id)===track.id);
  if (!source || !/^\/library\/streams\/\d{1,20}(?:\.[a-z0-9]+)?$/.test(source.key || '')) throw new PlaybackError('Subtitle selection no longer belongs to this file.');
  const resource = /\.[a-z0-9]+$/.test(source.key) ? source.key : source.key+'.'+({subrip:'srt',webvtt:'vtt'}[track.codec] || track.codec);
  const url = plex.url(resource); url.searchParams.set('format','webvtt'); url.searchParams.set('encoding','utf-8');
  const text = await readText(await plex.request(url.href,{signal:abort,headers:{Accept:'text/vtt,text/plain'}}),abort);
  if (abort.aborted) throw new PlaybackError('Subtitle loading was cancelled.');
  const cues = parse(text);
  while (media.subtitleCache.size>=3) media.subtitleCache.delete(media.subtitleCache.keys().next().value);
  media.subtitleCache.set(key,cues); return cues;
}
module.exports = {LIMIT,parse,load};
