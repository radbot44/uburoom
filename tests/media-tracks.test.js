'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Plex}=require('../server/plex');
const {Watch}=require('../server/watch');
const {Hub}=require('../server/core');
const Tracks=require('../server/media-tracks');
const Subtitles=require('../server/subtitles');
const Engine=require('../shared/engine');
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const {createApp}=require('../server/app');

function provider() {
  const state={selected:undefined,audio:'11',events:[],wrongBurn:false,wrongAudio:false,decisionAudio:'confirmed',deny:false,heldPlaylists:new Set()};
  const streams=()=>[
    {id:10,index:0,streamType:1,codec:'h264'},
    {id:11,index:1,streamType:2,codec:'ac3',languageCode:'eng',displayTitle:'English',selected:state.audio==='11',channels:6},
    {id:12,index:2,streamType:2,codec:'ac3',languageCode:'fra',displayTitle:'French',selected:state.audio==='12',channels:6},
    {id:21,streamType:3,codec:'srt',languageCode:'fra',displayTitle:'French text',key:'/library/streams/21',selected:state.selected==='21'},
    {id:22,index:3,streamType:3,codec:'ass',languageCode:'eng',displayTitle:'English styled',selected:state.selected==='22'},
    {id:23,index:4,streamType:3,codec:'pgs',languageCode:'eng',displayTitle:'English image',selected:state.selected==='23'}];
  const fetch=async(input,options={})=>{
    const url=new URL(input), json=value=>new Response(JSON.stringify({MediaContainer:value}),{headers:{'Content-Type':'application/json'}});
    state.events.push({path:url.pathname,method:options.method || 'GET',token:options.headers['X-Plex-Token']});
    if(url.pathname==='/library/metadata/1') {
      if(state.deny)return new Response(null,{status:403});
      return json({Metadata:[{ratingKey:'1',type:'movie',title:'Track fixture',duration:60000,Media:[{videoCodec:'h264',height:1080,bitrate:24000,Part:[{id:5,key:'/library/parts/5/file',Stream:streams()}]}]}]});
    }
    if(url.pathname==='/library/parts/5' && options.method==='PUT'){
      if(state.failSubtitleRestore && url.searchParams.get('subtitleStreamID')==='0')return new Response(null,{status:503});
      if(url.searchParams.has('subtitleStreamID')){state.selected=url.searchParams.get('subtitleStreamID');state.events.push({selection:state.selected});}
      if(url.searchParams.has('audioStreamID')){state.audio=url.searchParams.get('audioStreamID');state.events.push({audioSelection:state.audio});}
      return json({});
    }
    if(url.pathname.endsWith('/decision')) {
      // Model measured PMS behavior: the universal query hint is ignored.
      const burned=url.searchParams.get('subtitles')==='burn', audioId=state.wrongAudio ? 11 : Number(state.audio);
      const audioRows=state.decisionAudio==='missing' ? [] : state.decisionAudio==='ambiguous' ?
        [11,12].map(id=>({streamType:2,id,codec:'aac',selected:1})) :
        [{streamType:2,...(state.decisionAudio==='unidentified' ? {} : {id:audioId}),codec:'aac',selected:1}];
      return json({generalDecisionCode:1001,Metadata:[{Media:[{videoCodec:'h264',audioCodec:'aac',subtitleDecision:burned?'burn':'none',Part:[{Stream:[{streamType:1,codec:'h264'},
        ...audioRows,...(burned ? [{streamType:3,id:state.wrongBurn ? 999 : Number(state.selected),decision:'burn'}] : [])]}]}]}]});
    }
    if(url.pathname.endsWith('/start.m3u8')) {state.events.push({startedWith:state.selected,startedAudio:state.audio});state.onStart?.();await new Promise(r=>setTimeout(r,5));return state.failStart ? new Response(null,{status:503}) : new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nchild.m3u8\n');}
    if(url.pathname.endsWith('/child.m3u8')) {
      const body='#EXTM3U\n#EXTINF:6\nsegment.ts\n';
      if(state.holdPlaylist)return new Response(new ReadableStream({start(controller){
        const release=()=>{controller.enqueue(new TextEncoder().encode(body));controller.close();state.heldPlaylists.delete(release);};
        state.heldPlaylists.add(release);state.releasePlaylist=()=>{for(const resume of [...state.heldPlaylists])resume();};state.playlistStarted?.();
      }}),{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
      return new Response(body,{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
    }
    if(url.pathname==='/library/streams/21.srt')return new Response('1\n00:00:01,000 --> 00:00:04,000\nBonjour\n');
    return json({});
  };
  const plex=new Plex({plexUrl:'http://fixture.invalid:32400',plexToken:'fixture',ffmpegPath:'fixture'},fetch);
  return {plex,state,streams};
}
test('track catalog distinguishes source IDs, selected flags, roles and text versus Plex burn-in',()=>{
  const {streams}=provider(), rows=Tracks.catalog({Stream:streams()});
  assert.equal(rows.audio[1].selected,false); assert.equal(Tracks.select(rows).audio.id,'11');
  assert.equal(rows.subtitles[0].delivery,'text'); assert.equal(rows.subtitles[1].delivery,'burn'); assert.equal(rows.subtitles[2].available,true);
  assert.equal(Tracks.select(rows,{subtitleId:'off'}).subtitle,undefined);
  assert.throws(()=>Tracks.select(rows,{subtitleId:'999'}),/does not belong/);
  const next=Tracks.catalog({Stream:[{id:99,streamType:2,languageCode:'fra',codec:'aac',selected:'0'}]});
  assert.equal(Tracks.select(next,{audioIntent:Tracks.intent(rows.audio[1])}).audio.id,'99','language/role intent crosses items without reusing numeric IDs');
  const publicRows=Tracks.publicCatalog(rows);
  assert.equal('index' in publicRows.audio[0],false); assert.equal('key' in publicRows.subtitles[0],false);
});
test('SRT/WebVTT parsing preserves timing, Unicode, cue settings and literal media cue text',()=>{
  assert.deepEqual(Subtitles.parse('\uFEFF1\r\n00:00:01,100 --> 00:00:04,250\r\nDeuxième\r\nligne\r\n'),[{start:1.1,end:4.25,text:'Deuxième\nligne',settings:''}]);
  const cues=Subtitles.parse('WEBVTT\n\nSTYLE\n::cue{color:red}\n\n00:01.000 --> 00:04.000 align:start position:20%\n<script>literal</script>\n');
  assert.equal(cues[0].settings,'align:start position:20%'); assert.equal(cues[0].text,'<script>literal</script>');
  assert.throws(()=>Subtitles.parse('<html>Not subtitles</html>'),/usable/);
  assert.throws(()=>Subtitles.parse('1\n00:99:01,000 --> 00:00:04,000\nbad'),/invalid/);
});
test('Plex selects and confirms the exact subtitle before starting its private burn session',async()=>{
  const {plex,state}=provider();
  try {
    const media=await plex.prepare('1','direct',false,undefined,undefined,{audioId:'12',subtitleId:'22'});
    assert.equal(media.selection.audio.id,'12'); assert.equal(media.selection.subtitle.id,'22'); assert.equal(media.format,'hls');
    assert.match(media.initialManifest,/EXTM3U/); assert.equal(new URL(media.start).searchParams.get('advancedSubtitles'),'burn');
    assert.equal(new URL(media.start).searchParams.get('audioStreamID'),'12'); assert.deepEqual(state.events.filter(e=>e.startedWith).map(e=>e.startedWith),['22']);
    state.wrongBurn=true;
    await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{subtitleId:'23'}),/did not confirm burning/);
    state.wrongBurn=false; state.wrongAudio=true;
    await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{audioId:'12'}),/requested audio/);
  } finally {await plex.close();}
});
test('concurrent burn requests capture their own choices before another viewer changes Plex selection',async()=>{
  const {plex,state}=provider();
  try {
    const [a,b]=await Promise.all(['22','23'].map(subtitleId=>plex.prepare('1','direct',false,undefined,undefined,{subtitleId})));
    assert.notEqual(a.transcodeId,b.transcodeId); assert.deepEqual(state.events.filter(e=>e.startedWith).map(e=>e.startedWith),['22','23']);
    const events=state.events.filter(e=>e.selection || e.startedWith).map(e=>e.selection ? 'select:'+e.selection : 'start:'+e.startedWith);
    assert.deepEqual(events,['select:22','start:22','select:0','select:23','start:23','select:0']); assert.equal(state.selected,'0');assert.equal(plex.partQueues.size,0);
    const before=state.events.filter(e=>e.method==='PUT').length;
    await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{subtitleId:'22',authorized:async()=>false}),/expired/);
    assert.equal(state.events.filter(e=>e.method==='PUT').length,before,'expired work cannot mutate Plex selections');
  } finally {await plex.close();}
});
test('burn sessions restore Off or a selected subtitle on success, rejected decisions and failed startup',async()=>{
  const {plex,state}=provider();
  try {
    for (const original of ['0','21','23']) for (const failure of ['none','decision','start']) {
      state.selected=original;state.wrongBurn=failure==='decision';state.failStart=failure==='start';
      const prepare=plex.prepare('1','direct',false,undefined,undefined,{audioId:'12',subtitleId:'22'});
      if (failure==='none') assert.equal((await prepare).selection.subtitle.id,'22');else await assert.rejects(prepare);
      assert.equal(state.selected,original,`${original}/${failure} restores the saved subtitle`);
      assert.equal(state.audio,'11','audio restoration still runs');
    }
    state.wrongBurn=false;state.failStart=false;state.selected='22';
    const before=state.events.filter(e=>e.selection).length;
    await plex.prepare('1','direct',false,undefined,undefined,{subtitleId:'22'});
    assert.equal(state.events.filter(e=>e.selection).length,before,'an already selected subtitle needs no mutation');
  } finally {await plex.close();}
});

