'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Plex}=require('../server/plex');
const {HLSPool}=require('../server/hls-pool');
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),{randomUUID}=require('node:crypto');
const {createApp}=require('../server/app');
function fixture(){
  const state={starts:[],stops:[],requests:[],denied:new Set(),invalid:new Set(),audio:new Map(),subtitle:new Map()};
  const bytes=Buffer.alloc(188*3);for(let i=0;i<bytes.length;i+=188)bytes[i]=0x47;
  const sessions=new Map(),json=value=>new Response(JSON.stringify({MediaContainer:value}),{headers:{'Content-Type':'application/json'}});
  const fetch=async(input,options={})=>{
    const url=new URL(input),token=options.headers['X-Plex-Token'];state.requests.push({path:url.pathname,token});
    if(state.invalid.has(token))return new Response(null,{status:403});
    if(url.pathname==='/library/metadata/1'){
      if(state.denied.has(token))return new Response(null,{status:403});
      return json({Metadata:[{ratingKey:'1',type:'movie',title:'Synthetic pooled source',duration:120000,Media:[{id:4,videoCodec:'hevc',height:1080,width:1920,bitrate:24000,Part:[{id:5,size:12345,key:'/library/parts/5/file',Stream:[
        {id:10,index:0,streamType:1,codec:'hevc'},
        ...[11,12].map((id,i)=>({id,index:i+1,streamType:2,codec:'ac3',selected:(state.audio.get(token)||'11')===String(id)})),
        ...[21,24].map(id=>({id,streamType:3,codec:'srt',key:'/library/streams/'+id})),
        ...[22,23].map((id,i)=>({id,index:i+3,streamType:3,codec:id===22?'pgs':'ass',selected:state.subtitle.get(token)===String(id)}))]}]}]}]});
    }
    if(url.pathname==='/library/parts/5'){
      if(url.searchParams.has('audioStreamID'))state.audio.set(token,url.searchParams.get('audioStreamID'));
      if(url.searchParams.has('subtitleStreamID'))state.subtitle.set(token,url.searchParams.get('subtitleStreamID'));
      return json({});
    }
    if(url.pathname.endsWith('/decision')){
      const burn=url.searchParams.get('subtitles')==='burn';
      return json({generalDecisionCode:1001,Metadata:[{Media:[{videoCodec:'h264',audioCodec:'aac',subtitleDecision:burn?'burn':'none',Part:[{Stream:[
        {streamType:1,codec:'h264'},{streamType:2,id:Number(state.audio.get(token)||'11'),codec:'aac',selected:1},
        ...(burn?[{streamType:3,id:Number(state.subtitle.get(token)),decision:'burn'}]:[])]}]}]}]});
    }
    if(url.pathname.endsWith('/start.m3u8')){
      const id=url.searchParams.get('session');sessions.set(id,token);state.starts.push({id,token});
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=20000000\n/streams/'+id+'/list.m3u8\n');
    }
    const match=/^\/streams\/([^/]+)\/(list.m3u8|0.ts|1.ts)$/.exec(url.pathname);
    if(match){
      if(sessions.get(match[1])!==token||options.headers['X-Plex-Client-Identifier']!==match[1])return new Response(null,{status:403});
      return match[2]==='list.m3u8'?new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n0.ts\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST\n'):
        new Response(bytes,{headers:{'Content-Type':'video/mp2t'}});
    }
    if(url.pathname.endsWith('/stop')){const id=url.searchParams.get('session');state.stops.push(id);sessions.delete(id);return json({});}
    return json({});
  };
  const plex=new Plex({plexUrl:'http://pool-fixture.invalid',plexToken:'alpha'},fetch),a=plex.scope('alpha','alice'),b=plex.scope('beta','bob');
  const prepare=(scope,quality='1080p20',choices={})=>scope.prepare('1',quality,false,undefined,undefined,{shareKey:['room','media'],subtitleId:'off',authorized:async()=>true,...choices});
  return {plex,a,b,prepare,state,bytes,fetch};
}

