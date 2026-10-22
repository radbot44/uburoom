'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {syncQualityParticipants}=require('../server/watch');

test('room snapshots expose only the freshest valid score for the matching active participant',()=>{
  const now=100000,mediaVersion='media-current',streamVersion='stream-current';
  const active=(userId,score,at,stream=streamVersion,readyState=1,measurementStream=stream)=>({userId,streamVersion:stream,watchSocket:{readyState},
    syncQuality:{score,at,mediaVersion,streamVersion:measurementStream}});
  const room={mediaVersion,viewers:new Map([['old',active('account',.6,now-4000)],['new',active('account',.91,now-2000)],
    ['stale',active('expired',.9,now-16000)],['wrong-stream',active('stream-mismatch',1,now,streamVersion,1,'old-stream')],['closed',active('offline',1,now,streamVersion,3)]])};
  const people=[{id:'account'},{id:'expired'},{id:'stream-mismatch'},{id:'offline'},{id:'pending',pending:true,present:false}];
  assert.equal(syncQualityParticipants(room,people,now),people);
  assert.equal(people[0].syncQuality,.91);
  assert.equal(people[1].syncQuality,undefined);assert.equal(people[2].syncQuality,undefined);assert.equal(people[3].syncQuality,undefined);
  assert.equal(people[4].syncQuality,undefined);
  assert.equal(room.viewers.get('stale').syncQuality,undefined);assert.equal(room.viewers.get('wrong-stream').syncQuality,undefined);
});