test('subtitle restoration respects an external choice and uses only the viewer credential',async()=>{
  const {plex,state}=provider();
  try {
    const scoped=plex.scope('viewer-only','viewer');
    for (const external of ['0','21','23']) {
      state.selected='0';state.onStart=()=>{state.selected=external;};
      const media=await scoped.prepare('1','direct',false,undefined,undefined,{subtitleId:'22'});
      assert.equal(media.selection.subtitle.id,'22');assert.equal(state.selected,external);
    }
    assert.ok(state.events.filter(e=>e.path).every(e=>e.token==='viewer-only'));
    assert.equal(state.events.filter(e=>e.selection).length,3,'only the temporary selections are written');
  } finally {await plex.close();}
});

test('a failed subtitle restoration fails preparation but still restores audio and stops the captured session',async()=>{
  const {plex,state}=provider();
  try {
    state.failSubtitleRestore=true;
    await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{audioId:'12',subtitleId:'22'}));
    assert.equal(state.audio,'11');assert.equal(plex.partQueues.size,0);
    assert.ok(state.events.some(e=>e.path?.endsWith('/stop')),'failed restoration releases the captured conversion');
  } finally {await plex.close();}
});

test('audio starts capture different per-viewer choices and restore the saved preference, including failures',async()=>{
  const {plex,state}=provider();
  try {
    const [french,english]=await Promise.all(['12','11'].map(audioId=>plex.prepare('1','direct',false,undefined,undefined,{audioId,subtitleId:'off'})));
    assert.notEqual(french.transcodeId,english.transcodeId);
    assert.deepEqual(state.events.filter(e=>e.startedAudio).map(e=>e.startedAudio),['12','11']);
    assert.equal(state.audio,'11');assert.equal(french.selection.audio.id,'12');assert.equal(english.selection.audio.id,'11');
    const events=state.events.filter(e=>e.audioSelection || e.startedAudio).map(e=>e.audioSelection ? 'select:'+e.audioSelection : 'start:'+e.startedAudio);
    assert.deepEqual(events,['select:12','start:12','select:11','start:11']);
    assert.match(english.initialManifest,/EXTM3U/,'default audio is captured before another selection can start');
    state.wrongAudio=true;
    await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{audioId:'12'}),/requested audio/);
    assert.equal(state.audio,'11','wrong decision restores the original preference');
    state.wrongAudio=false;state.failStart=true;
    await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{audioId:'12'}));
    assert.equal(state.audio,'11','failed startup restores the original preference');
    const before=state.events.filter(e=>e.method==='PUT').length;
    await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{audioId:'12',authorized:async()=>false}),/expired/);
    assert.equal(state.events.filter(e=>e.method==='PUT').length,before);
  } finally {await plex.close();}
});

