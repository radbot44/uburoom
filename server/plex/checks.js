'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const GB = 1024 ** 3;
// Plex refuses to transcode when its drive is nearly full; warn well before that.
const DISK = { warning: 25 * GB, problem: 10 * GB };

/**
 * What only Plex can say for the host's video check: whether it would play a file,
 * the space it transcodes into, and the conversions it is running. Nothing here
 * changes playback.
 */
class PlexChecks {
  constructor(plex) {
    this.plex = plex;
  }
  /** How the video check names whoever listed a file's tracks, and how to refresh that list. */
  get label() {
    return { name: 'Plex', owner: "Plex's", refresh: " In Plex, open the item's menu and choose Analyze." };
  }
  /** Checked once per file. */
  async file(media) {
    return [await this.decisionItem(media)].filter(Boolean);
  }
  /** Read fresh for every report. */
  async server() {
    return [await this.diskItem(), this.sessionItem()].filter(Boolean);
  }
  /** What Plex says it would do, for Original and the best converted quality. */
  async decisionItem(media) {
    const pipeline = this.plex.pipeline;
    if (!pipeline.conversionPolicy?.settings?.outputs?.includes('provider')) return;
    const offered = pipeline.qualities(media),
      labels = new Map(offered.map(q => [q.id, q.id === 'direct' ? 'Original' : q.label || q.id]));
    const checks = ['direct', offered.find(q => q.id !== 'direct')?.id].filter(id => id && labels.has(id));
    const results = [];
    for (const quality of checks) {
      const result = await this.plex
        .startDecision(media, quality)
        .catch(error => ({ ok: false, reason: String(error.message || error).slice(0, 200) }));
      results.push({ quality, ...result });
    }
    const name = quality => labels.get(quality);
    const refused = results.filter(result => !result.ok);
    if (refused.length)
      return {
        level: 'problem',
        topic: 'plex',
        title: 'Plex says it would not play ' + refused.map(result => name(result.quality)).join(' or '),
        detail: refused.map(result => name(result.quality) + ': ' + result.reason).join(' '),
      };
    return {
      level: 'ok',
      topic: 'plex',
      title: 'Plex would play ' + results.map(result => name(result.quality)).join(' and '),
    };
  }
  /** Free space where Plex writes transcodes, when Plex runs on this computer. */
  async diskItem() {
    const root = this.plex.root;
    if (!root.configured || !root.base) return;
    const host = root.base.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1', os.hostname().toLowerCase()].includes(host)) {
      return {
        level: 'info',
        topic: 'disk',
        title: "Plex's free space can't be checked",
        detail: 'Plex runs on another computer.',
      };
    }
    const prefs = await root.json('/:/prefs').catch(() => undefined);
    const configured = prefs?.Setting?.find(setting => setting.id === 'TranscoderTempDirectory')?.value;
    const home = os.homedir(),
      fallback =
        process.platform === 'win32'
          ? path.join(
              process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
              'Plex Media Server',
              'Cache',
              'Transcode',
            )
          : process.platform === 'darwin'
            ? path.join(home, 'Library', 'Application Support', 'Plex Media Server', 'Cache', 'Transcode')
            : '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Cache/Transcode';
    let directory = configured || fallback;
    while (!fs.existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory);
    const stats = await fs.promises.statfs(directory).catch(() => undefined);
    if (!stats) return;
    const free = stats.bavail * stats.bsize,
      text = Math.round(free / GB) + ' GB free on the drive Plex transcodes to';
    if (free < DISK.problem)
      return {
        level: 'problem',
        topic: 'disk',
        title: 'Plex is almost out of transcode space',
        detail: text + '. Plex refuses to convert below about 10 GB. Free some space.',
      };
    if (free < DISK.warning)
      return { level: 'warning', topic: 'disk', title: "Plex's transcode drive is getting full", detail: text + '.' };
    return { level: 'ok', topic: 'disk', title: text };
  }
  /** Plex's conversions as last reconciled (Plex.reconcileSessions). */
  sessionItem() {
    const sessions = this.plex.shared.sessionReport;
    if (!sessions) return;
    const title =
      'Plex is running ' +
      sessions.plexSessions +
      (sessions.plexSessions === 1 ? ' conversion' : ' conversions') +
      ', ' +
      sessions.uburoomSessions +
      ' for uburoom';
    return sessions.ended
      ? {
          level: 'warning',
          topic: 'sessions',
          title,
          detail: 'uburoom ended ' + sessions.ended + ' it was no longer using in the last check.',
        }
      : { level: 'ok', topic: 'sessions', title };
  }
}

module.exports = { PlexChecks, DISK };
