'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeConfig}=require('../server/config');
const {AV1,PlaybackError,encoderArgs}=require('../server/av1');
const {ConversionPolicy}=require('../server/transcoding-policy');
const {Plex}=require('../server/plex');
const Playback=require('../web/playback-policy');
const Engine=require('../shared/engine');
const {accountFixture}=require('../scripts/account-fixture');

test('local codec configuration and fallback commands are ordered, bounded allowlists',()=>{
  assert.deepEqual(normalizeConfig({transcoding:{formats:['vp9','vp8','av1']}}).transcoding.formats,['vp9','vp8','av1']);
  assert.deepEqual(normalizeConfig({}).transcoding.formats,['av1']);
  for(const formats of [['h264'],['vp9','vp9'],['__proto__'],'vp8'])assert.throws(()=>normalizeConfig({transcoding:{formats}}));
  for(const codec of ['av1','vp9','vp8'])assert.equal(Engine.validate({action:'media.quality.set',args:{quality:'direct',fallback:codec}}).args.fallback,codec);
  assert.throws(()=>Engine.validate({action:'media.quality.set',args:{quality:'direct',fallback:'__proto__'}}));
  assert.deepEqual(Playback.fallbackCodecs(['vp9','vp8','av1'],new Set(['vp9']),mime=>!mime.includes('av01')),['vp8']);
  assert.equal(encoderArgs('software','vp8')[1],'libvpx');assert.equal(encoderArgs('software','vp9')[1],'libvpx-vp9');
  assert.equal(encoderArgs('qsv','vp9')[1],'vp9_qsv');assert.throws(()=>encoderArgs('nvenc','vp9'),/NVENC/);
});

test('encoder probes are isolated by codec and unsupported NVENC obeys CPU fallback',async()=>{
  const calls=[],manager=new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder:'nvenc',cpuFallback:true}},async(_file,args)=>{calls.push(args[args.indexOf('-c:v')+1]);return Buffer.alloc(200);});
  try{
    assert.equal(await manager.selectEncoder('av1'),'nvenc');assert.equal(await manager.selectEncoder('vp9'),'software');assert.equal(await manager.selectEncoder('vp8'),'software');
    await manager.selectEncoder('vp9');assert.deepEqual(calls,['av1_nvenc','libvpx-vp9','libvpx']);
  }finally{await manager.close();}
  const strict=new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder:'nvenc',cpuFallback:false}},async()=>{throw new Error('Must not invoke unsupported encoder');});
  try{await assert.rejects(strict.selectEncoder('vp9'),/NVENC/);await assert.rejects(strict.selectEncoder('vp8'),/NVENC/);}finally{await strict.close();}
});

test('VP8 and VP9 chunks share only identical codec/source/quality/audio and preserve global accounting',async()=>{
  const encodes=[],policy=new ConversionPolicy({policy:'override',uburoom:true,formats:['vp8','vp9'],maxJobs:1},{});
  const manager=new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder:'software'}},async(_file,args)=>{
    if(args.includes('-show_entries'))return Buffer.from(JSON.stringify({streams:[{index:0,codec_type:'video',width:640,height:360},{index:2,codec_type:'audio'}]}));
    if(!args.includes('-ss'))return Buffer.alloc(200);
    assert.equal(policy.jobs.size,1);encodes.push({encoder:args[args.indexOf('-c:v')+1],maps:args.filter((_,i)=>args[i-1]==='-map')});
    return {video:Buffer.alloc(200),audio:Buffer.alloc(100)};
  });manager.conversionPolicy=policy;manager.input=async(_source,_signal,action)=>action('synthetic');
  const source={id:'1',duration:12,partId:'part',sourceKey:'source',shareKey:['room','version'],principal:'alice',audioIndex:2};
  const a=manager.acquire(source,'720p4',false,'vp9'),b=manager.acquire({...source,principal:'bob'},'720p4',false,'vp9'),c=manager.acquire(source,'720p4',false,'vp8');
  try{
    assert.equal(a.group,b.group);assert.notEqual(a.group,c.group);
    assert.throws(()=>manager.acquire({...source,audioIndex:4},'720p4',true,'vp9'),e=>e.conversionCapacity);
    const signal=new AbortController().signal;
    assert.equal(await manager.chunk(a,0,signal),await manager.chunk(b,0,signal));
    await manager.chunk(c,0,signal);assert.deepEqual(encodes.map(v=>v.encoder),['libvpx-vp9','libvpx']);
    assert.deepEqual(encodes[0].maps,['0:v:0','0:2']);assert.equal(policy.jobs.size,0);
    policy.settings.formats=['vp8'];await assert.rejects(manager.chunk(a,1,signal),/VP9.*not offered/);
  }finally{for(const lease of [a,b,c])manager.release(lease);await manager.close();}
});