test('audio selection and restoration use only the current viewer Plex credential',async()=>{
  const {plex,state}=provider();
  try {
    const scoped=plex.scope('viewer-only','viewer');
    await scoped.prepare('1','direct',false,undefined,undefined,{audioId:'12'});
    assert.equal(state.audio,'11');
    assert.ok(state.events.some(e=>e.method==='PUT'));
    assert.ok(state.events.filter(e=>e.path).every(e=>e.token==='viewer-only'));
  } finally {await plex.close();}
});

test('HLS preparation rejects decisions that cannot identify one matching source audio stream',async()=>{
  const {plex,state}=provider();
  try {
    for(const kind of ['missing','unidentified','ambiguous']) {
      state.decisionAudio=kind;
      await assert.rejects(plex.prepare('1','direct',false,undefined,undefined,{audioId:'12'}),/did not confirm the requested audio/);
      assert.equal(state.audio,'11',`${kind} decision restores the saved audio preference`);
    }
    assert.equal(state.events.filter(e=>e.startedAudio).length,0,'unconfirmed audio never starts a private stream');
    assert.equal(plex.partQueues.size,0);
  } finally {await plex.close();}
});

test('sidecar requests retain the viewer Plex scope, cap content, and do not fetch embedded streams as sidecars',async()=>{
  const {plex,state}=provider(), scoped=plex.scope('viewer-only','viewer');
  try {
    const media=await scoped.prepare('1','direct',false,undefined,undefined,{subtitleId:'21'});
    const cues=await Subtitles.load(scoped,media,new AbortController().signal); assert.equal(cues[0].text,'Bonjour');
    assert.equal(state.events.find(e=>e.path==='/library/streams/21.srt').token,'viewer-only');
    const burn=await scoped.prepare('1','direct',false,undefined,undefined,{subtitleId:'22'});
    await assert.rejects(Subtitles.load(scoped,burn,new AbortController().signal),/external text/);
  } finally {await plex.close();}
});
test('personal tracks preserve room state, isolate viewers, reject stale choices and roll back refused conversions',async()=>{
  const {plex,state}=provider(), hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
  hub.access={isMember:()=>true,refresh:async()=>true,options:()=>({available:true})};
  const watch=new Watch(hub,plex), actor=userId=>({userId,guildId:'guild',channelId:'commands',surface:'web'}), host=actor('host'), guest=actor('guest');
  const room=watch.rooms.get(watch.create(host)), a=randomUUID(), b=randomUUID();
  try {
    watch.snapshot(room,host,a); watch.snapshot(room,guest,b); room.media=await plex.prepare('1','direct',false,undefined,undefined,{sourceOnly:true});
    await watch.prepareViewer(room,host,a); await watch.prepareViewer(room,guest,b); room.position=12; room.s.state.paused=true;
    const command=async(args,who=guest,viewerId=b)=>hub.dispatch({...who,watchViewerId:viewerId},{roomId:room.s.roomId,action:'media.tracks.set',args:{mediaVersion:room.mediaVersion,streamVersion:room.viewers.get(viewerId).streamVersion,...args}});
    const other=room.viewers.get(a).media, previous=room.viewers.get(b).media;
    assert.equal((await command({subtitleId:'21'})).status,'applied');
    assert.equal(room.viewers.get(b).media,previous,'external subtitles do not restart video');
    assert.equal((await command({audioId:'12'})).status,'applied'); assert.equal(room.viewers.get(b).media.selection.audio.id,'12');
    assert.equal(room.viewers.get(a).media,other); assert.equal(room.position,12); assert.equal(room.s.state.paused,true);
    const good=room.viewers.get(b).media; state.wrongBurn=true;
    assert.equal((await command({subtitleId:'22'})).status,'failed'); assert.equal(room.viewers.get(b).media,good);
    assert.equal((await command({streamVersion:randomUUID(),subtitleId:'off'})).status,'unavailable');
    assert.equal((await command({subtitleId:'off'},guest,a)).status,'unsupported');
    state.wrongBurn=false;
    assert.equal((await command({subtitleId:'22'})).status,'applied');
    const burned=room.viewers.get(b).media;
    assert.equal((await command({subtitleOffset:2})).status,'failed'); assert.equal(room.viewers.get(b).media,burned);
    assert.equal((await command({subtitleId:'off'})).status,'applied'); assert.equal(room.viewers.get(b).media.selection.subtitle,undefined);
    watch.dropMedia(room); assert.equal(room.viewers.get(b).trackChoice.audioId,'auto'); assert.equal(room.viewers.get(b).trackChoice.subtitleId,'off');
    assert.equal(room.viewers.get(b).trackChoice.audioIntent.language,'fra');
  } finally {watch.close();await plex.close();}
});
test('a failed automatic burn keeps its catalog available for an explicit Off recovery',async()=>{
  const {plex,state}=provider(), hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
  hub.access={isMember:()=>true,refresh:async()=>true,options:()=>({available:true})};
  const watch=new Watch(hub,plex), host={userId:'host',guildId:'guild',channelId:'commands',surface:'web'}, viewerId=randomUUID();
  const room=watch.rooms.get(watch.create(host));state.selected='22';state.wrongBurn=true;
  try {
    watch.snapshot(room,host,viewerId);room.media=await plex.prepare('1','direct',false,undefined,undefined,{sourceOnly:true});
    await watch.prepareViewer(room,host,viewerId);const viewer=room.viewers.get(viewerId);
    assert.match(viewer.media.playbackError,/did not confirm burning/);assert.ok(watch.snapshot(room,host,viewerId).tracks.subtitles.length);
    const result=await hub.dispatch({...host,watchViewerId:viewerId},{roomId:room.s.roomId,action:'media.tracks.set',args:{mediaVersion:room.mediaVersion,streamVersion:viewer.streamVersion,subtitleId:'off'}});
    assert.equal(result.status,'applied');assert.equal(viewer.media.playbackError,undefined);assert.equal(viewer.media.selection.subtitle,undefined);
  } finally {watch.close();await plex.close();}
});

