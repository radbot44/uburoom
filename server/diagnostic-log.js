// @ts-check
'use strict';
const fs = require('fs');
const path = require('path');
const { cleanRow } = require('../web/playback-diagnostics');

const DAY = 86400000;
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const pad = (n, size = 2) => String(n).padStart(size, '0');
// The server's own clock and zone, so one evening stays in one file and reads naturally.
function localDay(at) {
  const d = new Date(at);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function localTime(at) {
  const d = new Date(at),
    offset = -d.getTimezoneOffset(),
    sign = offset < 0 ? '-' : '+';
  return (
    localDay(at) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    '.' +
    pad(d.getMilliseconds(), 3) +
    sign +
    pad(Math.floor(Math.abs(offset) / 60)) +
    ':' +
    pad(Math.abs(offset) % 60)
  );
}

/**
 * One timeline per day of what players and the server saw, kept on the server so a
 * problem can be read afterwards without asking viewers for anything. Lines are JSON:
 * server log lines (`source: 'server'`) and viewer player rows (`source: 'viewer'`).
 * Writes are batched and asynchronous so playback never waits on the disk, and the
 * folder never grows past its size limit.
 */
class DiagnosticLog {
  /**
   * @param {{directory:string, keepDays:number, maxBytes:number, logger?:any, now?:() => number}} options
   */
  constructor({ directory, keepDays, maxBytes, logger, now = Date.now }) {
    Object.assign(this, { directory, keepDays, maxBytes, logger, now });
    /** @type {Map<string,string[]>} lines waiting to be written, per day */
    this.pending = new Map();
    /** @type {Map<string,number>} bytes on disk per day */
    this.sizes = new Map();
    /** @type {Map<string,number>} last kept sequence per viewer page load */
    this.cursors = new Map();
    this.full = '';
    this.writing = Promise.resolve();
    this.timer = setInterval(() => void this.flush(), 2000);
    this.pruner = setInterval(() => void this.prune(), 3600000);
    this.timer.unref?.();
    this.pruner.unref?.();
    this.ready = fs.promises
      .mkdir(directory, { recursive: true })
      .then(() => this.prune())
      .catch(error => {
        this.logger?.warn?.('Diagnostics', `Diagnostics folder unavailable: ${error.message}`);
      });
  }
  append(at, line) {
    const day = localDay(at),
      lines = this.pending.get(day) || [];
    if (lines.length >= 20000) return;
    lines.push(JSON.stringify(line));
    this.pending.set(day, lines);
  }
  /** A line the server logged at info or above. */
  server(level, tag, message) {
    const at = this.now();
    this.append(at, { at: localTime(at), source: 'server', level, tag, message: String(message).slice(0, 2000) });
  }
  /**
   * Rows uploaded by one viewer's player. Each row passes the recorder's own allowlist
   * again, and a row is kept once even if an upload is retried.
   * @param {{room:any, viewerId:string, name:string, title?:string, stream:string, rows:any[]}} upload
   * @returns {number} rows kept
   */
  viewer({ room, viewerId, name, title, stream, rows }) {
    const key = viewerId + '|' + stream,
      after = this.cursors.get(key) || 0,
      now = this.now();
    let last = after,
      kept = 0;
    for (const raw of rows) {
      const row = cleanRow(raw);
      if (!row || row.sequence <= after || Math.abs(row.at - now) > DAY) continue;
      last = Math.max(last, row.sequence);
      kept++;
      // The player's own change counters are kept apart so they never shadow the room's ID.
      const { at, room: roomChanges, media, stream: streamChanges, grant, observation, ...fields } = row;
      this.append(at, {
        at: localTime(at),
        source: 'viewer',
        room: room.s.roomId,
        roomName: room.s.alias || undefined,
        viewer: name,
        viewerId,
        title,
        ...fields,
        changes: { room: roomChanges, media, stream: streamChanges, grant, observation },
      });
    }
    if (last > after) {
      this.cursors.delete(key);
      this.cursors.set(key, last);
      if (this.cursors.size > 2000) this.cursors.delete(this.cursors.keys().next().value);
    }
    return kept;
  }
  flush() {
    const batches = [...this.pending];
    this.pending.clear();
    if (!batches.length) return this.writing;
    this.writing = this.writing
      .then(() => this.ready)
      .then(async () => {
        for (const [day, lines] of batches) {
          const text = lines.join('\n') + '\n',
            bytes = Buffer.byteLength(text);
          if (this.total() + bytes > this.maxBytes) await this.prune();
          // Never grow past the limit, even within one busy day.
          if (this.total() + bytes > this.maxBytes) {
            if (this.full !== day) {
              this.full = day;
              this.logger?.warn?.(
                'Diagnostics',
                'The diagnostics folder is full, so new entries are skipped until the oldest day is removed. Raise diagnostics.max_mb to keep more.',
              );
            }
            continue;
          }
          try {
            await fs.promises.appendFile(path.join(this.directory, day + '.jsonl'), text);
            this.sizes.set(day, (this.sizes.get(day) || 0) + bytes);
          } catch (error) {
            this.logger?.warn?.('Diagnostics', `Could not write diagnostics: ${error.message}`);
          }
        }
      });
    return this.writing;
  }
  total() {
    let sum = 0;
    for (const size of this.sizes.values()) sum += size;
    return sum;
  }
  /** Delete days past the limit, then the oldest days until the folder fits. Today stays. */
  async prune() {
    let files;
    try {
      files = await fs.promises.readdir(this.directory);
    } catch {
      return;
    }
    const days = [];
    for (const name of files.sort()) {
      const day = FILE.exec(name)?.[1];
      if (!day) continue;
      const file = path.join(this.directory, name),
        stat = await fs.promises.stat(file).catch(() => undefined);
      if (stat) days.push({ day, file, size: stat.size });
    }
    this.sizes = new Map(days.map(item => [item.day, item.size]));
    const today = localDay(this.now()),
      start = new Date(this.now());
    start.setHours(12, 0, 0, 0);
    start.setDate(start.getDate() - (this.keepDays - 1));
    const oldest = localDay(start.getTime());
    let total = this.total();
    for (const item of days) {
      if (item.day === today || (item.day >= oldest && total <= this.maxBytes)) continue;
      if (
        await fs.promises.unlink(item.file).then(
          () => true,
          () => false,
        )
      ) {
        total -= item.size;
        this.sizes.delete(item.day);
      }
    }
  }
  async close() {
    clearInterval(this.timer);
    clearInterval(this.pruner);
    await this.flush();
  }
}

module.exports = { DiagnosticLog };