test('two matching accounts share one Plex conversion; another bitrate stays separate and leases stop only the final reference',async()=>{
  const f=fixture();
  try{
    const [a,b,phone]=await Promise.all([f.prepare(f.a),f.prepare(f.b),f.prepare(f.b,'720p4')]);
    assert.equal(f.state.starts.length,2);assert.equal(a.transcodeId,b.transcodeId);assert.notEqual(a.transcodeId,phone.transcodeId);
    assert.equal(a.plexContext,f.a);assert.equal(b.plexContext,f.b);assert.equal(b.hlsContext,f.a);
    assert.notEqual(a,b);assert.notEqual(a.resources,b.resources);assert.notEqual(a.subtitleAbort,b.subtitleAbort);assert.notEqual(a.captionVersion,b.captionVersion);
    assert.ok(f.state.requests.some(r=>r.path==='/library/metadata/1'&&r.token==='beta'),'joining account resolves the source through its own scope');
    await f.plex.stop(a);await f.plex.stop(a);assert.equal(f.state.stops.length,0);
    const anchor=b.hlsLease.group.anchor,reads=f.state.requests.length;
    assert.deepEqual(Buffer.from(await f.plex.hlsPool.response(b.hlsLease,anchor.url,'GET').arrayBuffer()),f.bytes);
    const range=f.plex.hlsPool.response(b.hlsLease,anchor.url,'GET','bytes=188-375');assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,188);
    assert.equal(f.state.requests.length,reads,'cached anchor never rewinds the producer for another viewer');
    await f.plex.stop(b);assert.deepEqual(f.state.stops,[a.transcodeId]);
    await f.plex.stop(phone);assert.equal(f.plex.hlsPool.bytes,0);assert.equal(f.plex.hlsPool.live.size,0);
  }finally{await f.plex.close();}
});

test('browser captions share video but burned subtitle IDs, audio, room and media generation change the output key',async()=>{
  const f=fixture(),media=[];
  try{
    const off=await f.prepare(f.a),text=await f.prepare(f.b,'1080p20',{subtitleId:'21'}),otherText=await f.prepare(f.b,'1080p20',{subtitleId:'24'});
    media.push(off,text,otherText);assert.equal(off.transcodeId,text.transcodeId);assert.equal(text.transcodeId,otherText.transcodeId);
    assert.equal(off.selection.subtitle,undefined);assert.equal(text.selection.subtitle.id,'21');assert.equal(otherText.selection.subtitle.id,'24');
    const burn=await f.prepare(f.a,'1080p20',{subtitleId:'22'}),sameBurn=await f.prepare(f.b,'1080p20',{subtitleId:'22'}),otherBurn=await f.prepare(f.b,'1080p20',{subtitleId:'23'});
    media.push(burn,sameBurn,otherBurn);assert.equal(burn.transcodeId,sameBurn.transcodeId);assert.notEqual(burn.transcodeId,off.transcodeId);assert.notEqual(burn.transcodeId,otherBurn.transcodeId);
    for(const choices of[{audioId:'12'},{shareKey:['other-room','media']},{shareKey:['room','other-media']}]){
      const next=await f.prepare(f.b,'1080p20',choices);media.push(next);assert.notEqual(next.transcodeId,off.transcodeId);
    }
  }finally{await Promise.all(media.map(m=>f.plex.stop(m)));await f.plex.close();}
});

test('different browser-rendered ASS and PGS choices share video while retaining personal selection and grants',async()=>{
  const f=fixture();f.plex.av1.ffmpeg='fixture';
  try{
    const a=await f.prepare(f.a,'1080p20',{browserSubtitles:true,subtitleId:'22'}),b=await f.prepare(f.b,'1080p20',{browserSubtitles:true,subtitleId:'23'});
    assert.equal(a.selection.subtitle.delivery,'pgs');assert.equal(b.selection.subtitle.delivery,'ass');assert.equal(a.transcodeId,b.transcodeId);assert.equal(f.state.starts.length,1);
    assert.notEqual(a.plexContext,b.plexContext);assert.notEqual(a.captionVersion,b.captionVersion);
    await f.plex.stop(a);assert.equal(f.state.stops.length,0);await f.plex.stop(b);assert.equal(f.state.stops.length,1);
  }finally{await f.plex.close();}
});