test('track command validation binds current media and stream versions and never accepts source URLs',()=>{
  const versions={mediaVersion:randomUUID(),streamVersion:randomUUID()};
  assert.equal(Engine.validate({action:'media.tracks.set',args:{...versions,audioId:'12'}}).args.audioId,'12');
  for(const args of [{subtitleId:'off'},{...versions,audioId:'https://example.com'},{...versions,subtitleOffset:31},{...versions}])assert.throws(()=>Engine.validate({action:'media.tracks.set',args}));
});
test('browser subtitle resources enforce grants, selection generations and explicit burn-in fallback',async t=>{
  const fixture=provider(),cert=fs.readFileSync(path.join(__dirname,'../certs/server-cert.pem'));
  const config={cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost',demo:true,ownerId:'demo-host',guildId:'guild',channels:['commands'],plexUrl:'http://fixture.invalid:32400',plexToken:'fixture',ffmpegPath:'fixture'};
  let member=true;
  const app=createApp(config,{plexFetch:fixture.plex.fetch});app.hub.access={isMember:()=>member,refresh:async()=>member,options:()=>({available:true})};
  app.watch.plex.av1.input=async(source,signal,action)=>action('http://127.0.0.1/synthetic-capability');
  app.watch.plex.av1.run=async(binary)=>Buffer.from(binary.includes('ffprobe')?'{"streams":[]}':'[Script Info]\n[Events]\n');
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());t.after(()=>fixture.plex.close());
  const port=app.server.address().port;config.publicUrl='https://localhost:'+port;
  const control=require('./helpers/control-client').controlClient(t,config,cert);
  const request=(route,method='GET',data,token)=>control.handles(route)?control.request(route,data,token?{Authorization:'Bearer '+token}:{}):new Promise((resolve,reject)=>{
    const req=https.request({hostname:'localhost',port,path:route,method,ca:cert,headers:{Origin:config.publicUrl,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{
      const chunks=[];res.on('data',bytes=>chunks.push(bytes));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,body:text&&res.headers['content-type']?.includes('application/json')?JSON.parse(text):text});});
    });req.on('error',reject);req.end(data&&JSON.stringify(data));
  });
  const token=(await request('/api/watch/demo-login','POST',{persona:'host'})).body.token,viewerId=randomUUID();
  const room=(await request('/api/watch/rooms','POST',{},token)).body.id;
  const snapshot=async()=> (await request('/api/watch/rooms/'+room+'?viewer='+viewerId+'&subtitles=browser','GET',undefined,token)).body;
  const command=async(action,args)=>{const state=await snapshot();return request('/api/watch/rooms/'+room+'/command','POST',
    {viewerId,epoch:state.epoch,expiresAt:Date.now()+2500,command:{action,args:{...args,...(action==='media.tracks.set'?{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion}:{})}}},token);};
  await snapshot();await command('media.load',{mediaId:'1',quality:'direct'});await command('media.tracks.set',{subtitleId:'22'});
  const state=await snapshot();assert.equal(state.tracks.subtitleDelivery,'ass');
  const descriptor=await request(state.subtitleUrl);assert.equal(descriptor.status,200);assert.equal(descriptor.body.format,'ass');
  const asset=await request(descriptor.body.data);assert.equal(asset.status,200);assert.match(asset.body,/Script Info/);assert.equal(asset.headers['cache-control'],'no-store');
  assert.equal((await request(state.subtitleUrl+'/font-0')).status,404);assert.equal((await request(state.subtitleUrl.replace(/media\/[a-f0-9]+/,'media/'+ '0'.repeat(48)))).status,403);
  const old=app.watch.rooms.get(room).viewers.get(viewerId).media;fixture.state.wrongBurn=true;
  assert.equal((await command('media.tracks.set',{subtitleMode:'burn'})).body.status,'failed');assert.equal(app.watch.rooms.get(room).viewers.get(viewerId).media,old);
  fixture.state.wrongBurn=false;assert.equal((await command('media.tracks.set',{subtitleMode:'burn'})).body.status,'applied');assert.equal((await snapshot()).tracks.subtitleDelivery,'burn');
  assert.equal((await request(descriptor.body.data)).status,403);
  assert.equal((await command('media.tracks.set',{subtitleId:'23'})).body.status,'applied');
  assert.equal((await snapshot()).tracks.subtitleMode,'burn');assert.equal((await snapshot()).tracks.subtitleDelivery,'burn');
  await command('media.tracks.set',{subtitleId:'off'});assert.equal((await snapshot()).tracks.subtitleMode,'burn');
  await command('media.tracks.set',{subtitleId:'22'});assert.equal((await snapshot()).tracks.subtitleDelivery,'burn');
  await command('media.tracks.set',{subtitleMode:'auto'});const next=await snapshot();assert.equal(next.tracks.subtitleDelivery,'ass');
  member=false;assert.equal((await request(next.subtitleUrl)).status,403);
  const page=await request('/watch');assert.match(page.headers['content-security-policy'],/'wasm-unsafe-eval'/);assert.doesNotMatch(page.headers['content-security-policy'],/'unsafe-eval'/);
});

