'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AV1, PlaybackError, outputSpec } = require('../server/av1');
const { Plex } = require('../server/plex');
const Engine = require('../shared/engine');

test('AV1 derives a bounded source frame clock for CFR film and high frame rate video', () => {
  const spec = rate => outputSpec({streams:[{codec_type:'video',width:640,height:360,r_frame_rate:rate}]},'direct');
  assert.equal(spec('24000/1001').frameRate,'24000/1001');
  assert.equal(spec('60/1').frameRate,'60/1');
  for (const rate of ['0/0','24000/0','1000000/1','-24/1','24;anything']) assert.equal(spec(rate).frameRate,undefined);
  assert.equal(outputSpec({streams:[{codec_type:'video',width:640,height:360,r_frame_rate:'0/0',avg_frame_rate:'25/1'}]},'direct').frameRate,'25/1');
  assert.doesNotMatch(spec('60/1').filter,/(^|,)fps=/);
});

test('a failed speculative AV1 chunk stays bounded without poisoning other chunks', async () => {
  const calls = new Map();
  const manager = new AV1({}, {ffmpegPath:'fixture'},async (binary,args) => {
    if (args.includes('-show_entries')) return Buffer.from(JSON.stringify({streams:[{codec_type:'video',width:640,height:360,r_frame_rate:'60/1'},{codec_type:'audio'}]}));
    if (args.includes('-ss')) {
      const start = args[args.indexOf('-ss')+1]; calls.set(start,(calls.get(start)||0)+1);
      if (start === '18') throw new PlaybackError('No video in final fractional tail');
    }
    return args.includes('pipe:3') ? {video:Buffer.alloc(200),audio:Buffer.alloc(50)} : Buffer.alloc(200);
  });
  const lease = manager.acquire({id:'1',duration:18.018,start:'http://fixture'},'direct'), signal = new AbortController().signal;
  try {
    const current = await manager.chunk(lease,2,signal);
    await assert.rejects(manager.chunk(lease,3,signal),/fractional tail/);
    await assert.rejects(manager.chunk(lease,3,signal),/fractional tail/);
    assert.equal(calls.get('18'),1);
    assert.equal(await manager.chunk(lease,2,signal),current,'buffered current chunk survives');
    assert.ok((await manager.chunk(lease,0,signal)).video.length,'seek back can still encode another chunk');
  } finally { manager.release(lease); await manager.close(); }
});

test('AV1 retries an isolated failed chunk after cooldown without losing good cached chunks',async () => {
  let unavailable = true, encodes = 0;
  const manager = new AV1({}, {ffmpegPath:'fixture'},async (_binary,args) => {
    if (args.includes('-show_entries')) return Buffer.from(JSON.stringify({streams:[{codec_type:'video',width:640,height:360,r_frame_rate:'24/1'},{codec_type:'audio'}]}));
    if (args.includes('-ss')) { encodes++; if (unavailable) throw new PlaybackError('Temporary source failure'); }
    return args.includes('pipe:3') ? {video:Buffer.alloc(200),audio:Buffer.alloc(50)} : Buffer.alloc(200);
  });
  const lease = manager.acquire({id:'1',duration:90,start:'http://fixture'},'direct'), signal = new AbortController().signal;
  try {
    await assert.rejects(manager.chunk(lease,4,signal),/Temporary/);
    unavailable = false;
    await assert.rejects(manager.chunk(lease,4,signal),/Temporary/); assert.equal(encodes,1);
    lease.group.chunks.get(4).failedAt -= 5001;
    const recovered = await manager.chunk(lease,4,signal); assert.ok(recovered.video.length); assert.equal(encodes,2);
    assert.equal(await manager.chunk(lease,4,signal),recovered); assert.equal(encodes,2);
  } finally { manager.release(lease); await manager.close(); }
});

