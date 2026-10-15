'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, fixturePlex } = require('../scripts/playback-baseline');
const source = {expectedFps:24,expectedAudioHz:440};
function evidence(fps = 24, changes = {}) {
  return {firstFrameMs:100,events:[],samples:Array.from({length:36},(_,i) => ({elapsedMs:1000+i*200,position:i*.2,target:i*.2,
    frames:Math.round(i*.2*fps),dropped:0,paused:false,seeking:false,readyState:4,audioDb:-30,audioHz:439,
    width:640,height:360,pixels:1000,...changes}))};
}
test('baseline requires sustained source cadence, decoded audio and picture rather than play acknowledgement', () => {
  assert.deepEqual(summarize(evidence(),source).errors,[]);
  assert.match(summarize(evidence(30),source).errors.join(),/cadence/);
  assert.match(summarize(evidence(24,{audioDb:null}),source).errors.join(),/audio tone/);
  assert.match(summarize(evidence(24,{audioHz:880}),source).errors.join(),/audio tone/);
  assert.match(summarize(evidence(24,{pixels:0}),source).errors.join(),/picture pixels/);
  assert.match(summarize(evidence(24,{paused:true}),source).errors.join(),/sustained playback/);
  assert.match(summarize(evidence(24,{target:100}),source).errors.join(),/Room drift/);
  const stalled = evidence(); stalled.events.push({event:'waiting',elapsedMs:4000});
  assert.match(summarize(stalled,source).errors.join(),/stalled/);
});
test('baseline fixture never sends requests to real Plex or arbitrary upstream hosts', async () => {
  const fetcher = fixturePlex('unused',{sources:[]});
  await assert.rejects(fetcher('https://example.com/library/metadata/1',{headers:{'X-Plex-Token':'synthetic-playback-only'}}),/Unexpected fixture upstream/);
  await assert.rejects(fetcher('http://playback-fixture.invalid:32400/library/metadata/1',{headers:{'X-Plex-Token':'real-token'}}),/Unexpected fixture upstream/);
  assert.equal((await fetcher('http://playback-fixture.invalid:32400/unknown',{headers:{'X-Plex-Token':'synthetic-playback-only'}})).status,404);
});