test('media grants reject stale playlists, subtitles and revoked viewers during pending fetches',async t=>{
  const fixture=provider(), cert=fs.readFileSync(path.join(__dirname,'../certs/server-cert.pem'));
  const config={cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost',demo:true,ownerId:'demo-host',guildId:'guild',channels:['commands'],plexUrl:'http://fixture.invalid:32400',plexToken:'fixture'};
  let member=true, waitCaption, releaseCaption;
  const app=createApp(config,{plexFetch:async(input,options)=>{
    if(new URL(input).pathname.startsWith('/library/streams/') && waitCaption){const announce=waitCaption;waitCaption=undefined;announce();await new Promise(resolve=>releaseCaption=resolve);}
    return fixture.plex.fetch(input,options);
  }});
  app.hub.access={isMember:()=>member,refresh:async()=>member,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());t.after(()=>fixture.plex.close());
  const port=app.server.address().port; config.publicUrl='https://localhost:'+port;
  const control=require('./helpers/control-client').controlClient(t,config,cert);
  const request=(route,method='GET',data,token)=>control.handles(route)?control.request(route,data,token?{Authorization:'Bearer '+token}:{}):new Promise((resolve,reject)=>{
    const req=https.request({hostname:'localhost',port,path:route,method,ca:cert,headers:{Origin:config.publicUrl,'Content-Type':'application/json',...(token ? {Authorization:'Bearer '+token} : {})}},res=>{
      const chunks=[];res.on('data',bytes=>chunks.push(bytes));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,body:text && res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text});});
    });req.on('error',reject);req.end(data && JSON.stringify(data));
  });
  const token=(await request('/api/watch/demo-login','POST',{persona:'host'})).body.token;
  const room=(await request('/api/watch/rooms','POST',{},token)).body.id, viewerId=randomUUID();
  const snapshot=async()=> (await request('/api/watch/rooms/'+room+'?viewer='+viewerId,'GET',undefined,token)).body;
  const command=async(action,args)=>{
    const state=await snapshot();
    return request('/api/watch/rooms/'+room+'/command','POST',{viewerId,epoch:state.epoch,expiresAt:Date.now()+2500,command:{action,args:{...args,...(action==='media.tracks.set' ? {mediaVersion:state.mediaVersion,streamVersion:state.streamVersion} : {})}}},token);
  };
  await snapshot();await command('media.load',{mediaId:'1',quality:'direct'});await command('media.tracks.set',{subtitleId:'21'});
  const first=await snapshot(), captions=await request(first.subtitleUrl);
  assert.equal(captions.status,200);assert.equal(captions.body.cues[0].text,'Bonjour');assert.equal(JSON.stringify(first.tracks).includes('/library/'),false);
  const starts=fixture.state.events.filter(e=>e.startedAudio).length;
  const master=await request(first.mediaUrl), repeated=await request(first.mediaUrl);
  assert.equal((await request(first.mediaUrl,'HEAD')).status,200);
  assert.equal(master.status,200);assert.match(master.body,/#EXTM3U/);assert.equal(repeated.body,master.body);
  assert.equal(fixture.state.events.filter(e=>e.startedAudio).length,starts,'master reloads never renegotiate restored audio preferences');
  const childUrl=master.body.split('\n').find(line=>line.startsWith('/api/watch/media/'));
  assert.ok(childUrl,'captured master points to a private child playlist');
  const playlistStarted=new Promise(resolve=>fixture.state.playlistStarted=resolve);
  fixture.state.holdPlaylist=true;
  const pendingPlaylist=request(childUrl);await playlistStarted;
  assert.equal((await command('media.tracks.set',{audioId:'12'})).body.status,'applied');
  fixture.state.releasePlaylist();
  assert.equal((await pendingPlaylist).status,403,'an old playlist cannot arrive after audio selection changes');
  fixture.state.holdPlaylist=false;
  const chosen=await snapshot();
  assert.equal(chosen.tracks.audioId,'12');
  assert.equal((await command('media.stream.refresh',{mediaVersion:chosen.mediaVersion,streamVersion:chosen.streamVersion})).body.status,'applied');
  const refreshed=await snapshot();
  assert.equal(refreshed.tracks.audioId,'12','session refresh retains the personal source audio');
  assert.equal(fixture.state.events.filter(e=>e.startedAudio).at(-1).startedAudio,'12');
  assert.equal(fixture.state.audio,'11','session refresh restores Plex saved audio');
  assert.equal((await request(refreshed.mediaUrl)).status,200);
  assert.equal((await request(chosen.mediaUrl,'HEAD')).status,403,'old master grant is revoked after session refresh');
  await command('media.tracks.set',{subtitleId:'off'});assert.equal((await request(first.subtitleUrl)).status,403);
  await command('media.tracks.set',{subtitleId:'21'});const current=await snapshot();
  const pending=new Promise(resolve=>waitCaption=resolve), fetching=request(current.subtitleUrl);await pending;
  await command('media.tracks.set',{subtitleId:'off'});releaseCaption();
  const stale=await fetching;assert.notEqual(stale.status,200);assert.equal(stale.body.cues,undefined,'late old captions cannot escape a selection change');
  await command('media.tracks.set',{subtitleId:'21'});const revoked=await snapshot();member=false;
  assert.equal((await request(revoked.subtitleUrl)).status,403,'media grant rechecks current membership');
});
