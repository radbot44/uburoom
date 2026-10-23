'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {syncQualityParticipants}=require('../server/watch');
const {WatchRooms}=require('../server/watch-rooms');

function measurement({status='playing',score,lastKnownScore=score,lastKnownLevel,updatedAt=100000,lastKnownAt=updatedAt,
  mediaVersion='media-current',streamVersion='stream-current',deviceLabel='Chrome · Windows',reason}={}) {
  return {status,score,lastKnownScore,lastKnownLevel:lastKnownLevel||(Number.isFinite(lastKnownScore)?require('../web/sync-quality').level(lastKnownScore):undefined),
    updatedAt,lastKnownAt,mediaVersion,streamVersion,deviceLabel,reason};
}
function viewer(userId,quality,joinedAt=0,readyState=1,streamVersion='stream-current') {
  return {userId,streamVersion,joinedAt,watchSocket:{readyState},syncQuality:quality};
}

test('participant aggregate selects the worst active device and exposes every session',()=>{
  const now=100000,room={mediaVersion:'media-current',viewers:new Map([
    ['chrome',viewer('account',measurement({score:.96,deviceLabel:'Chrome · Windows'}),1)],
    ['android',viewer('account',measurement({score:.72,deviceLabel:'Chrome · Android'}),2)],
    ['paused',viewer('account',measurement({status:'paused',score:undefined,lastKnownScore:.99,lastKnownLevel:'excellent',deviceLabel:'Firefox · Android'}),3)]
  ])};
  const people=[{id:'account'}];syncQualityParticipants(room,people,now);
  const aggregate=people[0].syncQuality;
  assert.equal(aggregate.status,'known');assert.equal(aggregate.score,.72);assert.equal(aggregate.level,'fair');
  assert.equal(aggregate.sessions.length,3);
  assert.deepEqual(aggregate.sessions.filter(row=>Number.isFinite(row.score)).map(row=>row.score),[.96,.72]);
  assert.equal(aggregate.sessions[2].status,'paused');assert.equal(aggregate.sessions[2].lastKnownLevel,'excellent');
});

test('unknown, stale and disconnected sessions retain their last level without overriding active playback',()=>{
  const now=100000,room={mediaVersion:'media-current',viewers:new Map([
    ['playing',viewer('account',measurement({score:.91,deviceLabel:'Firefox · Linux'}),1)],
    ['stale',viewer('account',measurement({score:.2,lastKnownScore:.2,lastKnownLevel:'poor',updatedAt:now-16000,deviceLabel:'Chrome · Windows'}),2)],
    ['disconnected',viewer('account',measurement({score:.99,lastKnownScore:.99,lastKnownLevel:'excellent',deviceLabel:'Safari · macOS'}),3,3)],
    ['paused-only',viewer('paused-account',measurement({status:'paused',score:undefined,lastKnownScore:.78,lastKnownLevel:'good'}),4)]
  ])};
  const people=[{id:'account'},{id:'paused-account'},{id:'no-sessions'}];syncQualityParticipants(room,people,now);
  assert.equal(people[0].syncQuality.score,.91,'stale and disconnected devices cannot override an active score');
  const rows=people[0].syncQuality.sessions;
  assert.equal(rows.find(row=>row.device==='Chrome · Windows').status,'stale');
  assert.equal(rows.find(row=>row.device==='Chrome · Windows').lastKnownLevel,'poor');
  assert.equal(rows.find(row=>row.device==='Safari · macOS').status,'disconnected');
  assert.equal(people[1].syncQuality.status,'unknown');assert.equal(people[1].syncQuality.reason,'paused');
  assert.equal(people[1].syncQuality.lastKnownLevel,'good');
  assert.equal(people[2].syncQuality.status,'unknown');assert.equal(people[2].syncQuality.reason,'no-sessions');
});

