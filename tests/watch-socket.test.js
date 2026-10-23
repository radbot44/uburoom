'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),https=require('node:https');
const {randomUUID}=require('node:crypto'),{once}=require('node:events');
const {WebSocket}=require('ws');
const {createApp}=require('../server/app');
const certFile=path.join(__dirname,'../certs/server-cert.pem');

async function fixture(t) {
  const cert=fs.readFileSync(certFile),config={cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost:6768',ownerId:'demo-host',guildId:'guild',channels:['commands'],demo:true};
  config.clientId='fixture';config.clientSecret='fixture-secret';
  const app=createApp(config,{oauthFetch:async url=>new Response(JSON.stringify(String(url).endsWith('/token')?{access_token:'fixture',refresh_token:'fixture',expires_in:3600}:{id:'demo-host',username:'Host'}))});let allowed=true;
  app.hub.access={isMember:()=>allowed,refresh:async()=>allowed,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  config.publicUrl='https://localhost:'+app.server.address().port;t.after(()=>app.close());
  const login=persona=>new Promise((resolve,reject)=>{
    const req=https.request(config.publicUrl+'/api/watch/demo-login',{method:'POST',ca:cert,headers:{Origin:config.publicUrl,'Content-Type':'application/json'}},res=>{
      let raw='';res.on('data',bytes=>raw+=bytes);res.on('end',()=>resolve(JSON.parse(raw)));
    });req.on('error',reject);req.end(JSON.stringify({persona}));
  });
  async function connect(identity,origin=config.publicUrl,cookie) {
    const ws=new WebSocket(config.publicUrl.replace('https:','wss:')+'/watch-socket',{ca:cert,origin,headers:cookie?{Cookie:cookie}:{}});
    const events=[],waiting=new Map();let sequence=0;
    ws.on('message',raw=>{const message=JSON.parse(raw);events.push(message);if(message.type==='response'){const pending=waiting.get(message.id);if(pending){waiting.delete(message.id);pending(message);}}});
    await once(ws,'open');
    const authenticated=once(ws,'message');ws.send(JSON.stringify({type:'auth',token:identity.token,csrf:identity.csrf}));
    assert.equal(JSON.parse((await authenticated)[0]).type,'auth-ok');
    const ping=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'clock',id:0}));},1000);t.after(()=>clearInterval(ping));
    return {ws,events,stopClock:()=>clearInterval(ping),call:(route,data)=>new Promise(resolve=>{const id=++sequence;waiting.set(id,resolve);ws.send(JSON.stringify({type:'request',id,path:route,...(data===undefined?{}:{data})}));})};
  }
  return {app,config,cert,login,connect,revoke:()=>{allowed=false;}};
}
const tls={skip:!fs.existsSync(certFile)};

test('native WebSocket pongs retain room presence without JavaScript clock messages',tls,async t=>{
  const f=await fixture(t),host=await f.connect(await f.login('host'));
  t.after(()=>host.ws.close());host.stopClock();
  const roomId=(await host.call('/api/watch/rooms',{})).value.id,viewer=randomUUID();
  await host.call('/api/watch/rooms/'+roomId+'?viewer='+viewer);
  await new Promise(resolve=>setTimeout(resolve,11500));
  assert.equal(host.ws.readyState,1,'a throttled tab remains connected beyond the old idle deadline');
  const presence=f.app.watch.rooms.get(roomId)?.viewers.get(viewer);
  assert.ok(presence,'same viewer survives');
  assert.ok(Date.now()-presence.at<2000,'native pongs refresh viewer presence');
  f.revoke();const closed=once(host.ws,'close');
  assert.equal((await closed)[0],4003,'server publication still rechecks authorization without client clocks');
});

