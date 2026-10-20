'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../web/playback-policy');
const timeRanges = entries => ({length:entries.length,start:i=>entries[i][0],end:i=>entries[i][1]});
test('shared buffer window clamps start/end and bounds authorized ahead/rewind',() => {
  assert.deepEqual(p.chunkWindow(0,180),{first:0,last:10});
  assert.deepEqual(p.chunkWindow(120,180),{first:15,last:29});
  assert.deepEqual(p.chunkWindow(999,18),{first:0,last:2});
  assert.equal(require('../server/av1').CHUNK,p.BUFFER.chunkSeconds);
});
test('HLS uses explicit time limits and reduces high-bitrate buffering toward the byte target',() => {
  const normal = p.hlsConfig(4000), high = p.hlsConfig(24000);
  assert.equal(normal.maxBufferLength,30); assert.equal(normal.backBufferLength,30);
  assert.equal(normal.maxMaxBufferLength,180);
  assert.equal(high.maxBufferLength,30); assert.equal(high.backBufferLength,30);
  assert.equal(high.maxMaxBufferLength,180);
  assert.equal(normal.maxBufferSize,256 * 1024 * 1024);
  assert.equal(p.hlsConfig(NaN).maxBufferLength,30);
  assert.equal(normal.startPosition,0,'every stream establishes its timestamp origin at the beginning');
});
test('buffer display preserves holes and clamps values without including external text',() => {
  const ranges = timeRanges([[-1,10],[20,35],[80,Infinity]]);
  assert.deepEqual(p.ranges(ranges,30),[[0,10],[20,30]]);
  assert.equal(p.bufferedAhead(ranges,8),2); assert.equal(p.bufferedAhead(ranges,15),0);
  const fill = p.timeline(timeRanges([[0,10],[20,30]]),30,40);
  assert.match(fill,/100\.000%/); assert.match(fill,/33\.333%/); assert.match(fill,/66\.667%/);
  assert.equal(p.timeline(ranges,Infinity,2),'var(--border)');
});
test('capability negatives choose conversion; HEVC Main10 hints and unknown codecs still get a playback trial',() => {
  const none = () => '';
  assert.equal(p.needsCompatible({videoCodec:'hevc'},none),true);
  assert.equal(p.needsCompatible({videoCodec:'hevc'},type=>type.includes('hvc1.2.') ? 'probably' : ''),false);
  assert.equal(p.needsCompatible({videoCodec:'h264',audioCodec:'ac3'},none),true);
  assert.equal(p.needsCompatible({videoCodec:'unknown',audioCodec:'unknown'},none),false);
  assert.equal(p.needsCompatible({videoCodec:'hevc'},()=>{throw new Error('unavailable');}),false);
});


test('startup and seek-to-zero readiness accepts bounded mux offsets without accepting missing buffer',()=>{
  const offset=timeRanges([[.083422,18.024749]]);
  assert.equal(p.bufferedAhead(offset,0),0,'ordinary gap detection stays strict');
  assert.equal(p.readinessBuffered(offset,0,120),true);
  assert.equal(p.readinessBuffered(timeRanges([[0,3]]),0,120),true);
  assert.equal(p.readinessBuffered(timeRanges([]),0,120),false);
  assert.equal(p.readinessBuffered(timeRanges([[.083422,1]]),0,120),false);
  assert.equal(p.readinessBuffered(timeRanges([[.3,18]]),0,120),false,'large leading holes remain unready');
  assert.equal(p.readinessBuffered(timeRanges([[15.083422,18]]),15,120),false,'middle-of-stream holes remain unready');
  assert.equal(p.readinessBuffered(timeRanges([[0,1],[1.2,18]]),0,120),false,'disjoint ranges do not add up to readiness');
  assert.equal(p.readinessBuffered(timeRanges([[119,120]]),119,120),true,'near the end only the remainder is required');
});
