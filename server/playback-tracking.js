'use strict';
const { randomUUID } = require('node:crypto');
const STATES = new Set(['playing','paused','buffering','seeking','ended','error','blocked']);
const GAP = 5000, MAX_INTERVALS = 2048;
class ObservationError extends Error {
  constructor(rejection) { super('Invalid or stale playback observation'); this.rejection=rejection; }
}
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
    for (const row of this.db.prepare("SELECT * FROM playback_history WHERE json_extract(record,'$.endedAt') IS NULL").all()) {
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
    const rejection=!viewer.media?'media-unavailable':viewer.mediaVersion!==room.mediaVersion || data.mediaVersion!==room.mediaVersion?'media-changed':
      data.streamVersion!==viewer.streamVersion?'stream-changed':data.observationEpoch!==viewer.observationEpoch?'epoch-changed':
      !Number.isSafeInteger(data.discontinuity)||data.discontinuity<0?'invalid-discontinuity':!STATES.has(data.state)?'invalid-state':
      !Number.isSafeInteger(data.sequence)||data.sequence<0?'invalid-sequence':data.sequence<=(viewer.observationSequence??-1)?'sequence-replayed':
      !Number.isFinite(data.sampleAt)||data.sampleAt<0?'invalid-sample':data.sampleAt<=(viewer.observationSample??-1)?'sample-replayed':
      !Number.isFinite(data.observedAt)?'invalid-clock':now-data.observedAt>3000?'sample-stale':data.observedAt-now>1000?'sample-future':
      !Number.isFinite(data.position)||data.position<0||data.position>room.media.duration+.5?'invalid-position':
      !Number.isFinite(data.rate)||data.rate<.25||data.rate>4?'invalid-rate':!Number.isSafeInteger(data.frames)||data.frames<0?'invalid-frames':undefined;
    if(rejection)throw new ObservationError(rejection);
    this.expire(viewer);
    if (data.observationEpoch !== viewer.observationEpoch) throw new ObservationError('observation-timeout');
    viewer.observationSequence = data.sequence; viewer.observationSample = data.sampleAt;
    const starting = !viewer.tracking;
    if (starting) {
      const identities = this.registry?.identities(viewer.userId).map(i=>({provider:i.provider,subject:i.subject})) || [];
      viewer.tracking = { record: { id:randomUUID(),userId:viewer.userId,identities,roomId:room.s.roomId,viewerId,mediaId:room.media.id,duration:room.media.duration,mediaVersion:room.mediaVersion,streamVersion:viewer.streamVersion,
        deliveryMode:viewer.media.kind==='demo'?'local-fixture':({file:'original',hls:'plex-hls',av1:'uburoom-av1'}[viewer.media.format] || 'unknown'),startedAt:now,lastReceivedAt:now,watchedSeconds:0,sourceSeconds:0,wallIntervals:[],sourceIntervals:[] } };
    }
    const {record,previous} = viewer.tracking;
    const credit={reason:'baseline',creditedSeconds:0};
    if (previous) {
      const elapsed = (data.sampleAt-previous.sampleAt)/1000, received = (now-record.lastReceivedAt)/1000, advanced = data.position-previous.position;
      const clockDelta=(data.observedAt-previous.observedAt)/1000-elapsed;
      credit.reason=previous.state!=='playing'||data.state!=='playing'?'not-playing':previous.discontinuity!==data.discontinuity?'discontinuity':
        data.frames<=previous.frames?'frames-not-advancing':!(elapsed>0&&elapsed<=GAP/1000)?'sample-gap':!(received>0&&received<=GAP/1000)?'receive-gap':
        Math.abs(received-elapsed)>=1?'delivery-jitter':Math.abs(clockDelta)>=.25?'clock-discontinuity':
        !(advanced>0)||Math.abs(advanced-elapsed*(previous.rate+data.rate)/2)>=.25?'position-discontinuity':
        record.wallIntervals.length>=MAX_INTERVALS||record.sourceIntervals.length>=MAX_INTERVALS?'interval-limit':'credited';
      // Only bounded scalar deltas leave the server; no request echo or IDs.
      for(const [key,value] of Object.entries({elapsedMs:elapsed*1000,receivedMs:received*1000,clockDeltaMs:clockDelta*1000,positionDelta:advanced,frameDelta:data.frames-previous.frames}))
        if(Number.isFinite(value)&&Math.abs(value)<=1e9)credit[key]=Math.round(value*1000)/1000;
      // Both boundaries must describe decoded playback. No tail extrapolation,
      // seek credit, room-clock credit or credit across a missing heartbeat.
      if (credit.reason==='credited') {
        // Network jitter must not manufacture thousands of tiny source gaps.
        // These are the two validated observation boundaries, not projections.
        record.wallIntervals = union([...record.wallIntervals,[previous.observedAt,data.observedAt]]);
        record.sourceIntervals = union([...record.sourceIntervals,[previous.position,data.position]]);
        credit.creditedSeconds=length(record.wallIntervals)/1000-record.watchedSeconds;
      }
    }
    Object.assign(record,{lastReceivedAt:now,observedAt:data.observedAt,position:data.position,state:data.state,sequence:data.sequence,watchedSeconds:length(record.wallIntervals)/1000,sourceSeconds:length(record.sourceIntervals)});
    viewer.tracking.previous = {...data}; this.save(record); if (starting) this.prune();
    return {accepted:true,playbackId:record.id,state:record.state,watchedSeconds:record.watchedSeconds,credit};
  }
  history(userId) {
    const canonicalId = this.registry ? this.registry.canonical(userId)?.id : userId;
    if (this.registry && !canonicalId) return {retentionDays:90,totals:[],sessions:[]};
    const ids = this.registry ? this.db.prepare("WITH RECURSIVE merged(id) AS (SELECT ? UNION SELECT u.id FROM users u JOIN merged m ON u.retiredInto=m.id) SELECT id FROM merged").all(canonicalId).map(u=>u.id) : [userId];
    if (ids.length === 0) return {retentionDays:90,totals:[],sessions:[]};
    const placeholders = ids.map(() => '?').join(',');
    const records = this.db.prepare(`SELECT record FROM playback_history WHERE userId IN (${placeholders}) ORDER BY at DESC`).all(...ids).map(row=>JSON.parse(row.record)).sort((a,b)=>b.lastReceivedAt-a.lastReceivedAt);
    const media = new Map();
    for (const record of records) {
      const item = media.get(record.mediaId) || {mediaId:record.mediaId,wall:[],source:[]};
      item.wall.push(...record.wallIntervals); item.source.push(...record.sourceIntervals); media.set(record.mediaId,item);
    }
    return {retentionDays:90,totals:[...media.values()].map(item=>({mediaId:item.mediaId,watchedSeconds:length(union(item.wall))/1000,sourceSeconds:length(union(item.source))})),sessions:records.slice(0,100).map(({wallIntervals,sourceIntervals,...record})=>record)};
  }
  close() { if (this.owned) this.db.close(); }
}
module.exports = {PlaybackTracking,union,ObservationError};
