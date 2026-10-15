'use strict';
const { randomUUID } = require('node:crypto');
const STATES = new Set(['playing','paused','buffering','seeking','ended','error','blocked']);
const GAP = 5000, MAX_INTERVALS = 2048;
function union(intervals) {
  const result = [];
  for (const [start,end] of intervals.sort((a,b)=>a[0]-b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1] + .001) last[1] = Math.max(last[1],end);
    else result.push([start,end]);
  }
  return result;
}
const length = intervals => intervals.reduce((sum,[a,b])=>sum+b-a,0);
class PlaybackTracking {
  constructor(registry, now = Date.now) {
    this.registry = registry; this.now = now; this.owned = !registry;
    this.db = registry?.db || new (require('node:sqlite').DatabaseSync)(':memory:');
    this.db.exec('CREATE TABLE IF NOT EXISTS playback_history(id TEXT PRIMARY KEY,userId TEXT NOT NULL,at INTEGER NOT NULL,record TEXT NOT NULL); CREATE INDEX IF NOT EXISTS playback_history_user ON playback_history(userId,at);');
    // Runtime viewers and consent are never restored after a process restart.
    for (const row of this.db.prepare('SELECT * FROM playback_history').all()) {
      const record = JSON.parse(row.record);
      if (!record.endedAt) { record.endedAt = record.lastReceivedAt; record.endReason = 'interrupted'; this.save(record); }
    }
    this.prune();
  }
  prune() {
    this.db.prepare('DELETE FROM playback_history WHERE at<?').run(this.now()-90*86400000);
    this.db.exec('DELETE FROM playback_history WHERE id IN (SELECT id FROM playback_history ORDER BY at DESC LIMIT -1 OFFSET 5000)');
  }
  save(record) { this.db.prepare('INSERT INTO playback_history VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,record=excluded.record').run(record.id,record.userId,record.lastReceivedAt,JSON.stringify(record)); }
  end(viewer, reason) {
    if (viewer.tracking) {
      const record = viewer.tracking.record;
      record.endedAt = this.now(); record.endReason = reason; this.save(record);
      viewer.tracking = undefined;
    }
    viewer.observationEpoch = randomUUID(); viewer.observationSequence = undefined; viewer.observationSample = undefined;
  }
  expire(viewer) { if (viewer.tracking && this.now()-viewer.tracking.record.lastReceivedAt > GAP) this.end(viewer,'observation-timeout'); }
  observe(room, viewer, viewerId, data) {
    const now = this.now();
    if (!viewer.media || viewer.mediaVersion !== room.mediaVersion || data.mediaVersion !== room.mediaVersion || data.streamVersion !== viewer.streamVersion || data.observationEpoch !== viewer.observationEpoch ||
      !Number.isSafeInteger(data.discontinuity) || data.discontinuity < 0 || !STATES.has(data.state) || !Number.isSafeInteger(data.sequence) || data.sequence <= (viewer.observationSequence ?? -1) ||
      !Number.isFinite(data.sampleAt) || data.sampleAt < 0 || data.sampleAt <= (viewer.observationSample ?? -1) ||
      !Number.isFinite(data.observedAt) || now-data.observedAt > 3000 || data.observedAt-now > 1000 ||
      !Number.isFinite(data.position) || data.position < 0 || data.position > room.media.duration+.5 ||
      !Number.isFinite(data.rate) || data.rate < .25 || data.rate > 4 || !Number.isSafeInteger(data.frames) || data.frames < 0) throw new Error('Invalid or stale playback observation');
    this.expire(viewer);
    if (data.observationEpoch !== viewer.observationEpoch) throw new Error('Playback observation expired');
    viewer.observationSequence = data.sequence; viewer.observationSample = data.sampleAt;
    const starting = !viewer.tracking;
    if (starting) {
      const identities = this.registry?.identities(viewer.userId).map(i=>({provider:i.provider,subject:i.subject})) || [];
      viewer.tracking = { record: { id:randomUUID(),userId:viewer.userId,identities,roomId:room.s.sessionId,viewerId,mediaId:room.media.id,duration:room.media.duration,mediaVersion:room.mediaVersion,streamVersion:viewer.streamVersion,
        deliveryMode:viewer.media.kind==='demo'?'local-fixture':({file:'original',hls:'plex-hls',av1:'uburoom-av1'}[viewer.media.format] || 'unknown'),startedAt:now,lastReceivedAt:now,watchedSeconds:0,sourceSeconds:0,wallIntervals:[],sourceIntervals:[] } };
    }
    const {record,previous} = viewer.tracking;
    if (previous) {
      const elapsed = (data.sampleAt-previous.sampleAt)/1000, received = (now-record.lastReceivedAt)/1000, advanced = data.position-previous.position;
      // Both boundaries must describe decoded playback. No tail extrapolation,
      // seek credit, room-clock credit or credit across a missing heartbeat.
      if (previous.state==='playing' && data.state==='playing' && previous.discontinuity===data.discontinuity && data.frames>previous.frames && elapsed>0 && elapsed<=GAP/1000 && received>0 && received<=GAP/1000 &&
        Math.abs(received-elapsed)<1 && Math.abs((data.observedAt-previous.observedAt)/1000-elapsed)<.25 && advanced>0 && Math.abs(advanced-elapsed*(previous.rate+data.rate)/2)<.25 && record.wallIntervals.length<MAX_INTERVALS && record.sourceIntervals.length<MAX_INTERVALS) {
        // Network jitter must not manufacture thousands of tiny source gaps.
        // These are the two validated observation boundaries, not projections.
        record.wallIntervals = union([...record.wallIntervals,[previous.observedAt,data.observedAt]]);
        record.sourceIntervals = union([...record.sourceIntervals,[previous.position,data.position]]);
      }
    }
    Object.assign(record,{lastReceivedAt:now,observedAt:data.observedAt,position:data.position,state:data.state,sequence:data.sequence,watchedSeconds:length(record.wallIntervals)/1000,sourceSeconds:length(record.sourceIntervals)});
    viewer.tracking.previous = {...data}; this.save(record); if (starting) this.prune();
    return {accepted:true,playbackId:record.id,state:record.state,watchedSeconds:record.watchedSeconds};
  }
  history(userId) {
    const ids = this.registry ? this.db.prepare('SELECT id FROM users').all().filter(u=>this.registry.canonical(u.id)?.id===userId).map(u=>u.id) : [userId];
    const records = ids.flatMap(id=>this.db.prepare('SELECT record FROM playback_history WHERE userId=? ORDER BY at DESC').all(id).map(row=>JSON.parse(row.record))).sort((a,b)=>b.lastReceivedAt-a.lastReceivedAt);
    const media = new Map();
    for (const record of records) {
      const item = media.get(record.mediaId) || {mediaId:record.mediaId,wall:[],source:[]};
      item.wall.push(...record.wallIntervals); item.source.push(...record.sourceIntervals); media.set(record.mediaId,item);
    }
    return {retentionDays:90,totals:[...media.values()].map(item=>({mediaId:item.mediaId,watchedSeconds:length(union(item.wall))/1000,sourceSeconds:length(union(item.source))})),sessions:records.slice(0,100).map(({wallIntervals,sourceIntervals,...record})=>record)};
  }
  close() { if (this.owned) this.db.close(); }
}
module.exports = {PlaybackTracking,union};
