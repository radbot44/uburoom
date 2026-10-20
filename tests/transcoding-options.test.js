'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeConfig}=require('../server/config');
const {qualityDefinition}=require('../shared/room-protocol');
const {ConversionPolicy}=require('../server/transcoding-policy');
const {alternatives}=require('../server/quality-options');
const {AV1,PlaybackError,outputSpec}=require('../server/av1');
const {Watch}=require('../server/watch');

test('quality pairs produce bounded custom definitions without depending on Plex app presets',()=>{
  const config=normalizeConfig({transcoding:{qualities:[[900,5.5],[720,2]],allow_original:false}});
  assert.deepEqual(config.transcoding.qualities.map(q=>q.id),['900p5.5','720p2']);
  assert.equal(qualityDefinition('900p5.5').width,1600);
  assert.equal(outputSpec({streams:[{codec_type:'video',width:1920,height:1080}]},'900p5.5').bitrate,5500);
  for(const qualities of [[[900,0]],[[901,4]],[[720,201]],[[720,'4']],[[720,4],[720,4]],[]])assert.throws(()=>normalizeConfig({transcoding:{qualities,allow_original:false}}));
  for(const id of ['900p0','900p201','900p2;bad','900p2.0001'])assert.equal(qualityDefinition(id),undefined);
  const defaults=normalizeConfig({}).transcoding;assert.equal(defaults.encoder,'auto');assert.equal(defaults.cpuFallback,true);assert.equal(defaults.maxJobs,5);
});

test('quality fallback ranks lower options first then the lowest other available option',()=>{
  const options=['direct','1080p20','1080p12','720p4','720p2'].map(qualityDefinition);
  assert.equal(alternatives(options,'1080p20')[0].id,'1080p12');
  assert.equal(alternatives(options,'480p1')[0].id,'720p2');
  assert.equal(alternatives(options,'direct')[0].id,'1080p20');
});

test('conversion wait hands capacity to queued work, times out and cancels revoked access',async()=>{
  const policy=new ConversionPolicy({maxJobs:1},{}),release=policy.acquire();
  const waiting=policy.wait({timeoutMs:200});setTimeout(release,10);
  const next=await waiting;assert.equal(policy.jobs.size,1);
  await assert.rejects(policy.wait({timeoutMs:10}),e=>e.conversionCapacity);
  const controller=new AbortController(),cancelled=policy.wait({signal:controller.signal});controller.abort();
  await assert.rejects(cancelled,/cancelled/);
  await assert.rejects(policy.wait({authorized:async()=>false}),/cancelled/);
  assert.equal(policy.waiters.length,0);next();assert.equal(policy.jobs.size,0);
});

test('automatic hardware selection probes QSV then NVENC and explicit hardware can fall back to CPU',async()=>{
  const seen=[];
  const make=(encoder,cpuFallback)=>new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder,cpuFallback}},async(_file,args)=>{
    const name=args[args.indexOf('-c:v')+1];seen.push(name);
    if(name==='av1_qsv')throw new PlaybackError('No Intel GPU');return Buffer.alloc(200);
  });
  const automatic=make('auto',true);assert.equal(await automatic.selectEncoder(),'nvenc');assert.deepEqual(seen,['av1_qsv','av1_nvenc']);await automatic.close();
  seen.length=0;const explicit=make('qsv',true);assert.equal(await explicit.selectEncoder(),'software');assert.deepEqual(seen,['av1_qsv','libsvtav1']);await explicit.close();
  seen.length=0;const strict=make('qsv',false);await assert.rejects(strict.selectEncoder(),/No Intel GPU/);assert.deepEqual(seen,['av1_qsv']);await strict.close();
});

test('capacity automatically adopts the best available shared quality without retrying access failures',async()=>{
  const options=['direct','1080p20','1080p12','720p4','720p2'].map(qualityDefinition),attempts=[];
  const plex={qualities:()=>options,prepare:async(_id,quality,_compatible,_source,_fallback,choices)=>{
    attempts.push([quality,!!choices.sharedOnly]);
    if(quality==='1080p12'&&choices.sharedOnly)return {quality,format:'hls'};
    throw Object.assign(new PlaybackError('At capacity'),{conversionCapacity:true});
  }};
  const room={s:{roomId:'room'},mediaVersion:'version'},viewer={};
  const media=await Watch.prototype.prepareQuality.call({plex},room,viewer,plex,{id:'1'},'1080p20',true,undefined,async()=>true);
  assert.equal(media.quality,'1080p12');assert.match(media.qualityNotice,/unavailable/);assert.deepEqual(attempts,[['1080p20',false],['1080p12',true]]);
  plex.prepare=async()=>{throw new PlaybackError('Access revoked');};
  await assert.rejects(Watch.prototype.prepareQuality.call({plex},room,viewer,plex,{id:'1'},'1080p20',true,undefined,async()=>true),/Access revoked/);
});

test('a hardware encode failure retries CPU inside the same conversion reservation',async()=>{
  const encoders=[],policy=new ConversionPolicy({policy:'override',uburoom:true,formats:['av1'],maxJobs:1},{});
  const manager=new AV1({}, {ffmpegPath:'fixture',transcoding:{encoder:'nvenc',cpuFallback:true}},async(_file,args)=>{
    if(args.includes('-show_entries'))return Buffer.from(JSON.stringify({streams:[{index:0,codec_type:'video',width:640,height:360}]}));
    if(!args.includes('-ss'))return Buffer.alloc(200);
    assert.equal(policy.jobs.size,1);const encoder=args[args.indexOf('-c:v')+1];encoders.push(encoder);
    if(encoder==='av1_nvenc')throw Object.assign(new PlaybackError('Hardware unavailable'),{encoderFailure:true});
    return {video:Buffer.alloc(200),audio:Buffer.alloc(100)};
  });
  manager.conversionPolicy=policy;manager.input=async(_source,_signal,action)=>action('synthetic');
  const lease=manager.acquire({id:'1',duration:6},'360p1');
  try{await manager.chunk(lease,0,new AbortController().signal);assert.deepEqual(encoders,['av1_nvenc','libsvtav1']);assert.equal(lease.group.cpuFallback,true);assert.equal(policy.jobs.size,0);}
  finally{manager.release(lease);await manager.close();}
});

test('custom quality reaches numerical Plex resolution/bitrate parameters and rejects unoffered output',async()=>{
  const {Plex}=require('../server/plex'),provider=require('../scripts/account-fixture').accountFixture();let observed;
  const settings=normalizeConfig({transcoding:{policy:'override',qualities:[[900,5.5]]}}).transcoding;
  const plex=new Plex({plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner',transcoding:settings},async(input,options)=>{
    const url=new URL(input);if(url.pathname.endsWith('/decision'))observed=url.searchParams;
    return provider.fetch(input,options);
  });
  try{const media=await plex.prepare('1','900p5.5',true);assert.equal(observed.get('videoResolution'),'1600x900');assert.equal(observed.get('maxVideoBitrate'),'5500');await plex.stop(media);await assert.rejects(plex.prepare('1','1080p20',true),/not offered/);}
  finally{await plex.close();}
});
