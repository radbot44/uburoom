'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../web/playback-policy');
function playerAt(duration = 180) {
  const context = {window:{},setTimeout:()=>1,clearTimeout:()=>{},AbortController,Date,uburoomPlayback:policy};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/watch-av1.js'),'utf8'),context);
  const player = Object.create(context.window.uburoomAV1.prototype);
  Object.assign(player,{abort:new AbortController(),duration,seconds:6,appended:new Set(),chunkBytes:new Map(),seekVersion:0,
    position:0,target:()=>player.position,buffer:{},audio:{},url:'/fixture/start',requests:[]});
  player.fetch = async url => { player.requests.push(url); return {arrayBuffer:async () => new Uint8Array(1024).buffer}; };
  player.operation = async (_buffer,action) => action();
  for (const buffer of [player.buffer,player.audio]) Object.assign(buffer,{appendBuffer:()=>{},remove:()=>{}});
  return player;
}
test('AV1 fills ahead while paused, retains rewind data, and does not download cached chunks again',async () => {
  const player = playerAt();
  await player.pump();
  assert.deepEqual([...player.appended],Array.from({length:11},(_,i)=>i));
  assert.equal(player.requests.length,22);
  await player.pump(); assert.equal(player.requests.length,22);
  player.position = 48; await player.pump();
  assert.equal(Math.min(...player.appended),3); assert.equal(Math.max(...player.appended),18);
  const requests = player.requests.length;
  player.position = 30; await player.pump();
  assert.equal(player.requests.length,requests,'buffered rewind does not fetch the current chunks again');
  player.position = 150; player.seekVersion++; await player.pump();
  assert.deepEqual([...player.appended],[25,26,27,28,29],'distant seek drops unrelated data and fills the new position');
});
test('AV1 encoded byte budget stops speculation and frees old data as playback advances',async () => {
  const player = playerAt();
  player.fetch = async url => { player.requests.push(url); return {arrayBuffer:async () => ({byteLength:4*1024*1024})}; };
  await player.pump();
  assert.equal(player.retainedBytes,policy.BUFFER.maxBytes);
  assert.equal(player.appended.size,8);
  const requests = player.requests.length; await player.pump(); assert.equal(player.requests.length,requests);
  player.position = 30; await player.pump();
  assert.ok(player.appended.has(5)); assert.ok(player.appended.has(12));
  assert.ok(player.retainedBytes <= policy.BUFFER.maxBytes);
});
test('AV1 look-ahead failure does not stop buffered playback or repeatedly request a failed chunk',async () => {
  const player = playerAt(30);
  let target = 12, requests = 0;
  const failure = new Error('Missing speculative chunk');
  Object.assign(player,{abort:new AbortController(),duration:30,seconds:6,appended:new Set([2]),target:()=>target,
    fetch:async () => { requests++; throw failure; }});
  await player.pump(); assert.equal(player.prefetchFailure.error,failure);
  const firstRequests = requests;
  await player.pump(); assert.equal(requests,firstRequests,'failed prefetch is not retried every timer tick');
  target = 18;
  await assert.rejects(player.pump(),error => error === failure,'error becomes terminal when the chunk is actually needed');
});
test('a seek supersedes a failing AV1 fetch at the previous position',async () => {
  const player = playerAt(60);
  let target = 0;
  Object.assign(player,{abort:new AbortController(),duration:60,seconds:6,appended:new Set(),target:()=>target,
    fetch:async () => { target = 24; throw new Error('Old position failed'); }});
  await player.pump();
  assert.equal(player.prefetchFailure.index,0,'the old failure must not stop playback at the new position');
});
test('a seek during AV1 window eviction does not fetch chunks at the old position',async () => {
  const player = playerAt();
  player.position = 120; player.appended.add(0); player.chunkBytes.set(0,1024);
  player.evict = async indices => {
    for (const index of indices) { player.appended.delete(index); player.chunkBytes.delete(index); }
    if (indices.length) { player.position = 0; player.seekVersion++; }
  };
  await player.pump();
  assert.equal(player.requests.length,0,'obsolete work stops before the old-position fetch');
  await player.pump();
  assert.ok(player.appended.has(0),'the next pump fills the new position');
});
test('a seek during AV1 byte-budget eviction cannot append a stale chunk',async () => {
  const player = playerAt(60);
  let checks = 0;
  player.makeSpace = async () => {
    if (++checks === 1) { player.position = 24; player.seekVersion++; }
    return true;
  };
  await player.pump();
  assert.deepEqual([...player.appended],[],'old bytes may arrive but cannot enter MediaSource');
  await player.pump();
  assert.ok(player.appended.has(4),'the new source-time chunk is appended on the next pump');
});
test('temporary AV1 network failure retries with backoff without clearing good chunks',async () => {
  const player = playerAt(30), original = player.fetch;
  const error = Object.assign(new Error('Temporary outage'),{retryable:true});
  player.fetch = async () => { throw error; };
  await player.pump(); assert.equal(player.prefetchFailure.attempts,1);
  await player.pump(); assert.equal(player.prefetchFailure.attempts,1,'backoff prevents a tight request loop');
  player.prefetchFailure.retryAt = 0; player.fetch = original;
  await player.pump(); assert.ok(player.appended.has(0)); assert.equal(player.prefetchFailure,undefined);
});
test('quota pressure removes partial track data and reduces speculative look-ahead',async () => {
  const player = playerAt(); let count = 0;
  player.buffer.appendBuffer = () => { if (++count === 3) throw Object.assign(new Error('Full'),{name:'QuotaExceededError'}); };
  await player.pump();
  assert.deepEqual([...player.appended],[0,1]);
  assert.equal(player.pressured,true); assert.equal(player.pressureAhead,6);
});
test('AV1 retries an exhausted speculative network failure when playback actually reaches that chunk',async () => {
  const player = playerAt(90), error = Object.assign(new Error('Temporary outage'),{retryable:true});
  player.position = 30;
  player.prefetchFailure = {index:5,error,attempts:6,required:false,retryAt:Infinity};
  await player.pump();
  assert.ok(player.appended.has(5)); assert.equal(player.prefetchFailure,undefined);
});
test('AV1 signals natural EOF only when the final chunk is needed, and only once',async () => {
  const player = playerAt(20.602);
  player.source = {readyState:'open',ends:0,endOfStream(){this.ends++;this.readyState='ended';}};
  await player.pump();
  assert.ok(player.appended.has(3),'prefetch may fetch the last chunk early');
  assert.equal(player.source.ends,0,'prefetch must not end the stream early');
  player.position = 18;
  await player.pump();
  assert.equal(player.source.ends,1);
  await player.pump();
  assert.equal(player.source.ends,1,'polling does not signal EOF repeatedly');
  // A rewind reopens MediaSource during removal in actual browsers.
  player.position = 0;
  player.appended.delete(0); player.chunkBytes.delete(0); // Force a missing earlier chunk.
  player.operation = async (_buffer,action) => { action(); player.source.readyState='open'; };
  await player.pump();
  player.position = 18;
  await player.pump();
  assert.equal(player.source.ends,2,'the same movie can end again after rewind');
});

test('AV1 does not signal EOF when the required final chunk fails',async () => {
  const player = playerAt(18), failure = Object.assign(new Error('Temporary error'),{retryable:true});
  player.source = {readyState:'open',ends:0,endOfStream(){this.ends++;}};
  player.position = 18;
  player.fetch = async () => {throw failure;};
  await player.pump();
  assert.equal(player.source.ends,0);
});
