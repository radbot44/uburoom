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
  assert.equal(normal.maxBufferLength,60); assert.equal(normal.backBufferLength,30);
  assert.equal(high.maxBufferLength,14); assert.equal(high.backBufferLength,7);
  assert.equal(normal.maxMaxBufferLength,normal.maxBufferLength);
  assert.equal(p.hlsConfig(NaN).maxBufferLength,60);
  assert.equal(p.hlsConfig(4000,65.25).startPosition,65.25);
  for(const position of[-5,NaN,Infinity,undefined])assert.equal(p.hlsConfig(4000,position).startPosition,0);
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