test('disconnected grace sessions remain visible and old media scores are stale, never current',()=>{
  const now=100000,room={mediaVersion:'media-current',viewers:new Map([
    ['old-stream',viewer('account',measurement({score:.97,mediaVersion:'old-media'}),1)]
  ]),disconnectedViewers:new Map([
    ['lost-tab',{userId:'account',mediaVersion:'media-current',streamVersion:'stream-current',expires:now+30000,joinedAt:2,
      syncQuality:measurement({status:'disconnected',score:undefined,lastKnownScore:.8,lastKnownLevel:'good',deviceLabel:'Firefox · Linux'})}]
  ])};
  const people=[{id:'account'}];syncQualityParticipants(room,people,now);
  assert.equal(people[0].syncQuality.status,'unknown');assert.equal(people[0].syncQuality.reason,'stale');
  assert.ok(people[0].syncQuality.sessions.some(row=>row.status==='stale'&&row.lastKnownLevel==='excellent'));
  assert.ok(people[0].syncQuality.sessions.some(row=>row.status==='disconnected'&&row.lastKnownLevel==='good'));
  assert.equal(room.viewers.get('old-stream').syncQuality.score,.97,'invalid context is not rewritten or misrepresented as current');
});

test('Room participants include disconnected sessions during reconnect grace but exclude expired sessions',()=>{
  const now=Date.now(),room={viewers:new Map(),disconnectedViewers:new Map([
    ['recent',{userId:'offline',expires:now+10000}],['expired',{userId:'gone',expires:now-1}]
  ])};
  const fake={store:{get:()=>({creatorId:'owner',hosts:[],permissions:{}})},watch:{rooms:new Map([['room',room]])},
    registry:{canonical:id=>({name:id})}};
  const people=WatchRooms.prototype.participants.call(fake,'room');
  assert.deepEqual(people.map(person=>person.id),['owner','offline']);
  assert.equal(people[1].present,false);
});

test('automatic hard corrections are observed, while startup and intentional shared seeks are excluded',async()=>{
  const {createSync}=await import('../web/watch-sync.mjs');
  async function scenario({eligible=true,suppress=false}={}) {
    const corrections=[],state={mediaUrl:'fixture',mediaVersion:'media',streamVersion:'stream',startAt:0,serverNow:10000,state:{duration:100,paused:false,volume:50,muted:false},format:'hls'};
    const video={readyState:4,paused:false,seeking:false,ended:false,currentTime:0,playbackRate:1,volume:0,muted:false,duration:100,buffered:{length:0},
      pause(){this.paused=true;},async play(){this.paused=false;}};
    const idleCorrection={reset(){},interrupt(){},update(){return false;},committed(){}};
    const sync=createSync({video,read:()=>({state,selected:'room',mediaSource:'fixture',receivedAt:0,probing:false,playbackError:'',playerWaiting:false,
      autoplayBlocked:false,readyVersion:eligible?'media':undefined,syncCorrectionMode:'speed',precisionCorrectionEnabled:false,gentleCorrectionEnabled:false}),
      timing:{correction:()=>idleCorrection,precisionCorrection:()=>idleCorrection,jumpCorrection:()=>idleCorrection,alarm:()=>({cancel(){},arm(){}})},
      playback:{bufferedAhead:()=>10},clock:{read:()=>({valid:true,serverTime:10000,clockUncertaintyMs:5})},presentation:{cadence:()=>.04},
      expected:()=>10,decodedFrames:()=>1,unlockLocal:async()=>{},reportReadiness:async()=>{},render(){},checkFrames(){},sample(){},error(){},playing(){},
      correction:event=>corrections.push(event),correctionEligible:()=>eligible,visibility:()=> 'visible',online:()=>true,repeat:()=>1,cancelRepeat(){},now:()=>10000});
    if(suppress)sync.sharedSeek();
    await sync.synchronize();sync.close();return {corrections,currentTime:video.currentTime};
  }
  const regular=await scenario();assert.equal(regular.currentTime,10);assert.equal(regular.corrections.length,1);assert.equal(regular.corrections[0].magnitudeMs,10000);
  assert.equal((await scenario({eligible:false})).corrections.length,0,'startup settling is not counted');
  assert.equal((await scenario({suppress:true})).corrections.length,0,'intentional shared seek is not counted');
});
