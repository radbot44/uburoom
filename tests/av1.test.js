'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AV1, PlaybackError, outputSpec } = require('../server/av1');
const { Plex } = require('../server/plex');
const Engine = require('../extension/engine');

test('quality tiers respect source bitrate/resolution; AV1 clamps Original and tonemaps PQ/HLG', () => {
  const plex = new Plex({});
  assert.deepEqual(plex.qualities({source:{Media:[{height:1080,bitrate:13000}]}}).map(q => q.id), ['direct','1080p12','1080p8','720p4','720p2']);
  assert.deepEqual(plex.qualities({source:{Media:[{height:720,bitrate:1500}]}}).map(q => q.id), ['direct']);
  const info = {streams:[{codec_type:'video',width:7680,height:4320,color_transfer:'smpte2084'},{codec_type:'audio'}],format:{bit_rate:'80000000'}};
  const original = outputSpec(info,'direct');
  assert.equal(original.width,3840); assert.equal(original.height,2160); assert.equal(original.bitrate,40000);
  assert.match(original.filter,/tonemap=/); assert.equal(original.audio,true);
  assert.equal(outputSpec(info,'720p2').bitrate,2000);
  assert.doesNotMatch(outputSpec({streams:[{codec_type:'video',width:640,height:360}]},'1080p20').filter,/tonemap/);
  assert.equal(outputSpec({streams:[{codec_type:'video',width:640,height:360}]},'1080p20').width,640);
  assert.equal(Engine.validate({action:'media.quality.set',args:{quality:'720p4',fallback:'av1'}}).args.fallback,'av1');
  assert.throws(() => Engine.validate({action:'media.quality.set',args:{quality:'720p4',fallback:'cpu'}}));
});

test('AV1 shares one encode per source/tier/chunk and releases/cancels its last viewer', async () => {
  let encodes = 0, url;
  const manager = new AV1({}, {ffmpegPath:'fixture'}, async (binary,args) => {
    if (args.includes('-show_entries')) return Buffer.from(JSON.stringify({streams:[{codec_type:'video',width:640,height:360},{codec_type:'audio'}]}));
    if (args.includes('-ss')) { encodes++; url = args[args.indexOf('-i') + 1]; }
    return args.includes('pipe:3') ? {video:Buffer.alloc(200),audio:Buffer.alloc(50)} : Buffer.alloc(200);
  });
  const source = {id:'1',duration:60,start:'http://private-plex/library/parts/1/file?private-token'};
  const a = manager.acquire(source,'720p4'), b = manager.acquire(source,'720p4');
  const signal = new AbortController().signal;
  const [x,y] = await Promise.all([manager.chunk(a,2,signal),manager.chunk(b,2,signal)]);
  assert.equal(x,y); assert.equal(encodes,1); assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/);
  assert.equal(url.includes('private'),false); assert.equal(manager.inputs.size,0);
  manager.release(a); assert.equal(manager.groups.size,1);
  manager.release(b); assert.equal(manager.groups.size,0);
  await assert.rejects(manager.chunk(b,2,signal),/replaced/);
  manager.close();
});

test('AV1 fails closed on encoder errors, bounds chunk offsets, and cancels disconnected work', async () => {
  assert.throws(() => new AV1({},{}).acquire({id:'1'},'direct'), /FFMPEG_PATH/);
  let calls=0;
  const manager = new AV1({}, {ffmpegPath:'fixture'}, async () => { calls++; throw new PlaybackError('Hardware unavailable'); });
  const lease = manager.acquire({id:'1',duration:60},'720p4'), signal = new AbortController().signal;
  await assert.rejects(manager.chunk(lease,0,signal), /Hardware unavailable/);
  await assert.rejects(manager.chunk(lease,0,signal), /Hardware unavailable/);
  assert.equal(calls,1,'a persistent encoder failure does not launch repeated jobs');
  await assert.rejects(manager.chunk(lease,100,signal), /Invalid/);
  manager.close();
  let aborted=false;
  const waiting = new AV1({}, {ffmpegPath:'fixture'}, async (binary,args,signal) => {
    if (!args.includes('-ss')) return args.includes('-show_entries') ? Buffer.from('{"streams":[{"codec_type":"video","width":640,"height":360}]}') : Buffer.alloc(200);
    return new Promise((resolve,reject) => signal.addEventListener('abort', () => { aborted=true; reject(new PlaybackError('Cancelled')); }, {once:true}));
  });
  const active = waiting.acquire({id:'2',duration:60,start:'http://source'},'direct'), client = new AbortController();
  const chunk = waiting.chunk(active,0,client.signal);
  await new Promise(resolve => setTimeout(resolve,50)); client.abort();
  await assert.rejects(chunk,/disconnected/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted,true); waiting.release(active); waiting.close();
});