test('denied and expired consumers cannot borrow another account output; refresh replaces a group without stopping its remaining users',async()=>{
  const f=fixture();
  try{
    const a=await f.prepare(f.a),b=await f.prepare(f.b);
    f.state.denied.add('beta');await assert.rejects(f.prepare(f.b),/403/);f.state.denied.clear();
    await assert.rejects(f.prepare(f.b,'1080p20',{authorized:async()=>false}),/expired/);
    assert.equal(f.state.starts.length,1);
    const refreshed=await f.prepare(f.b,'1080p20',{excludeLease:b.hlsLease});assert.notEqual(refreshed.transcodeId,a.transcodeId);
    await f.plex.stop(b);assert.equal(f.state.stops.length,0);
    const otherRefresh=await f.prepare(f.a,'1080p20',{excludeLease:a.hlsLease});assert.equal(otherRefresh.transcodeId,refreshed.transcodeId,'simultaneous refreshes converge on the new generation');
    await f.plex.stop(a);assert.deepEqual(f.state.stops,[a.transcodeId]);
    await f.plex.stop(refreshed);await f.plex.stop(otherRefresh);
  }finally{await f.plex.close();}
});

test('bounded or unsupported anchors fall back to independent outputs without stopping the returned private stream',async()=>{
  const f=fixture();f.plex.hlsPool.anchorBytes=100;
  try{
    const [a,b]=await Promise.all([f.prepare(f.a),f.prepare(f.b)]);assert.notEqual(a.transcodeId,b.transcodeId);
    assert.equal(a.hlsLease,undefined);assert.equal(b.hlsLease,undefined);assert.equal(f.state.stops.length,0);
    assert.equal(f.plex.hlsPool.bytes,0);assert.equal(f.plex.hlsPool.pendingBytes,0);
    await f.plex.stop(a);await f.plex.stop(b);assert.equal(f.state.stops.length,2);
  }finally{await f.plex.close();}
});

test('an expired producer cannot use another consumer permission to prepare its source',async()=>{
  let allowed=true,finish,entered;const started=new Promise(resolve=>{entered=resolve;});const stopped=[];
  const pool=new HLSPool(async media=>stopped.push(media));pool.anchor=async()=>({url:'http://fixture/0.ts',bytes:Buffer.alloc(0),type:'video/mp2t'});
  const first=pool.acquire('key',async authorized=>{entered();await new Promise(resolve=>{finish=resolve;});if(!await authorized())throw new Error('producer expired');return {id:'first'};},async()=>allowed);
  await started;const second=pool.acquire('key',async authorized=>{assert.equal(await authorized(),true);return {id:'second'};},async()=>true);
  allowed=false;finish();await assert.rejects(first,/producer expired/);const own=await second;assert.equal(own.media.id,'second');assert.equal(own.lease,undefined);
  await pool.close();assert.equal(pool.live.size,0);
});

test('aggregate anchor memory and pooled group counts are bounded without preventing private playback',async()=>{
  for(const limit of['bytes','groups']){
    const f=fixture();if(limit==='bytes')f.plex.hlsPool.maxBytes=f.bytes.length;else f.plex.hlsPool.maxGroups=1;
    try{
      const a=await f.prepare(f.a),b=await f.prepare(f.b,'720p4');
      assert.ok(a.hlsLease);assert.equal(b.hlsLease,undefined);assert.equal(f.plex.hlsPool.groups.size,1);
      assert.equal(f.plex.hlsPool.bytes,f.bytes.length);assert.equal(f.plex.hlsPool.pendingBytes,0);
      await f.plex.stop(b);assert.equal(f.plex.hlsPool.bytes,f.bytes.length);
      await f.plex.stop(a);assert.equal(f.plex.hlsPool.bytes,0);
    }finally{await f.plex.close();}
  }
});

test('AV1 preparation pools by room across accounts, preserves independent text captions and rejects burn-in',async()=>{
  const f=fixture();f.plex.av1.ffmpeg='fixture';
  const prepare=(scope,choices={})=>scope.prepare('1','720p4',false,undefined,'av1',{shareKey:['room','generation'],subtitleId:'off',...choices});
  try{
    const a=await prepare(f.a),b=await prepare(f.b,{subtitleId:'21'}),otherRoom=await prepare(f.b,{shareKey:['other-room','generation']});
    assert.equal(a.av1Lease.group,b.av1Lease.group);assert.notEqual(a.av1Lease.group,otherRoom.av1Lease.group);
    assert.equal(a.selection.subtitle,undefined);assert.equal(b.selection.subtitle.id,'21');
    await assert.rejects(prepare(f.b,{subtitleId:'22'}),/cannot preserve/);
    await f.plex.stop(a);assert.equal(b.av1Lease.group.refs,1);
    await f.plex.stop(b);await f.plex.stop(otherRoom);assert.equal(f.plex.av1.groups.size,0);
  }finally{await f.plex.close();}
});