test('lobby browsing needs no room; private creation never exposes the room to another member',tls,async t=>{
  const f=await fixture(t),host=await f.connect(await f.login('host')),guest=await f.connect(await f.login('guest'));
  assert.equal((await guest.call('/api/watch/library')).status,200);
  assert.equal(f.app.watch.rooms.size,0,'browsing does not create a room');
  assert.equal((await host.call('/api/watch/rooms',{visibility:'invalid'})).status,400);
  assert.equal(f.app.watch.rooms.size,0);
  const roomId=(await host.call('/api/watch/rooms',{visibility:'private'})).value.id;
  assert.equal(f.app.watch.rooms.get(roomId).s.visibility,'private');
  assert.equal(f.app.watch.rooms.get(roomId).s.enabled,false);
  assert.deepEqual((await guest.call('/api/watch/rooms')).value.rooms,[]);
  assert.equal((await guest.call('/api/watch/rooms/'+roomId+'?viewer='+randomUUID())).status,403);
  assert.equal((await guest.call('/api/watch/library?room='+roomId)).status,403);
  assert.equal((await guest.call('/api/watch/library?room=missing')).status,403);
  assert.equal((await guest.call('/api/watch/library?session='+roomId)).status,403);
  assert.equal((await guest.call('/api/watch/library')).status,200,'lobby reads do not grant room control');
  host.ws.close();guest.ws.close();
});
test('watch socket pushes shared Engine commands, rejects stale/foreign viewers, hides private rooms and revokes consent on disconnect',tls,async t=>{
  const f=await fixture(t),host=await f.connect(await f.login('host'));let guest=await f.connect(await f.login('guest'));
  const roomId=(await host.call('/api/watch/rooms',{})).value.id,viewer=randomUUID(),guestId=randomUUID();
  const target='/api/watch/rooms/'+roomId;
  let state=(await host.call(target+'?viewer='+viewer)).value;
  await guest.call(target+'?viewer='+guestId);
  const command=(client,command,extra={})=>client.call(target+'/command',{epoch:state.epoch,expiresAt:Date.now()+2500,viewerId:viewer,command,...extra});
  assert.equal((await command(guest,{action:'media.pause'})).status,400,'a different account cannot claim the host viewer');
  assert.equal((await command(host,{action:'room.enable',args:{enabled:true}},{expiresAt:Date.now()-1})).status,409);
  const before=guest.events.length;
  assert.equal((await command(host,{action:'room.enable',args:{enabled:true}})).value.status,'applied');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(guest.events.slice(before).some(message=>message.type==='state'&&message.value.enabled),'other viewer receives a pushed state without requesting it');
  state=(await host.call(target+'?viewer='+viewer)).value;
  assert.equal(state.enabled,true);
  const guestClosed=once(guest.ws,'close');guest.ws.close();await guestClosed;await new Promise(resolve=>setTimeout(resolve,30));
  const closed=once(host.ws,'close');host.ws.close();await closed;
  await new Promise(resolve=>setTimeout(resolve,30));
  const room=f.app.watch.rooms.get(roomId);assert.equal(room.s.enabled,false);assert.ok(room.disconnectedViewers.has(viewer));
  const rejoined=await f.connect(await f.login('host'));
  state=(await rejoined.call(target+'?viewer='+viewer)).value;assert.equal(state.enabled,false,'same tab rejoin cannot restore consent');
  guest=await f.connect(await f.login('guest'));await guest.call(target+'?viewer='+guestId);
  assert.equal((await command(rejoined,{action:'room.visibility',args:{visibility:'private'}})).value.status,'applied');
  assert.deepEqual((await guest.call('/api/watch/rooms')).value.rooms,[]);
  assert.equal((await guest.call(target+'?viewer='+guestId)).status,403);
  f.revoke();const denied=once(rejoined.ws,'close');rejoined.ws.send(JSON.stringify({type:'clock',id:999}));assert.equal((await denied)[0],4003);
});