test('quality tiers respect source bitrate/resolution; AV1 clamps Original and tonemaps PQ/HLG', () => {
  const plex = new Plex({});
  assert.deepEqual(plex.qualities({source:{duration:60000,Media:[{height:1080,bitrate:13000,Part:[{key:"/library/parts/1/file"}]}]}}).map(q => q.id), ['direct','1080p12','1080p8','720p4','720p2']);
  assert.deepEqual(plex.qualities({source:{duration:60000,Media:[{height:720,bitrate:1500,Part:[{key:"/library/parts/1/file"}]}]}}).map(q => q.id), ['direct']);
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

test('AV1 isolates source audio and Plex scopes, maps the exact stream and refuses a missing choice',async()=>{
  const maps=[];
  const manager=new AV1({}, {ffmpegPath:'fixture'},async(_binary,args)=>{
    if(args.includes('-show_entries'))return Buffer.from(JSON.stringify({streams:[
      {index:0,codec_type:'video',width:640,height:360},{index:2,codec_type:'audio'},{index:4,codec_type:'audio'}]}));
    if(args.includes('-ss'))maps.push(args.filter((_,i)=>args[i-1]==='-map'));
    return args.includes('pipe:3') ? {video:Buffer.alloc(200),audio:Buffer.alloc(50)} : Buffer.alloc(200);
  });
  const source={id:'1',partId:'5',principal:'first',audioIndex:2,audioOrdinal:0,duration:60,start:'http://fixture'};
  const a=manager.acquire(source,'direct'), b=manager.acquire({...source,audioIndex:4,audioOrdinal:1},'direct'), c=manager.acquire({...source,principal:'second'},'direct');
  const missing=manager.acquire({...source,audioIndex:9},'direct'), signal=new AbortController().signal;
  try {
    assert.notEqual(a.group,b.group);assert.notEqual(a.group,c.group);
    await manager.chunk(b,0,signal);assert.deepEqual(maps,[['0:v:0','0:4']]);
    await assert.rejects(manager.chunk(missing,0,signal),/selected audio track/);assert.equal(maps.length,1);
  } finally {for(const lease of [a,b,c,missing])manager.release(lease);await manager.close();}
});

test('AV1 room outputs share across principals and each new chunk uses its requesting lease source',async()=>{
  let encodes=0;const inputs=[];
  const manager=new AV1({}, {ffmpegPath:'fixture'},async(_binary,args)=>{
    if(args.includes('-show_entries'))return Buffer.from(JSON.stringify({streams:[{index:0,codec_type:'video',width:640,height:360},{index:2,codec_type:'audio'}]}));
    if(args.includes('-ss'))encodes++;
    return args.includes('pipe:3')?{video:Buffer.alloc(200),audio:Buffer.alloc(50)}:Buffer.alloc(200);
  });
  manager.input=async(source,_signal,action)=>{inputs.push(source.principal);return action('http://fixture');};
  const source={id:'1',partId:'5',sourceKey:'same-authorized-file',shareKey:['room','generation'],principal:'alice',duration:60,audioIndex:2,audioOrdinal:0};
  const a=manager.acquire(source,'720p4'),b=manager.acquire({...source,principal:'bob'},'720p4');
  const otherRoom=manager.acquire({...source,shareKey:['other-room','generation']},'720p4');
  const otherSource=manager.acquire({...source,sourceKey:'another-file'},'720p4');
  const otherAudio=manager.acquire({...source,audioIndex:4},'720p4');
  const signal=new AbortController().signal;
  try{
    assert.equal(a.group,b.group);for(const lease of[otherRoom,otherSource,otherAudio])assert.notEqual(lease.group,a.group);
    const [first,second]=await Promise.all([manager.chunk(a,0,signal),manager.chunk(b,0,signal)]);
    assert.equal(first,second);assert.equal(encodes,1);assert.deepEqual(inputs,['alice'],'later acquisition cannot switch the first requesting lease credential');
    manager.release(a);await manager.chunk(b,1,signal);assert.deepEqual(inputs,['alice','bob']);assert.equal(encodes,2);
  }finally{for(const lease of[a,b,otherRoom,otherSource,otherAudio])manager.release(lease);await manager.close();}
});

test('AV1 fails closed on encoder errors, bounds chunk offsets, and cancels disconnected work', async () => {
  assert.throws(() => new AV1({},{}).acquire({id:'1'},'direct'), /tools.ffmpeg/);
  let calls=0;
  const manager = new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder:'qsv',cpuFallback:false}}, async () => { calls++; throw new PlaybackError('Hardware unavailable'); });
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

test('a fresh AV1 request can replace a cancelled chunk before its encoder settles',async()=>{
  let encodes=0, started, settleFirst;
  const firstStarted=new Promise(resolve=>started=resolve);
  const manager=new AV1({}, {ffmpegPath:'fixture'},async(_binary,args,signal)=>{
    if(args.includes('-show_entries'))return Buffer.from(JSON.stringify({streams:[{codec_type:'video',width:640,height:360},{codec_type:'audio'}]}));
    if(args.includes('-ss')){
      if(++encodes===1){
        started();
        return new Promise(resolve=>signal.addEventListener('abort',()=>{settleFirst=()=>resolve({video:Buffer.alloc(300),audio:Buffer.alloc(50)});},{once:true}));
      }
      return {video:Buffer.alloc(200),audio:Buffer.alloc(50)};
    }
    return Buffer.alloc(200);
  });
  const lease=manager.acquire({id:'1',duration:60,start:'http://fixture'},'direct'), cancelled=new AbortController();
  try {
    const old=manager.chunk(lease,0,cancelled.signal);
    await firstStarted;cancelled.abort();
    await assert.rejects(old,/disconnected/);
    assert.equal(typeof settleFirst,'function');
    const fresh=manager.chunk(lease,0,new AbortController().signal);
    settleFirst();
    const bytes=await fresh;
    assert.equal(encodes,2);
    assert.equal(lease.group.chunks.get(0)?.bytes,bytes,'late cancellation cannot delete the replacement cache entry');
    assert.equal(lease.group.bytes,250,'cancelled output is not added to the cache budget');
  } finally {settleFirst?.();manager.release(lease);await manager.close();}
});
test('AV1 retries the hardware probe after an initial transient failure',async () => {
  let probes=0;
  const manager=new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder:'qsv',cpuFallback:false}},async (_binary,args) => {
    if (args.includes('testsrc2=size=320x180:rate=30')) {
      if (++probes === 1) throw new PlaybackError('Temporary probe failure');
      return Buffer.alloc(200);
    }
    if (args.includes('-show_entries')) return Buffer.from(JSON.stringify({streams:[{index:0,codec_type:'video',width:640,height:360}]}));
    return args.includes('pipe:3') ? {video:Buffer.alloc(200),audio:Buffer.alloc(50)} : Buffer.alloc(200);
  });
  const lease=manager.acquire({id:'1',duration:60,start:'http://fixture'},'direct');
  try {
    await assert.rejects(manager.chunk(lease,0,new AbortController().signal),/Temporary probe failure/);
    lease.group.chunks.get(0).failedAt -= 5001; // Simulate the existing chunk-error cooldown.
    const chunk=await manager.chunk(lease,0,new AbortController().signal);
    assert.ok(chunk.video.length); assert.equal(probes,2);
  } finally {manager.release(lease);await manager.close();}
});