test('simultaneous VP8 and VP9 requests cannot bypass the shared conversion limit',async()=>{
  let releaseFirst,started;
  const firstStarted=new Promise(resolve=>{started=resolve;}),encodes=[];
  const policy=new ConversionPolicy({policy:'override',uburoom:true,formats:['vp8','vp9'],maxJobs:1},{});
  const manager=new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder:'software',maxJobs:2}},async(_file,args)=>{
    if(args.includes('-show_entries'))return Buffer.from(JSON.stringify({streams:[{index:0,codec_type:'video',width:640,height:360}]}));
    if(!args.includes('-ss'))return Buffer.alloc(200);
    encodes.push(args[args.indexOf('-c:v')+1]);
    if(encodes.length===1){started();await new Promise(resolve=>{releaseFirst=resolve;});}
    assert.equal(policy.jobs.size,1);return {video:Buffer.alloc(200),audio:Buffer.alloc(100)};
  });manager.conversionPolicy=policy;manager.input=async(_source,_signal,action)=>action('synthetic');
  const a=manager.acquire({id:'1',duration:6},'direct',false,'vp8'),b=manager.acquire({id:'1',duration:6},'direct',false,'vp9');
  try{
    const first=manager.chunk(a,0,new AbortController().signal);await firstStarted;
    const second=manager.chunk(b,0,new AbortController().signal);
    await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(encodes,['libvpx']);assert.equal(policy.jobs.size,1);
    releaseFirst();await Promise.all([first,second]);assert.deepEqual(encodes,['libvpx','libvpx-vp9']);assert.equal(policy.jobs.size,0);
  }finally{releaseFirst?.();manager.release(a);manager.release(b);await manager.close();}
});

test('local VP8/VP9 preparation enforces allowed formats, Plex policy and subtitle boundaries',async()=>{
  const fixture=accountFixture(),settings=normalizeConfig({transcoding:{policy:'override',plex:false,formats:['vp9','vp8']}}).transcoding;
  const plex=new Plex({plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner',ffmpegPath:'fixture',transcoding:settings},async(input,options)=>{
    const response=await fixture.fetch(input,options);
    if(new URL(input).pathname==='/library/metadata/1'){
      const data=await response.json();data.MediaContainer.Metadata[0].Media[0].Part[0].Stream=[{id:42,streamType:3,codec:'ass'}];return new Response(JSON.stringify(data));
    }
    return response;
  });
  try{
    for(const codec of ['vp8','vp9']){const media=await plex.prepare('1','direct',true,undefined,codec);assert.equal(media.format,codec);assert.equal(media.videoCodec,codec);assert.equal(media.av1Lease.group.codec,codec);await plex.stop(media);}
    await assert.rejects(plex.prepare('1','direct',true,undefined,'av1'),/not offered/);
    settings.policy='follow_plex';plex.conversionPolicy.plex={json:async()=>({Setting:[{id:'TranscoderCanOnlyRemuxVideo',value:'1'}]})};
    await assert.rejects(plex.prepare('1','direct',true,undefined,'vp9'),/Plex disables/);
    settings.policy='override';
    await assert.rejects(plex.prepare('1','direct',true,undefined,'vp8',{subtitleId:'42'}),/cannot preserve/);
  }finally{await plex.close();}
});
