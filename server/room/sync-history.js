'use strict';
const { SPREAD_SAMPLE_INTERVAL_MS } = require('../../shared/sync/quality.mjs');

const RETENTION_MS = 15 * 60 * 1000;
const MAX_SAMPLES = RETENTION_MS / SPREAD_SAMPLE_INTERVAL_MS + 1;
const MAX_EVENTS = 180;
const MAX_REPORT_AGE_MS = 8000;
const history = new WeakMap();
const socketIds = new WeakMap();
let socketSequence = 0;

function recordRoomSyncTimeline(room, now) {
  if (!room.media) {
    history.delete(room);
    return;
  }
  let current = history.get(room);
  const paused = !!room.state.paused || room.startAt > now || (room.pauseAt > 0 && room.pauseAt <= now);
  if (current?.mediaVersion !== room.mediaVersion) {
    current = {
      mediaVersion: room.mediaVersion,
      samples: [],
      events: [[now, 'video']],
      paused,
    };
    history.set(room, current);
    return current;
  }
  if (paused !== current.paused) {
    current.paused = paused;
    current.events.push([now, paused ? 'pause' : 'play']);
  }
  if (current.events.length > MAX_EVENTS) current.events.splice(0, current.events.length - MAX_EVENTS);
  return current;
}

function sampleRoomSync(room, now) {
  const current = recordRoomSyncTimeline(room, now);
  if (!current || now - (current.samples.at(-1)?.at ?? -Infinity) < SPREAD_SAMPLE_INTERVAL_MS) return;
  const previousTabs = new Map(current.samples.at(-1)?.tabs.map(tab => [tab.id, tab.connection]));
  const tabs = [];
  let low = Infinity,
    high = -Infinity,
    reporting = 0;
  for (const [id, viewer] of room.viewers) {
    const quality = viewer.syncQuality;
    const connected = viewer.watchSocket ? viewer.watchSocket.readyState === 1 : viewer.connected !== false;
    const fresh =
      quality &&
      quality.mediaVersion === room.mediaVersion &&
      quality.streamVersion === viewer.streamVersion &&
      now - quality.updatedAt <= MAX_REPORT_AGE_MS;
    const status = !connected ? 'reconnecting' : fresh ? quality.status : 'unavailable';
    const offset =
      !current.paused &&
      status === 'playing' &&
      quality.confidence === 'confident' &&
      now - quality.measuredAt <= MAX_REPORT_AGE_MS &&
      Number.isFinite(quality.health?.offsetMs)
        ? Math.round(quality.health.offsetMs)
        : null;
    if (offset !== null) {
      reporting++;
      low = Math.min(low, offset);
      high = Math.max(high, offset);
    }
    const socket = viewer.watchSocket;
    if (socket && !socketIds.has(socket)) socketIds.set(socket, ++socketSequence);
    const connection = socket && socketIds.get(socket);
    const previousConnection = previousTabs.get(id);
    tabs.push({
      id,
      userId: viewer.userId,
      name: viewer.name,
      offset,
      status,
      connection,
      rejoined: !!connection && !!previousConnection && previousConnection !== connection,
    });
  }
  current.samples.push({ at: now, spread: reporting > 1 ? high - low : null, reporting, tabs });
  if (current.samples.length > MAX_SAMPLES) current.samples.shift();
}

const JOURNAL_SYNC_EVENT = Object.freeze({
  'media.start': 'video',
  'playback.play': 'play',
  'playback.pause': 'pause',
  'playback.seek': 'seek',
});

function roomSyncHistory(room, now, minutes, journal = undefined) {
  const since = now - minutes * 60 * 1000;
  const timeline = history.get(room);
  const current = room.media && timeline?.mediaVersion === room.mediaVersion ? timeline : undefined;
  const viewers = new Map();
  const samples = [];
  for (const sample of current?.samples || []) {
    if (sample.at < since) continue;
    samples.push([sample.at, sample.spread, sample.reporting, sample.tabs.length]);
    for (const tab of sample.tabs) {
      let series = viewers.get(tab.id);
      if (!series) {
        series = { id: tab.id, person: tab.userId, name: tab.name, points: [] };
        viewers.set(tab.id, series);
      }
      series.name = tab.name;
      series.points.push([sample.at, tab.offset, tab.status, tab.rejoined]);
    }
  }
  let events;
  if (journal && room.media) {
    events = [];
    for (const entry of journal.since(0)) {
      if (entry.at < since) continue;
      if (entry.mediaVersion !== room.mediaVersion) continue;
      const mapped = JOURNAL_SYNC_EVENT[entry.kind];
      if (mapped) events.push([entry.at, mapped]);
    }
    if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
  } else {
    events = (current?.events || []).filter(([at]) => at >= since);
  }
  return {
    now,
    mediaVersion: room.media ? room.mediaVersion : undefined,
    title: room.media?.title,
    interval: SPREAD_SAMPLE_INTERVAL_MS,
    samples,
    viewers: [...viewers.values()],
    events,
  };
}

module.exports = { recordRoomSyncTimeline, sampleRoomSync, roomSyncHistory };