test('watch socket accepts only a viewer\'s current ephemeral synchronization telemetry and preserves its last rating',tls,async t=>{
  const f=await fixture(t),host=await f.connect(await f.login('host')),guest=await f.connect(await f.login('guest'));
  t.after(()=>{host.ws.close();guest.ws.close();});
  const roomId=(await host.call('/api/watch/rooms',{})).value.id,hostViewer=randomUUID(),guestViewer=randomUUID(),path='/api/watch/rooms/'+roomId;
  await host.call(path+'?viewer='+hostViewer);await guest.call(path+'?viewer='+guestViewer);
  const room=f.app.watch.rooms.get(roomId),hostPresence=room.viewers.get(hostViewer);
  const mediaVersion=room.mediaVersion,streamVersion=randomUUID();hostPresence.streamVersion=streamVersion;
  host.ws.send(JSON.stringify({type:'sync-quality',roomId,viewerId:hostViewer,mediaVersion,streamVersion,status:'playing',score:1.5,confidence:'confident',measurementFreshnessMs:300}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(hostPresence.syncQuality.score,1,'valid scores are clamped');assert.equal(hostPresence.syncQuality.lastKnownScore,1);
  assert.equal(hostPresence.syncQuality.lastKnownLevel,'excellent');
  assert.equal(hostPresence.syncQuality.confidence,'confident');assert.ok(hostPresence.syncQuality.measurementFreshnessMs>=300);
  const firstMeasuredAt=hostPresence.syncQuality.measuredAt,firstKnownAt=hostPresence.syncQuality.lastKnownAt;
  await host.call(path+'?viewer='+hostViewer);
  assert.equal(hostPresence.syncQuality.score,1,'the current viewer retains its ephemeral score');
  assert.equal(Object.hasOwn(room.s,'syncQuality'),false,'the score is separate from durable room state');
  const guestClosed=once(guest.ws,'close');
  guest.ws.send(JSON.stringify({type:'sync-quality',roomId,viewerId:hostViewer,mediaVersion,streamVersion,status:'playing',score:.1}));
  assert.equal((await guestClosed)[0],4003,'a viewer cannot claim another viewer identity');
  assert.equal(hostPresence.syncQuality.score,1,'the foreign update did not change the owner score');
  await new Promise(resolve=>setTimeout(resolve,550));
  host.ws.send(JSON.stringify({type:'sync-quality',roomId,viewerId:hostViewer,mediaVersion,streamVersion,status:'paused',reason:'paused'}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(hostPresence.syncQuality.status,'paused');assert.equal(hostPresence.syncQuality.score,1);
  assert.equal(hostPresence.syncQuality.lastKnownScore,1,'temporary unavailability preserves the last score');
  assert.equal(hostPresence.syncQuality.lastKnownLevel,'excellent');assert.equal(hostPresence.syncQuality.confidence,'reduced');
  assert.equal(hostPresence.syncQuality.measuredAt,firstMeasuredAt);
  assert.equal(hostPresence.syncQuality.lastKnownAt,firstKnownAt,'reporting a retained score must not refresh evidence time');
});

test('watch socket rejects cross-origin upgrades, missing CSRF/cookies and invalid credentials',tls,async t=>{
  const f=await fixture(t);
  const foreign=new WebSocket(f.config.publicUrl.replace('https:','wss:')+'/watch-socket',{ca:f.cert,origin:'https://elsewhere.invalid'});
  foreign.on('error',()=>{});await new Promise(resolve=>foreign.once('close',resolve));
  for(const auth of [{type:'auth',token:'a'.repeat(64)},{type:'auth',csrf:'b'.repeat(64)}]){
    const ws=new WebSocket(f.config.publicUrl.replace('https:','wss:')+'/watch-socket',{ca:f.cert,origin:f.config.publicUrl});
    await once(ws,'open');const closed=once(ws,'close');ws.send(JSON.stringify(auth));assert.equal((await closed)[0],4003);
  }
});

test('cookie socket authentication requires CSRF and logout invalidates the active connection',tls,async t=>{
  const f=await fixture(t);
  const http=(route,headers={},data)=>new Promise((resolve,reject)=>{
    const req=https.request(f.config.publicUrl+route,{ca:f.cert,method:data===undefined?'GET':'POST',headers:{Origin:f.config.publicUrl,'Content-Type':'application/json',...headers}},res=>{
      let raw='';res.on('data',bytes=>raw+=bytes);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw,value:res.headers['content-type']?.includes('json')?JSON.parse(raw):undefined}));
    });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
  });
  const begin=await http('/auth/discord'),state=new URL(begin.headers.location).searchParams.get('state');
  const auth=await http('/auth/callback?code=fixture&state='+state,{Cookie:begin.headers['set-cookie'][0].split(';')[0]});
  const cookie=auth.headers['set-cookie'][0].split(';')[0],identity=(await http('/api/watch/me',{Cookie:cookie})).value;
  const bad=new WebSocket(f.config.publicUrl.replace('https:','wss:')+'/watch-socket',{ca:f.cert,origin:f.config.publicUrl,headers:{Cookie:cookie}});
  await once(bad,'open');const closed=once(bad,'close');bad.send(JSON.stringify({type:'auth',csrf:'wrong'}));assert.equal((await closed)[0],4003);
  const good=await f.connect(identity,f.config.publicUrl,cookie);
  const created=await good.call('/api/watch/rooms',{});assert.equal(created.status,201);
  const clientId=f.config.clientId;f.config.clientId='</script><script>bootstrapInjection()</script>&\u2028';
  const page=await http('/watch',{Cookie:cookie});
  const initial=JSON.parse(/<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(page.raw)[1]);
  assert.equal(page.headers['cache-control'],'no-store','Personalized bootstrap cannot be shared by caches');
  assert.equal(initial.me.value.csrf,identity.csrf);assert.equal(initial.me.status,200);
  assert.equal(initial.config.clientId,f.config.clientId);assert.ok(!page.raw.includes(f.config.clientId),'Embedded JSON escapes script delimiters and separators');
  f.config.clientId=clientId;
  assert.ok(initial.rooms.value.rooms.some(room=>room.id===created.value.id),'Page embeds authorized active rooms');
  const signedOut=await http('/watch');
  const publicInitial=JSON.parse(/<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(signedOut.raw)[1]);
  assert.equal(publicInitial.me.status,401);assert.equal(publicInitial.rooms,undefined,'Signed-out pages never embed room data');
  assert.equal((await http('/api/logout',{Cookie:cookie,'X-CSRF-Token':identity.csrf},{})).status,200);
  const revoked=once(good.ws,'close');good.ws.send(JSON.stringify({type:'clock',id:100}));assert.equal((await revoked)[0],4003);
});

test('retired HTTP room controls and legacy library room queries cannot mutate room state',tls,async t=>{
  const f=await fixture(t),identity=await f.login('host'),host=await f.connect(identity);
  const roomId=(await host.call('/api/watch/rooms',{})).value.id;
  const http=(path,data)=>new Promise((resolve,reject)=>{
    const req=https.request(f.config.publicUrl+path,{ca:f.cert,method:data===undefined?'GET':'POST',headers:{Origin:f.config.publicUrl,Authorization:'Bearer '+identity.token,'Content-Type':'application/json'}},res=>{
      let raw='';res.on('data',bytes=>raw+=bytes);res.on('end',()=>resolve({status:res.statusCode,raw}));
    });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
  });
  for (const [path,data] of [['/api/sessions'],['/api/rooms'],['/api/command',{roomId,command:{action:'room.enable'}}],['/api/watch/rooms'],['/api/watch/rooms',{}],['/api/watch/admin-mode',{enabled:true}],['/api/watch/rooms/'+roomId+'?viewer='+randomUUID()],['/api/watch/rooms/'+roomId+'/close',{}],['/api/watch/rooms/'+roomId+'/ready',{}],['/api/watch/rooms/'+roomId+'/observe',{}],['/api/watch/rooms/'+roomId+'/leave',{}],['/api/watch/rooms/'+roomId+'/command',{}]]) {
    assert.equal((await http(path,data)).status,404,path+' was retired');
  }
  assert.equal(f.app.watch.rooms.size,1);assert.equal(f.app.watch.rooms.get(roomId).viewers.size,0);assert.equal(f.app.hub.adminMode,false);
  assert.equal((await http('/api/watch/config')).status,200);assert.equal((await http('/api/watch/me')).status,200);
  assert.equal((await http('/api/watch/library?session='+roomId)).status,403);
  assert.equal((await http('/api/watch/library?room='+roomId)).status,200);
  assert.equal((await host.call('/api/command',{sessionId:roomId,command:{action:'room.enable'}})).status,400);
  const state=(await host.call('/api/watch/rooms/'+roomId+'?viewer='+randomUUID())).value;
  assert.equal((await host.call('/api/watch/rooms/'+roomId+'/command',{epoch:state.epoch,expiresAt:Date.now()+2500,command:{action:'session.enable'}})).value.status,'unsupported');
  assert.equal(f.app.watch.rooms.get(roomId).s.enabled,false);
});