test('shared HTTP delivery retains viewer grants and own-scope access checks, and can replace an expired producer',async()=>{
  const f=fixture(),cert=fs.readFileSync(path.join(__dirname,'../certs/server-cert.pem'));
  const config={cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost',ownerId:'demo-host',guildId:'guild',channels:['commands'],demo:true,plexUrl:'http://pool-fixture.invalid',plexToken:'alpha'};
  const app=createApp(config,{plexFetch:f.fetch}),root=app.watch.plex;
  const scopes=new Map([['demo-host',root.scope('alpha','alice')],['demo-guest',root.scope('beta','bob')]]);
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  app.hub.plexFor=async actor=>scopes.get(actor.userId);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const port=app.server.address().port;config.publicUrl='https://localhost:'+port;
  const request=(route,token,data,extra={})=>new Promise((resolve,reject)=>{
    const req=https.request({hostname:'localhost',port,path:route,ca:cert,method:data===undefined?'GET':'POST',headers:{Origin:config.publicUrl,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,body:res.headers['content-type']?.includes('json')?JSON.parse(bytes):bytes});});
    });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
  });
  try{
    const a=(await request('/api/watch/demo-login',undefined,{persona:'host'})).body.token,b=(await request('/api/watch/demo-login',undefined,{persona:'guest'})).body.token;
    const id=(await request('/api/watch/rooms',a,{})).body.id,aId=randomUUID(),bId=randomUUID();
    const state=(token,viewer)=>request('/api/watch/rooms/'+id+'?viewer='+viewer+'&quality=1080p20',token);
    const command=async(token,viewer,action,args)=>{const current=(await state(token,viewer)).body;return request('/api/watch/rooms/'+id+'/command',token,{viewerId:viewer,epoch:current.epoch,expiresAt:Date.now()+2500,command:{action,args}});};
    await state(a,aId);assert.equal((await command(a,aId,'media.load',{mediaId:'1',quality:'1080p20'})).body.status,'applied');
    const aState=(await state(a,aId)).body,bState=(await state(b,bId)).body;
    assert.equal(f.state.starts.length,1);assert.notEqual(aState.mediaUrl,bState.mediaUrl);assert.notEqual(aState.streamVersion,bState.streamVersion);
    const child=body=>body.toString().split('\n').find(line=>line.startsWith('/api/watch/media/'));
    const aList=await request(child((await request(aState.mediaUrl,a)).body),a),bList=await request(child((await request(bState.mediaUrl,b)).body),b);
    const aAnchor=child(aList.body),bAnchor=child(bList.body),bSegments=bList.body.toString().split('\n').filter(line=>line.startsWith('/api/watch/media/'));
    assert.deepEqual((await request(bAnchor,b)).body,f.bytes);assert.equal((await request(bAnchor,b,undefined,{Range:'bytes=188-375'})).status,206);
    await request(bSegments[1],b);assert.equal(f.state.requests.at(-1).token,'alpha','shared output uses its producer; source permission was checked with beta separately');
    f.state.denied.add('beta');scopes.get('demo-guest').allowedItems.clear();
    assert.equal((await request(bAnchor,b)).status,403,'revocation rejects cached bytes too');assert.equal((await request(aAnchor,a)).status,200);
    f.state.denied.clear();await state(b,bId);
    assert.equal((await request('/api/watch/rooms/'+id+'/leave',a,{viewerId:aId})).status,200);
    assert.equal(f.state.stops.length,0,'departing producer viewer does not stop another viewer');
    assert.equal((await request(aAnchor,a)).status,403);assert.equal((await request(bAnchor,b)).status,200);
    f.state.invalid.add('alpha');assert.equal((await request(bSegments[1],b)).status,410,'lost producer credentials allow a viewer-scoped stream refresh');
    const current=(await state(b,bId)).body;
    assert.equal((await command(b,bId,'media.stream.refresh',{mediaVersion:current.mediaVersion,streamVersion:current.streamVersion})).body.status,'applied');
    assert.equal(f.state.starts.at(-1).token,'beta','replacement is prepared with the remaining viewer credential');
    const next=(await state(b,bId)).body;assert.notEqual(next.mediaUrl,bState.mediaUrl);assert.equal((await request(bAnchor,b)).status,403);
    app.watch.remove(id);assert.equal(root.hlsPool.bytes,0);
  }finally{await app.close();await f.plex.close();}
});
