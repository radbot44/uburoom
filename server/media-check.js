// @ts-check
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, STREAM_CODECS, codecMatches, classifyHdr } = require('./av1');

const GB = 1024 ** 3;
// Plex refuses to transcode when its drive is nearly full; warn well before that.
const DISK = { warning: 25 * GB, problem: 10 * GB };
const IMAGE_SUBTITLES = new Set(['pgs', 'vobsub', 'dvd_subtitle', 'hdmv_pgs_subtitle']);
const EMBEDDED_SUBTITLES = new Set(['eia_608', 'eia_708', 'cea_608', 'cea_708']);
const LEVELS = ['problem', 'warning', 'info', 'ok'];

/**
 * @typedef {{level:'problem'|'warning'|'info'|'ok', topic:string, title:string, detail?:string}} CheckItem
 */

/**
 * Checks a video before and while a room plays it, for the host's info screen. File facts
 * (tracks, HDR, audio start, bitrate, what Plex would do) are gathered once per file and
 * kept; disk space and Plex sessions are read fresh each time. Nothing here changes playback.
 */
class MediaChecks {
  /** @param {{plex:any, config:any, sessions?:() => any}} options */
  constructor({ plex, config, sessions }) {
    Object.assign(this, { plex, config, sessions });
    /** @type {Map<string,{promise:Promise<CheckItem[]>, items?:CheckItem[], checkedAt?:number}>} */
    this.files = new Map();
  }
  key(media) { return media?.sourceKey; }
  /** Begin the file checks in the background; repeated calls share one run. */
  start(media) {
    const key = this.key(media);
    if (!key || media.kind !== 'plex') return;
    let entry = this.files.get(key);
    if (entry) { this.files.delete(key); this.files.set(key, entry); return entry; }
    const promise = this.fileItems(media).catch(error => [{ level: 'warning', topic: 'file', title: "This file couldn't be checked", detail: String(error.message || error).slice(0, 200) }]);
    entry = { promise };
    promise.then(items => { entry.items = items; entry.checkedAt = Date.now(); });
    this.files.set(key, entry);
    while (this.files.size > 50) this.files.delete(this.files.keys().next().value);
    return entry;
  }
  /** Drop a file's results so the next report checks it again (after Analyze in Plex). */
  forget(media) { this.files.delete(this.key(media)); }
  /** The full report for a room's current video. */
  async report(media) {
    const entry = this.start(media);
    const live = await Promise.all([this.diskItem(), this.sessionItem()]);
    const items = [...(entry?.items || []), ...live.filter(Boolean)];
    if (entry && !entry.items) items.push({ level: 'info', topic: 'file', title: 'Checking the file…' });
    items.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
    return { title: media?.title, checking: !!entry && !entry.items, checkedAt: entry?.checkedAt, level: items[0]?.level || 'ok', items };
  }
  probe(media, args) {
    const av1 = this.plex.av1;
    if (!av1?.ffprobe) throw new Error('FFprobe is not configured.');
    const signal = AbortSignal.timeout(120000);
    return av1.input({ ...media, start: media.sourceStart }, signal, url => run(av1.ffprobe, ['-v', 'error', ...args, url], signal, 120000, 16 * 1024 * 1024));
  }
  async fileItems(media) {
    const raw = await this.probe(media, ['-show_entries', 'stream=index,codec_type,codec_name,color_transfer:stream_side_data=side_data_type,dv_profile,bl_signal_compatibility_id:format=duration,bit_rate', '-of', 'json']);
    const info = JSON.parse(raw.toString()), streams = info.streams || [], items = [];
    items.push(this.trackItem(media, streams));
    const decisions = await this.decisionItem(media);
    if (decisions) items.push(decisions);
    const video = streams.find(stream => stream.codec_type === 'video');
    const hdr = this.hdrItem(video);
    if (hdr) items.push(hdr);
    const images = (media.tracks?.subtitles || []).filter(track => IMAGE_SUBTITLES.has(track.codec));
    if (images.length) items.push({ level: 'info', topic: 'subtitles', title: images.length + (images.length === 1 ? ' subtitle track is' : ' subtitle tracks are') + ' images',
      detail: 'They show on the page, but need Burn-in in iPhone fullscreen.' });
    if (streams.some(stream => stream.codec_type === 'audio')) items.push(await this.audioStartItem(media));
    const duration = Number(info.format?.duration), average = Number(info.format?.bit_rate) / 1e6;
    if (duration > 60) items.push(await this.bitrateItem(media, duration, average));
    return items.filter(Boolean);
  }
  hdrItem(video) {
    if (!video) return null;
    const hdrInfo = classifyHdr(video);
    if (hdrInfo.kind === 'dovi-p5') {
      return { level: 'warning', topic: 'hdr', title: hdrInfo.label, detail: 'Profile 5 uses proprietary Dolby Vision color without an HDR10 fallback layer; browsers without Profile 5 support require uburoom tone-mapping.' };
    }
    if (hdrInfo.kind === 'dovi-hdr10' || hdrInfo.kind === 'dovi-hlg') {
      return { level: 'info', topic: 'hdr', title: hdrInfo.label, detail: 'Converted qualities are tone-mapped for ordinary screens. Original keeps the compatible HDR base layer for screens that support it.' };
    }
    if (hdrInfo.kind === 'dovi-sdr') {
      return { level: 'info', topic: 'hdr', title: hdrInfo.label, detail: 'Includes an SDR-compatible base layer.' };
    }
    if (hdrInfo.hdr) {
      return { level: 'info', topic: 'hdr', title: hdrInfo.label, detail: 'Converted qualities are tone-mapped for ordinary screens. Original keeps ' + hdrInfo.label + ' for screens that support it.' };
    }
    return null;
  }
  /** Plex's track list against the file it serves (the Star Wars remux case). */
  trackItem(media, streams) {
    const rows = [...(media.tracks?.audio || []), ...(media.tracks?.subtitles || [])]
      .filter(row => !row.external && Number.isInteger(row.index) && !EMBEDDED_SUBTITLES.has(row.codec));
    const wrong = rows.filter(row => {
      const at = streams.find(stream => stream.index === row.index);
      return !at || !codecMatches(row.codec, at.codec_name);
    });
    const counts = type => streams.filter(stream => stream.codec_type === type).length;
    const plexAudio = (media.tracks?.audio || []).filter(row => !row.external).length;
    const plexSubtitles = (media.tracks?.subtitles || []).filter(row => !row.external && !EMBEDDED_SUBTITLES.has(row.codec)).length;
    if (wrong.length || plexAudio !== counts('audio') || plexSubtitles !== counts('subtitle')) {
      const detail = (plexAudio !== counts('audio') || plexSubtitles !== counts('subtitle'))
        ? 'Plex lists ' + plexAudio + ' audio and ' + plexSubtitles + ' subtitle tracks; the file has ' + counts('audio') + ' and ' + counts('subtitle') +
          '. uburoom finds tracks by order, but some may be wrong. In Plex, open the item\'s menu and choose Analyze.'
        : 'The file\'s tracks do not match Plex\'s saved stream information. In Plex, open the item\'s menu and choose Analyze.';
      return { level: 'problem', topic: 'tracks', title: "Plex's track info is out of date for this file", detail };
    }
    return { level: 'ok', topic: 'tracks', title: 'Tracks match the file' };
  }
  /** What Plex says it would do, for Original and the best converted quality. */
  async decisionItem(media) {
    if (!this.config.transcoding?.plex) return;
    const offered = this.plex.qualities(media), labels = new Map(offered.map(q => [q.id, q.id === 'direct' ? 'Original' : q.label || q.id]));
    const checks = ['direct', offered.find(q => q.id !== 'direct')?.id].filter(id => id && labels.has(id));
    const results = [];
    for (const quality of checks) {
      const result = await this.plex.startDecision(media, quality).catch(error => ({ ok: false, reason: String(error.message || error).slice(0, 200) }));
      results.push({ quality, ...result });
    }
    const name = quality => labels.get(quality);
    const refused = results.filter(result => !result.ok);
    if (refused.length) return { level: 'problem', topic: 'plex', title: 'Plex says it would not play ' + refused.map(result => name(result.quality)).join(' or '),
      detail: refused.map(result => name(result.quality) + ': ' + result.reason).join(' ') };
    return { level: 'ok', topic: 'plex', title: 'Plex would play ' + results.map(result => name(result.quality)).join(' and ') };
  }
  /** Audio that starts after the picture (the Hope case). */
  async audioStartItem(media) {
    const raw = (await this.probe(media, ['-read_intervals', '%+30', '-show_entries', 'packet=stream_index,codec_type,pts_time', '-of', 'csv=p=0'])).toString();
    let video, audio;
    for (const line of raw.split(/\r?\n/)) {
      const [type, , time] = line.split(','), at = Number(time);
      if (!Number.isFinite(at)) continue;
      if (type === 'video' && video === undefined) video = at;
      if (type === 'audio' && audio === undefined) audio = at;
      if (video !== undefined && audio !== undefined) break;
    }
    if (video === undefined) return;
    if (audio === undefined) return { level: 'warning', topic: 'audio', title: 'No audio in the first 30 seconds', detail: 'uburoom plays silence until the sound starts.' };
    const late = audio - video;
    if (late > 1) return { level: 'info', topic: 'audio', title: 'Audio starts ' + Math.round(late * 10) / 10 + ' s after the picture', detail: 'uburoom plays silence until the sound starts.' };
  }
  /** Peak video bitrate from three samples, for viewers watching Original. */
  async bitrateItem(media, duration, average) {
    let peak = 0;
    for (const share of [.25, .5, .75]) {
      const start = Math.floor(duration * share), bytes = new Map();
      const raw = (await this.probe(media, ['-read_intervals', start + '%+10', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0'])).toString();
      for (const line of raw.split(/\r?\n/)) {
        const [time, size] = line.split(',').map(Number);
        if (Number.isFinite(time) && Number.isFinite(size)) bytes.set(Math.floor(time), (bytes.get(Math.floor(time)) || 0) + size);
      }
      for (const total of bytes.values()) peak = Math.max(peak, total * 8 / 1e6);
    }
    if (!peak) return;
    const text = 'Video peaks at about ' + Math.round(peak) + ' Mbps' + (average > 0 ? ' (average ' + Math.round(average) + ' Mbps)' : '');
    return peak > 80 && peak > average * 1.8
      ? { level: 'warning', topic: 'bitrate', title: text, detail: 'Viewers on Original need that much bandwidth at peaks, or they will stall. A converted quality avoids it.' }
      : { level: 'info', topic: 'bitrate', title: text };
  }
  /** Free space where Plex writes transcodes, when Plex runs on this computer. */
  async diskItem() {
    if (!this.config.plexUrl || !this.plex.configured) return;
    let host;
    try { host = new URL(this.config.plexUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return; }
    if (!['127.0.0.1', 'localhost', '::1', os.hostname().toLowerCase()].includes(host)) {
      return { level: 'info', topic: 'disk', title: "Plex's free space can't be checked", detail: 'Plex runs on another computer.' };
    }
    const prefs = await this.plex.json('/:/prefs').catch(() => undefined);
    const configured = prefs?.Setting?.find(setting => setting.id === 'TranscoderTempDirectory')?.value;
    const home = os.homedir(), fallback = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Plex Media Server', 'Cache', 'Transcode')
      : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Plex Media Server', 'Cache', 'Transcode')
        : '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Cache/Transcode';
    let directory = configured || fallback;
    while (!fs.existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory);
    const stats = await fs.promises.statfs(directory).catch(() => undefined);
    if (!stats) return;
    const free = stats.bavail * stats.bsize, text = Math.round(free / GB) + ' GB free on the drive Plex transcodes to';
    if (free < DISK.problem) return { level: 'problem', topic: 'disk', title: 'Plex is almost out of transcode space', detail: text + '. Plex refuses to convert below about 10 GB. Free some space.' };
    if (free < DISK.warning) return { level: 'warning', topic: 'disk', title: "Plex's transcode drive is getting full", detail: text + '.' };
    return { level: 'ok', topic: 'disk', title: text };
  }
  sessionItem() {
    const sessions = this.sessions?.();
    if (!sessions) return;
    const title = 'Plex is running ' + sessions.plexSessions + (sessions.plexSessions === 1 ? ' conversion' : ' conversions') + ', ' + sessions.uburoomSessions + ' for uburoom';
    return sessions.ended
      ? { level: 'warning', topic: 'sessions', title, detail: 'uburoom ended ' + sessions.ended + ' it was no longer using in the last check.' }
      : { level: 'ok', topic: 'sessions', title };
  }
}

module.exports = { MediaChecks, DISK };
