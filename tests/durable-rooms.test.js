'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), https = require('node:https');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server/app');
const { controlClient } = require('./helpers/control-client');
const certFile = path.join(__dirname,'../certs/server-cert.pem');
const tls = {skip:!fs.existsSync(certFile)};

test('Discord scheduled events preserve explicit times and consent across closure/restart, reject stale edits and recover uncertain creation',tls,async t=>{
  const {eventTime}=require('../server/event-time');
  assert.equal(eventTime('2030-01-11T20:00','America/New_York'),'2030-01-12T01:00:00.000Z');
  assert.throws(()=>eventTime('2030-03-10T02:30','America/New_York'),/does not exist/);
  assert.throws(()=>eventTime('2030-11-03T01:30','America/New_York'),/occurs twice/);
  const f=await fixture(t,true,{shareChannelId:'100000000000000050'}),creator=await f.login('host'),viewer=await f.login('guest');
  const remote=require('./helpers/discord-channel').discordChannel(f.config);remote.attach(f.app.hub);
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,root='/api/watch/rooms/'+id;
  await creator.call(root+'?viewer='+randomUUID());await viewer.call(root+'?viewer='+randomUUID());
  const planned={title:'Planned watch night',description:'Bring popcorn',startLocal:new Date(Date.now()+2*86400000).toISOString().slice(0,16),
    endLocal:new Date(Date.now()+2*86400000+7200000).toISOString().slice(0,16),timeZone:'UTC'};
  const schedule=async(client,action='room.event.create',extra={})=>client.call(root+'/events',{action,...planned,...extra});
  assert.equal((await schedule(viewer)).body.status,'forbidden');assert.equal(remote.events.size,0);
  remote.channel.eventPermitted=false;assert.notEqual((await schedule(creator)).body.status,'applied');remote.channel.eventPermitted=true;
  await f.app.watch.remove(id);
  assert.equal((await schedule(creator)).body.status,'applied','a closed saved room can be scheduled');
  assert.equal(f.app.watch.rooms.has(id),false,'scheduling never opens a room');
  assert.equal(remote.events.size,1);
  const native=[...remote.events.values()][0];assert.equal(native.name,planned.title);assert.equal(native.scheduledStartTimestamp,Date.parse(planned.startLocal+'Z'));
  await f.restart();remote.attach(f.app.hub);const returning=await f.login('host');
  await f.app.watch.events.reconcile();assert.equal(remote.events.size,1);assert.equal(f.app.watch.rooms.has(id),false);
  const edit=async change=>returning.call(root+'/settings',{revision:(await returning.call(root+'/settings')).body.revision,change});
  await edit({action:'invite.reroll'});await f.app.watch.events.reconcile();
  assert.ok(native.entityMetadata.location.endsWith(f.app.watch.roomState.store.get(id).inviteCode));
  const stale=(await returning.call(root+'/events')).body.events[0];native.name='Changed in Discord';
  const args={action:'room.event.edit',revision:(await returning.call(root+'/settings')).body.revision,...planned,eventKey:stale.key,eventVersion:stale.eventVersion};
  assert.notEqual((await returning.call(root+'/events',args)).body.status,'applied');assert.equal(native.name,'Changed in Discord');
  const current=(await returning.call(root+'/events')).body.events[0];
  await edit({action:'rename',name:'Changed while editing an event',isCustom:true});
  await edit({action:'invite.reroll'});await f.app.watch.events.reconcile();
  const automatic=(await returning.call(root+'/events')).body.events[0];
  assert.equal(automatic.eventVersion,current.eventVersion,'automatic invite updates do not conflict with event details');
  assert.equal((await returning.call(root+'/events',{...args,eventVersion:current.eventVersion,title:'Updated watch night'})).body.status,'applied');
  assert.ok(native.entityMetadata.location.endsWith(f.app.watch.roomState.store.get(id).inviteCode));
  const updated=(await returning.call(root+'/events')).body.events[0];
  await edit({action:'rename',name:'Room changed after event edit',isCustom:true});
  native.name='Event changed again';
  remote.channel.eventRateLimit={remaining:1,wait:50};
  const eventConfig=f.app.watch.events.config;
  f.app.watch.events.config={...eventConfig,publicUrl:'https://'+ 'x'.repeat(110)+'.invalid'};
  try {
    assert.equal((await returning.call(root+'/events',{action:'room.event.cancel',revision:args.revision,eventKey:updated.key,eventVersion:updated.eventVersion})).body.status,'applied','cancellation does not validate an unused invite URL');
  } finally {f.app.watch.events.config=eventConfig;}
  assert.equal(native.status,4);assert.equal(f.app.watch.events.forRoom(id).length,0);
  assert.equal((await schedule(returning,'room.event.create',{title:'First event at this time',revision:args.revision})).body.status,'applied','an old room revision does not block scheduling');
  assert.equal((await schedule(returning,'room.event.create',{title:'Second event at this time'})).body.status,'applied','two events can share a start time');
  for(const event of (await returning.call(root+'/events')).body.events) {
    assert.equal((await returning.call(root+'/events',{action:'room.event.cancel',eventKey:event.key})).body.status,'applied');
  }
  assert.equal(f.app.watch.events.forRoom(id).length,0);
  remote.channel.loseEventReceipt=true;
  assert.notEqual((await returning.call(root+'/events',{...planned,action:'room.event.create'})).body.status,'applied');
  const recovered=(await returning.call(root+'/events')).body.events;
  assert.equal(recovered.length,1);assert.ok(recovered[0].eventId);
  const creations=remote.calls.filter(call=>call.method==='event-create').length;
  await f.app.watch.events.reconcile();assert.equal(remote.calls.filter(call=>call.method==='event-create').length,creations);
  remote.channel.eventRateLimit={remaining:1,wait:9000};
  assert.equal((await returning.call(root+'/events',{action:'room.event.cancel',eventKey:recovered[0].key})).body.status,'applied');
  const pending=(await returning.call(root+'/events')).body;
  assert.equal(pending.available,true,'a rate limit does not become a disconnected bot');assert.equal(pending.events[0].cancel,true);
  await f.app.watch.events.reconcile();assert.equal(f.app.watch.events.forRoom(id).length,0,'accepted cancellation completes without reopening Share');
});

test('lobby watch nights follow room visibility and scheduler tier, keep their room and survive restart',tls,async t=>{
  const f=await fixture(t,true,{shareChannelId:'100000000000000050',events:{schedulers:'trusted'},trustedMembers:{discord:['100000000000000002'],plex:[],discordRoles:[]}});
  const remote=require('./helpers/discord-channel').discordChannel(f.config);remote.attach(f.app.hub);
  f.roleUsers.delete(f.subjects.guest2);
  const trusted=await f.login('guest'),member=await f.login('guest2');
  const at=hours=>new Date(Date.now()+hours*3600000).toISOString().slice(0,16);
  const night=(extra={})=>({title:'Movie night',description:'',startLocal:at(48),endLocal:at(50),timeZone:'UTC',...extra});
  const lobby=(await member.call('/api/watch/events')).body;assert.equal(lobby.canSchedule,false,JSON.stringify(lobby));
  assert.equal((await member.call('/api/watch/events',{room:'new',...night()})).body.status,'forbidden','members below the tier cannot schedule');
  const rooms=()=>f.app.watch.roomState.store.db.prepare('SELECT COUNT(*) AS n FROM watch_rooms').get().n,before=rooms();
  assert.equal((await trusted.call('/api/watch/events',{room:'new',...night({startLocal:at(-1)})})).body.status,'failed');
  assert.equal(rooms(),before,'a rejected form leaves no room behind');
  const created=(await trusted.call('/api/watch/events',{room:'new',discord:false,...night()})).body;
  assert.equal(created.status,'applied');assert.equal(remote.events.size,0,'posting to Discord is optional');
  assert.equal(f.app.watch.rooms.has(created.roomId),false,'scheduling never opens a room');
  const record=f.app.watch.roomState.store.get(created.roomId);
  assert.equal(record.name,'Movie night');assert.equal(f.app.watch.roomState.reason(record),'Event scheduled');
  await f.app.watch.roomState.deleteEmpty(created.roomId);assert.ok(f.app.watch.roomState.store.get(created.roomId),'an upcoming event keeps its room');
  const listed=(await member.call('/api/watch/events')).body.events;
  assert.equal(listed.length,1);assert.equal(listed[0].canManage,false);assert.equal(listed[0].invite,undefined);
  await trusted.call('/api/watch/rooms/'+created.roomId+'/settings',{revision:record.revision,change:{action:'visibility',visibility:'private'}});
  assert.equal((await member.call('/api/watch/events')).body.events.length,0,'private room events are hidden from people outside the room');
  const mine=(await trusted.call('/api/watch/events')).body.events[0];assert.equal(mine.canEdit,true);assert.ok(mine.invite.endsWith(record.inviteCode));
  assert.equal((await trusted.call('/api/watch/rooms/'+created.roomId+'/events',{action:'room.event.edit',...night({title:'Double feature',discord:true}),eventKey:mine.key,eventVersion:mine.eventVersion})).body.status,'applied');
  const native=[...remote.events.values()][0];assert.equal(native.name,'Double feature','an edit can post the event to Discord');
  native.userCount=4;await f.app.watch.events.reconcile();
  await f.restart();remote.attach(f.app.hub);
  const after=(await (await f.login('guest')).call('/api/watch/events')).body.events;
  assert.equal(after.length,1);assert.equal(after[0].discord.interested,4,'the Discord interested count is kept');
  f.app.watch.events.db.prepare('UPDATE watch_room_events SET start=?,end=?').run(new Date(Date.now()-7200000).toISOString(),new Date(Date.now()-60000).toISOString());
  await f.app.watch.events.reconcile();
  assert.equal((await (await f.login('host')).call('/api/watch/events')).body.events.length,0,'an ended event leaves the lobby');
  assert.equal(f.app.watch.roomState.reason(f.app.watch.roomState.store.get(created.roomId)),null);
});

test('explicit Discord publication uses current room details, enforces host authority and preserves stable posts across restart',tls,async t=>{
  const f=await fixture(t,true,{shareChannelId:'100000000000000050'});
  const remote=require('./helpers/discord-channel').discordChannel(f.config);remote.attach(f.app.hub);
  const creator=await f.login('host'),host=await f.login('guest');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true,name:'Movie night'})).body.id,root='/api/watch/rooms/'+id;
  await creator.call(root+'?viewer='+randomUUID());await host.call(root+'?viewer='+randomUUID());
  const share=async(client,action='room.publish',preview)=>(client.call(root+'/share',{action,...(preview||((await client.call(root+'/share')).body.preview))}));
  const edit=async change=>creator.call(root+'/settings',{revision:(await creator.call(root+'/settings')).body.revision,change});
  assert.equal((await share(host)).body.status,'forbidden');assert.equal(remote.calls.length,0);
  await edit({action:'host.add',userId:(await host.call('/api/watch/me')).body.account.id});
  await edit({action:'permissions',role:'host',permissions:{roomSettings:false}});
  const stale=(await host.call(root+'/share')).body.preview;
  await creator.call(root+'?viewer='+randomUUID());
  f.app.watch.invalidateControls(f.app.watch.rooms.get(id));
  await edit({action:'rename',name:'Updated movie night',isCustom:true});
  remote.channel.beforeFetch=async()=>{
    remote.channel.beforeFetch=undefined;
    await edit({action:'rename',name:'Changed during publishing',isCustom:true});
    await edit({action:'invite.reroll'});
    f.app.watch.invalidateControls(f.app.watch.rooms.get(id));
  };
  assert.equal((await share(host,'room.publish',stale)).body.status,'applied','a host with Room settings disabled can publish after joins, settings and playback changes');
  const messageId=[...remote.messages.keys()][0];
  assert.equal(remote.messages.get(messageId).embeds[0].title,'Changed during publishing');
  assert.ok(remote.messages.get(messageId).components[0].components[0].url.endsWith(f.app.watch.roomState.store.get(id).inviteCode));
  assert.equal((await creator.call(root+'/share',{action:'room.publish'})).body.status,'applied','publishing needs no preview snapshot');
  await share(creator);assert.equal(remote.calls.filter(call=>call.method==='send').length,1,'publishing twice edits the same message');
  const oldPreview=(await host.call(root+'/share')).body.preview;
  await creator.call(root+'?viewer='+randomUUID());
  f.app.watch.invalidateControls(f.app.watch.rooms.get(id));
  await edit({action:'rename',name:'Changed after opening Share',isCustom:true});
  remote.channel.deleteRateLimit={remaining:1,wait:50};
  assert.equal((await share(creator,'room.unpublish',oldPreview)).body.status,'applied','room and playback changes do not block post removal');
  assert.equal(remote.messages.has(messageId),false);
  await share(creator);
  const currentMessageId=[...remote.messages.keys()][0];
  await edit({action:'visibility',visibility:'private'});
  await edit({action:'invite.reroll'});await f.app.watch.publications.reconcile();
  assert.match(remote.messages.get(currentMessageId).components[0].components[0].url,new RegExp(f.app.watch.roomState.store.get(id).inviteCode+'$'));
  await f.restart();remote.attach(f.app.hub);
  const returning=await f.login('host');await returning.call(root+'?viewer='+randomUUID());
  await f.app.watch.publications.reconcile();
  assert.equal(f.app.watch.publications.records.get(id).messageId,currentMessageId);
  assert.equal(remote.calls.filter(call=>call.method==='send').length,2);
  await f.app.watch.remove(id);await f.app.watch.publications.reconcile();
  const closed=remote.messages.get(currentMessageId);assert.deepEqual(closed.components,[]);assert.equal(closed.embeds[0].fields[0].value,'Closed');
  assert.notEqual((await share(returning,'room.publish',stale)).body.status,'applied','a closed room cannot be published');
  await returning.call(root+'/reopen',{});await f.app.watch.publications.reconcile();
  assert.deepEqual(remote.messages.get(currentMessageId).components,[],'reopening does not republish');
  assert.equal((await share(returning)).body.status,'applied');assert.equal(remote.messages.size,1);
  remote.channel.offline=true;
  assert.notEqual((await share(returning,'room.unpublish')).body.status,'applied');
  assert.equal((await returning.call(root+'/share')).body.removing,true,'offline removal is retained and reported as pending');
  remote.channel.offline=false;await f.app.watch.publications.reconcile();assert.equal(remote.messages.size,0);
  await share(returning);await f.app.watch.remove(id);
  assert.equal((await share(returning,'room.unpublish')).body.status,'applied','a host can remove the closed room card without reopening');
  assert.equal(remote.messages.size,0);
});

test('Discord publication fences revoked authority, rejects unsafe destinations and reconciles a lost create receipt without duplication',tls,async t=>{
  const f=await fixture(t,false,{shareChannelId:'100000000000000050'}),creator=await f.login('host'),host=await f.login('guest');
  const remote=require('./helpers/discord-channel').discordChannel(f.config);remote.attach(f.app.hub);
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,root='/api/watch/rooms/'+id;
  await creator.call(root+'?viewer='+randomUUID());await host.call(root+'?viewer='+randomUUID());
  const hostId=(await host.call('/api/watch/me')).body.account.id;
  const edit=async change=>creator.call(root+'/settings',{revision:(await creator.call(root+'/settings')).body.revision,change});
  await edit({action:'host.add',userId:hostId});
  const dispatch=async client=>{const p=(await client.call(root+'/share')).body.preview;return client.call(root+'/share',{action:'room.publish',epoch:p.epoch,revision:p.revision});};
  assert.equal((await creator.call('/api/command',{roomId:id,command:{action:'room.publish',expiresAt:Date.now()-1}})).body.status,'unavailable');
  assert.equal(remote.messages.size,0,'expired publication cannot post');
  remote.channel.guildId='another-guild';assert.notEqual((await dispatch(creator)).body.status,'applied');assert.equal(remote.messages.size,0);remote.channel.guildId=f.config.guildId;
  const preview=(await host.call(root+'/share')).body.preview;
  remote.channel.beforeFetch=async()=>{remote.channel.beforeFetch=undefined;await edit({action:'host.remove',userId:hostId});};
  assert.notEqual((await host.call(root+'/share',{action:'room.publish',epoch:preview.epoch,revision:preview.revision})).body.status,'applied');assert.equal(remote.messages.size,0);
  remote.channel.loseReceipt=true;
  assert.notEqual((await dispatch(creator)).body.status,'applied');assert.equal(remote.messages.size,1);
  assert.equal((await dispatch(creator)).body.status,'applied');assert.equal(remote.messages.size,1);
  assert.equal(remote.calls.filter(call=>call.method==='send').length,1);
  const messageId=[...remote.messages.keys()][0];remote.messages.delete(messageId);
  await edit({action:'rename',name:'Changed title',isCustom:true});await f.app.watch.publications.reconcile();
  assert.equal(f.app.watch.publications.records.has(id),false,'a manually deleted post is not recreated');
  const finalPreview=(await creator.call(root+'/share')).body.preview;
  remote.channel.beforeSend=async()=>{remote.channel.beforeSend=undefined;await f.app.watch.remove(id);};
  assert.notEqual((await creator.call(root+'/share',{action:'room.publish',epoch:finalPreview.epoch,revision:finalPreview.revision})).body.status,'applied');
  await f.app.watch.publications.reconcile();
  assert.deepEqual([...remote.messages.values()][0].components,[],'closure during an external send cannot leave an active Join');
});

test('Discord room posters expose only bounded cached artwork for the active publication and current media',tls,async t=>{
  const f=await fixture(t,false,{shareChannelId:'100000000000000050'}),creator=await f.login('host');
  const remote=require('./helpers/discord-channel').discordChannel(f.config);remote.attach(f.app.hub);
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,root='/api/watch/rooms/'+id;
  await creator.call(root+'?viewer='+randomUUID());
  const room=f.app.watch.rooms.get(id),actor=[...room.viewers.values()][0].actor;
  const image=Buffer.from('fixture-image-bytes');let reads=0,allowed=true;
  const originalPlexFor=f.app.hub.plexFor;
  f.app.hub.plexFor=async()=>({allows:async()=>allowed,artwork:async()=>{reads++;return {type:'image/png',bytes:image};}});
  room.media={id:'42',title:'Poster movie',kind:'plex',format:'unavailable',unavailable:true,duration:60,resources:new Map(),roomServerId:'fixture-server',source:{type:'movie'}};
  const get=url=>new Promise((resolve,reject)=>https.get(url,{ca:f.cert},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,bytes:Buffer.concat(chunks),type:response.headers['content-type']}));}).on('error',reject));
  try {
    await f.app.watch.publications.refreshPoster(id,actor);
    const before=f.app.watch.publications.posterUrl(id);assert.ok(before);assert.equal((await get(before)).status,404,'unpublished artwork is not public');
    const preview=(await creator.call(root+'/share')).body.preview;
    assert.equal((await creator.call(root+'/share',{action:'room.publish',epoch:preview.epoch,revision:preview.revision})).body.status,'applied');
    const message=[...remote.messages.values()][0],url=message.embeds[0].thumbnail.url;
    assert.equal(new URL(url).origin,f.config.publicUrl);assert.ok(!url.includes('token'));
    const result=await get(url);assert.equal(result.status,200);assert.deepEqual(result.bytes,image);assert.equal(result.type,'image/png');
    const calls=reads;await get(url);assert.equal(reads,calls,'anonymous image requests never call Plex');
    assert.equal((await get(url.replace(/.$/,'z'))).status,404);
    room.media={...room.media,id:'43'};assert.equal((await get(url)).status,404,'the previous title cannot serve a new title poster');
    await f.app.watch.publications.reconcile();const next=message.embeds[0].thumbnail.url;assert.notEqual(next,url);assert.equal((await get(next)).status,200);
    room.media={...room.media,id:'44'};allowed=false;
    await f.app.watch.publications.reconcile();assert.equal(message.embeds[0].thumbnail,undefined,'denied artwork has no implicit provider fallback');
    allowed=true;
    assert.equal((await creator.call(root+'/share',{action:'room.unpublish'})).body.status,'applied');
    assert.equal((await get(next)).status,404,'removal revokes the cached artwork URL');
  } finally {room.media=undefined;f.app.hub.plexFor=originalPlexFor;}
});

test('kick permission protects leader/self/hosts, removes every target tab, fences stale subscriptions and allows manual rejoining',tls,async t=>{
  const f=await fixture(t),creator=await f.login('host'),host=await f.login('guest'),viewer=await f.login('guest2');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,root='/api/watch/rooms/'+id;
  const creatorId=(await creator.call('/api/watch/me')).body.account.id;
  const hostId=(await host.call('/api/watch/me')).body.account.id;
  const viewerId=(await viewer.call('/api/watch/me')).body.account.id;
  await creator.call(root+'?viewer='+randomUUID());await host.call(root+'?viewer='+randomUUID());
  const tabs=[randomUUID(),randomUUID()];for(const tab of tabs)assert.equal((await viewer.call(root+'?viewer='+tab)).status,200);
  const edit=async change=>{const current=await creator.call(root+'/settings');return creator.call(root+'/settings',{revision:current.body.revision,change});};
  const kick=(client,userId)=>client.call('/api/command',{roomId:id,command:{action:'room.kick',args:{userId}}});
  assert.equal((await kick(viewer,hostId)).body.status,'forbidden');
  assert.equal((await edit({action:'host.add',userId:hostId})).status,200);
  assert.equal((await kick(host,creatorId)).body.status,'forbidden');
  assert.equal((await kick(host,hostId)).body.status,'forbidden');
  await edit({action:'host.add',userId:viewerId});
  assert.equal((await kick(host,viewerId)).body.status,'forbidden');
  await edit({action:'host.remove',userId:viewerId});
  await edit({action:'permissions',role:'host',permissions:{kickParticipants:false}});
  assert.equal((await kick(host,viewerId)).body.status,'forbidden');
  await edit({action:'permissions',role:'host',permissions:{kickParticipants:true}});
  assert.equal((await kick(host,viewerId)).body.status,'applied');
  const room=f.app.watch.rooms.get(id);
  assert.equal([...room.viewers.values()].some(person=>person.userId===viewerId),false);
  for(const tab of tabs)assert.equal((await viewer.call(root+'?viewer='+tab)).status,403);
  const replacement=randomUUID();assert.equal((await viewer.call(root+'?viewer='+replacement)).status,200);
  assert.equal((await kick(creator,hostId)).body.status,'applied');
  assert.equal(room.viewers.get(replacement).userId,viewerId);
  await host.call(root+'?viewer='+randomUUID());
  assert.equal((await viewer.call('/api/watch/admin-mode',{enabled:true})).status,200);
  assert.equal((await kick(viewer,hostId)).body.status,'applied','active admin may remove hosts');
  assert.equal((await kick(viewer,creatorId)).body.status,'forbidden','even an admin cannot kick the leader');
  await viewer.call('/api/watch/admin-mode',{enabled:false});
  assert.equal((await creator.call('/api/command',{roomId:id,command:{action:'room.kick',args:{userId:'invalid'}}})).body.status,'unsupported');
});

test('privacy changes remove viewers, reconnect reservations and readiness waiters even in Everyone is host mode',tls,async t=>{
  const f=await fixture(t),creator=await f.login('host'),guest=await f.login('guest');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,root='/api/watch/rooms/'+id;
  const a=randomUUID(),b=randomUUID();
  await creator.call(root+'?viewer='+a);await guest.call(root+'?viewer='+b);
  const edit=async change=>{const current=await creator.call(root+'/settings');return creator.call(root+'/settings',{revision:current.body.revision,change});};
  await edit({action:'allHosts',enabled:true});
  const room=f.app.watch.rooms.get(id),guestId=(await guest.call('/api/watch/me')).body.account.id;
  room.initialViewers.add(b);
  room.disconnectedViewers.set(randomUUID(),{userId:guestId,expires:Date.now()+60000,mediaVersion:room.mediaVersion});
  // The header uses the shared Engine command; settings uses the durable edit.
  for(const header of [true,false]) {
    const result=header?await command(creator,id,a,'room.visibility',{visibility:'private'}):await edit({action:'visibility',visibility:'private'});
    assert.equal(result.status,200);
    assert.equal(room.s.visibility,'private');
    assert.equal([...room.viewers.values()].some(v=>v.userId===guestId),false);
    assert.equal(room.initialViewers.has(b),false);
    assert.equal([...room.disconnectedViewers.values()].some(v=>v.userId===guestId),false);
    assert.equal((await creator.call(root+'?viewer='+a)).body.viewers,1);
    assert.deepEqual((await guest.call('/api/watch/rooms')).body.rooms,[]);
    assert.equal((await guest.call(root+'?viewer='+b)).status,403);
    await edit({action:'visibility',visibility:'public'});
    assert.equal((await guest.call(root+'?viewer='+b)).status,200);
  }
});

test('room-scoped People search and pending hosts recheck authority and activate only on provider sign-in',tls,async t=>{
  const f=await fixture(t),creator=await f.login('host');
  const id=(await creator.call('/api/watch/rooms',{name:'Host directory',keepEmpty:true})).body.id;
  const root='/api/watch/rooms/'+id;
  const edit=async(client,change)=>{const current=await creator.call(root+'/settings');return client.call(root+'/settings',{revision:current.body.revision,change});};
  f.app.hub.directory.discord=async()=>[{subject:f.subjects.guest,name:'Future guest'}];
  const count=f.app.registry.directory().length;
  const found=await creator.call(root+'/people?q=Future');assert.equal(found.status,200);assert.equal(found.body.results[0].userId,undefined);
  assert.equal((await edit(creator,{action:'host.pending.add',provider:'discord',subject:f.subjects.guest,name:'Forged name'})).status,200);
  assert.equal(f.app.registry.directory().length,count);
  assert.equal(f.app.watch.roomState.store.pendingHosts(id)[0].name,'Future guest','Provider label is authoritative');
  const guest=await f.login('guest');
  const me=await guest.call('/api/watch/me');assert.equal(me.status,200);
  assert.equal(f.app.watch.roomState.store.pendingHosts(id).length,0);
  assert.ok(f.app.watch.roomState.store.get(id).hosts.includes(me.body.account.id));
  assert.equal((await guest.call(root+'/people?q=Demo')).status,403);
  assert.equal((await edit(creator,{action:'permissions',role:'host',permissions:{addHosts:true}})).status,200);
  assert.equal((await guest.call(root+'/people?q=Demo')).status,200);
  assert.equal((await edit(guest,{action:'host.remove',userId:me.body.account.id})).status,403);
  // Suspend an external lookup, then revoke the caller's delegation while it waits.
  let entered,finish;
  const waiting=new Promise(resolve=>entered=resolve), release=new Promise(resolve=>finish=resolve);
  f.app.hub.directory.cache.clear();
  f.app.hub.directory.discord=async()=>{entered();await release;return [];};
  const search=guest.call(root+'/people?q=Demo');await waiting;
  await edit(creator,{action:'permissions',role:'host',permissions:{addHosts:false}});finish();
  assert.equal((await search).status,403);
});

test('editable canonical names propagate through existing browser/Activity sockets without account revision changes',tls,async t=>{
  const f=await fixture(t),creator=await f.login('host');
  const before=(await creator.call('/api/watch/me')).body;
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id;
  await creator.call('/api/watch/rooms/'+id+'?viewer='+randomUUID());
  const updated=await creator.call('/api/watch/profile',{name:'Chosen name'});assert.equal(updated.status,200);
  const after=(await creator.call('/api/watch/me')).body;
  assert.equal(after.name,'Chosen name');assert.equal(after.account.name,'Chosen name');
  assert.equal(after.account.id,before.account.id);assert.equal(after.account.revision,before.account.revision);
  assert.equal((await creator.call('/api/watch/rooms')).body.rooms[0].hostName,'Chosen name');
  assert.equal((await creator.call('/api/watch/profile',{name:'\u202eHidden'})).status,400);
});

test('All hosts and pending assignments persist over restart without promoting arbitrary users into private rooms',tls,async t=>{
  const f=await fixture(t,true),creator=await f.login('host');
  const id=(await creator.call('/api/watch/rooms',{name:'Persistent roles',visibility:'private',keepEmpty:true,permissions:{allHosts:true}})).body.id;
  f.app.hub.directory.discord=async()=>[{subject:'100000000000000088',name:'Future'}];
  let settings=(await creator.call('/api/watch/rooms/'+id+'/settings')).body;
  assert.equal((await creator.call('/api/watch/rooms/'+id+'/settings',{revision:settings.revision,change:{action:'host.pending.add',provider:'discord',subject:'100000000000000088'}})).status,200);
  await f.restart();
  const leader=await f.login('host'),guest=await f.login('guest');
  settings=(await leader.call('/api/watch/rooms/'+id+'/settings')).body;
  assert.equal(settings.allHosts,true);assert.equal(settings.pendingHosts.length,1);assert.deepEqual(settings.hosts,[]);
  assert.equal((await guest.call('/api/watch/rooms/saved')).body.rooms.length,0);
  assert.equal((await guest.call('/api/watch/rooms/'+id+'/settings')).status,403);
  assert.equal((await guest.call('/api/watch/rooms/'+id+'/reopen',{})).status,403);
});

async function fixture(t, disk = false, settings = {}) {
  const cert = fs.readFileSync(certFile), directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-room-live-')) : undefined;
  const subjects = {host:'100000000000000001',guest:'100000000000000002',guest2:'100000000000000003'}, role = '100000000000000099';
  const config = {cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost',
    ownerId:subjects.host,guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:true,demoSubjects:subjects,
    roomAdministrators:{discord:[],plex:[],discordRoles:[role]}, ...settings,
    ...(disk ? {accountFile:path.join(directory,'accounts.sqlite'),credentialKeyFile:path.join(directory,'original.key')} : {})};
  const roleUsers = new Set([subjects.guest2]); let app;
  async function start() {
    app = createApp(config);
    app.hub.access = {isMember:()=>true,refresh:async()=>true,voiceChannel:()=>undefined,validVoiceChannel:()=>false,
      hasRole:(id,requested)=>requested===role&&roleUsers.has(id),options:()=>({available:true})};
    await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl = 'https://localhost:' + app.server.address().port;
  }
  await start();
  const controls = controlClient(t,config,cert);
  t.after(async () => {
    await app.close();
    if (directory) { assert.equal(path.dirname(directory),path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('uburoom-room-live-')); fs.rmSync(directory,{recursive:true,force:true}); }
  });
  async function login(persona) {
    const identity = await new Promise((resolve,reject) => {
      const request = https.request(config.publicUrl + '/api/watch/demo-login',{method:'POST',ca:cert,headers:{Origin:config.publicUrl,'Content-Type':'application/json'}},response => {
        let raw = ''; response.on('data',bytes => raw += bytes); response.on('end',() => resolve(JSON.parse(raw)));
      }); request.on('error',reject); request.end(JSON.stringify({persona}));
    });
    return {call:(route,data)=>controls.request(route,data,{Authorization:'Bearer ' + identity.token})};
  }
  return {get app(){return app;},config,cert,login,roleUsers,subjects,async restart(){await app.close();await start();}};
}
async function command(client, id, viewer, action, args) {
  const response = await client.call('/api/watch/rooms/' + id + '?viewer=' + viewer);
  assert.equal(response.status,200,JSON.stringify(response.body));
  const state = response.body;
  const applied = await client.call('/api/watch/rooms/' + id + '/command',{viewerId:viewer,epoch:state.epoch,expiresAt:Date.now()+2900,command:{action,args}});
  assert.equal(applied.status,200,JSON.stringify(applied.body));
  return applied;
}

test('reopen returns an authorized joined snapshot in one operation and validates viewer input before opening',tls,async t=>{
  const f=await fixture(t),creator=await f.login('host'),guest=await f.login('guest');
  const id=(await creator.call('/api/watch/rooms',{name:'Atomic reopen',keepEmpty:true})).body.id;
  const first=(await creator.call('/api/watch/rooms/'+id+'?viewer='+randomUUID())).body;
  await creator.call('/api/watch/rooms/'+id+'/close',{epoch:first.epoch});
  assert.equal((await creator.call('/api/watch/rooms/'+id+'/reopen',{viewerId:'invalid'})).status,400);
  assert.equal(f.app.watch.rooms.has(id),false,'Invalid viewer cannot open the room');
  assert.equal((await guest.call('/api/watch/rooms/'+id+'/reopen',{viewerId:randomUUID()})).status,403);
  const viewer=randomUUID(),opened=await creator.call('/api/watch/rooms/'+id+'/reopen',{viewerId:viewer,quality:'direct',subtitles:'browser'});
  assert.equal(opened.status,200);assert.equal(opened.body.id,id);assert.equal(opened.body.state.id,id);
  assert.equal(opened.body.state.roomName,'Atomic reopen');
  assert.ok(f.app.watch.rooms.get(id).viewers.has(viewer),'Same operation joins the viewer and creates its authorized state');
});

test('authenticated durable rooms close/reopen and survive a server restart with stable roles, paused progress and fresh epochs',tls,async t => {
  const f = await fixture(t,true), creator = await f.login('host'), host = await f.login('guest');
  const id = (await creator.call('/api/watch/rooms',{name:'Saved fixture room',visibility:'public'})).body.id, viewer = randomUUID();
  await command(creator,id,viewer,'media.load',{mediaId:'demo',quality:'direct'});
  await command(creator,id,viewer,'media.pause');
  await command(creator,id,viewer,'media.seek.absolute',{seconds:23.5});
  let settings = (await creator.call('/api/watch/rooms/' + id + '/settings')).body;
  const hostId = (await host.call('/api/watch/me')).body.account.id;
  settings = (await creator.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'host.add',userId:hostId}})).body;
  const epoch = settings.epoch, creatorId = settings.creator.id;
  assert.equal((await creator.call('/api/watch/rooms/' + id + '/close',{epoch:randomUUID()})).status,409);
  assert.equal((await creator.call('/api/watch/rooms/' + id + '/close',{epoch})).status,200);
  assert.equal(f.app.watch.rooms.size,0);
  assert.equal((await host.call('/api/watch/rooms/saved')).body.rooms[0].name,'Saved fixture room');
  await f.restart();
  const returning = await f.login('guest');
  const results = await Promise.all([returning.call('/api/watch/rooms/' + id + '/reopen',{}),returning.call('/api/watch/rooms/' + id + '/reopen',{})]);
  assert.ok(results.every(result => result.status===200 && result.body.id===id));
  assert.equal(f.app.watch.rooms.size,1);
  const state = (await returning.call('/api/watch/rooms/' + id + '?viewer=' + randomUUID())).body;
  assert.equal(state.state.paused,true); assert.equal(state.state.position,23.5); assert.notEqual(state.epoch,epoch);
  settings = (await returning.call('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal(settings.creator.id,creatorId); assert.equal(settings.hosts[0].id,hostId);
  await returning.call('/api/watch/rooms/' + id + '/close',{epoch:settings.epoch});
  f.app.watch.demoMedia = undefined;
  assert.equal((await returning.call('/api/watch/rooms/' + id + '/reopen',{})).status,409);
  assert.ok(f.app.watch.roomState.store.get(id).bookmark,'unavailable media retains the bookmark');
  settings = (await returning.call('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal((await returning.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'bookmark.clear'}})).status,200);
  assert.equal((await returning.call('/api/watch/rooms/' + id + '/reopen',{})).status,200);
});

test('viewer defaults, private host management, stale edits and host-departure permissions are enforced through room sockets',tls,async t => {
  const f = await fixture(t), creator = await f.login('host'), guest = await f.login('guest');
  const id = (await creator.call('/api/watch/rooms',{name:'Permission room'})).body.id, a = randomUUID(), b = randomUUID();
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
  await guest.call('/api/watch/rooms/' + id + '?viewer=' + b);
  assert.equal((await command(guest,id,b,'media.pause')).body.status,'applied');
  assert.equal((await command(guest,id,b,'media.seek.absolute',{seconds:2})).body.status,'forbidden');
  assert.equal((await command(guest,id,b,'media.load',{mediaId:'demo',quality:'direct'})).body.status,'forbidden');
  await command(creator,id,a,'media.play');
  await creator.call('/api/watch/rooms/' + id + '/leave',{viewerId:a});
  const room = f.app.watch.rooms.get(id);
  assert.ok(room); assert.equal(room.s.state.paused,true);
  assert.equal((await command(guest,id,b,'media.play')).body.status,'forbidden');
  const selectionPolicy = (await creator.call('/api/watch/rooms/' + id + '/settings')).body;
  await creator.call('/api/watch/rooms/' + id + '/settings',{revision:selectionPolicy.revision,change:{action:'permissions',role:'viewer',permissions:{chooseMedia:true}}});
  assert.equal((await command(guest,id,b,'media.ready.start',{readinessId:room.readinessId})).body.status,'forbidden','readiness override cannot bypass Continue without host');
  await creator.call('/api/watch/rooms/' + id + '?viewer=' + a);
  let settings = (await creator.call('/api/watch/rooms/' + id + '/settings')).body;
  const before = settings.revision;
  settings = (await creator.call('/api/watch/rooms/' + id + '/settings',{revision:before,change:{action:'permissions',role:'viewer',permissions:{seek:true,continueWithoutHost:true}}})).body;
  assert.equal((await creator.call('/api/watch/rooms/' + id + '/settings',{revision:before,change:{action:'rename',name:'Stale edit'}})).status,409);
  assert.equal((await command(guest,id,b,'media.seek.absolute',{seconds:7})).body.status,'applied');
  await creator.call('/api/watch/rooms/' + id + '/leave',{viewerId:a});
  assert.equal((await command(guest,id,b,'media.play')).body.status,'applied');
  const guestId = (await guest.call('/api/watch/me')).body.account.id;
  await creator.call('/api/watch/rooms/' + id + '?viewer=' + a);
  settings = (await creator.call('/api/watch/rooms/' + id + '/settings')).body;
  settings = (await creator.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'host.add',userId:guestId}})).body;
  settings = (await creator.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'visibility',visibility:'private'}})).body;
  assert.equal((await guest.call('/api/watch/rooms/' + id + '?viewer=' + b)).status,200);
  assert.equal((await guest.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'host.remove',userId:settings.creator.id}})).status,403);
  const transferred = await creator.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'creator.transfer',userId:guestId}});
  assert.equal(transferred.status,200,JSON.stringify(transferred.body));
  assert.equal((await guest.call('/api/watch/rooms/' + id + '?viewer=' + b)).body.roomRole,'creator');
  f.app.watch.canView = async () => false;
  const inaccessible = await guest.call('/api/watch/rooms/' + id + '/settings');
  assert.equal(inaccessible.status,200,'creator management does not require playback entitlement');
  assert.equal((await guest.call('/api/watch/rooms/' + id + '/close',{epoch:inaccessible.body.epoch})).status,200);
});

test('configured role administrators explicitly enable creator rights and lose private access when the role or mode is removed',tls,async t => {
  const f = await fixture(t), creator = await f.login('host'), admin = await f.login('guest2');
  const id = (await creator.call('/api/watch/rooms',{name:'Private room',visibility:'private'})).body.id;
  assert.equal((await admin.call('/api/watch/me')).body.adminEligible,true);
  assert.equal((await admin.call('/api/watch/rooms/saved')).body.total,0);
  assert.equal((await admin.call('/api/watch/rooms/' + id + '/settings')).status,403);
  assert.equal((await admin.call('/api/watch/admin-mode',{enabled:true})).body.adminMode,true);
  assert.equal((await admin.call('/api/watch/rooms/saved')).body.total,1);
  let settings = (await admin.call('/api/watch/rooms/' + id + '/settings')).body;
  assert.ok(settings.capabilities.manageHosts); assert.equal(settings.hosts.length,0);
  const oldSlug = f.app.watch.rooms.get(id).s.slug;
  settings = (await admin.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'rename',name:'Moderated name'}})).body;
  assert.equal(settings.creator.name,'Demo host');
  const active = f.app.watch.rooms.get(id);
  assert.equal(active.s.slug, 'moderated-name');
  assert.ok(active.previousSlugs.has(oldSlug));
  const redirect = await new Promise((resolve, reject) => {
    https.get(f.config.publicUrl + '/room/' + oldSlug, { ca: f.cert }, res => {
      resolve({ status: res.statusCode, location: res.headers.location });
    }).on('error', reject);
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.location, '/room/moderated-name');
  assert.equal((await admin.call('/api/watch/admin-mode',{enabled:false})).body.adminMode,false);
  assert.equal((await admin.call('/api/watch/rooms/saved')).body.total,0);
  await admin.call('/api/watch/admin-mode',{enabled:true}); f.roleUsers.clear();
  assert.equal((await admin.call('/api/watch/me')).body.adminMode,false);
  f.roleUsers.add(f.subjects.guest2);
  assert.equal((await admin.call('/api/watch/me')).body.adminMode,false,'role restoration cannot reactivate old consent');
  assert.equal((await admin.call('/api/watch/rooms/' + id + '/settings')).status,403);
});

test('durable room queue supports add, move, remove, playNow, next, previous, history replay and survives reopen',tls,async t => {
  const f = await fixture(t,true), creator = await f.login('host'), guest = await f.login('guest');
  const id = (await creator.call('/api/watch/rooms',{name:'Queue live room'})).body.id;
  const a = randomUUID(), b = randomUUID();

  // Load first video (sets as current in queue)
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});

  let state = (await creator.call('/api/watch/rooms/' + id + '?viewer=' + a)).body;
  assert.ok(state.queueSummary);
  assert.equal(state.queueSummary.queueLength, 0);
  assert.equal(state.queueSummary.current.mediaId, 'demo');
  assert.equal(state.hasNext, false);

  // Add 2 items to queue
  const item1 = { serverId:'local-demo', mediaId:'demo', type:'movie', title:'Demo Item 1', duration:f.app.watch.demoMedia.duration };
  const item2 = { serverId:'local-demo', mediaId:'demo', type:'movie', title:'Demo Item 2', duration:f.app.watch.demoMedia.duration };

  // Guest (viewer) cannot add to queue without permission
  const guestAdd = await guest.call('/api/watch/rooms/' + id + '/queue', { action:'add', item:item1 });
  assert.equal(guestAdd.status, 403);

  // Creator adds item 1 and item 2
  const add1 = await creator.call('/api/watch/rooms/' + id + '/queue', { action:'add', item:item1 });
  assert.equal(add1.status, 200);
  assert.equal(add1.body.added.title, 'Demo Item 1');

  const add2 = await creator.call('/api/watch/rooms/' + id + '/queue', { action:'add', item:item2, expectedRevision:add1.body.queueRevision });
  assert.equal(add2.status, 200);

  // Queue list contains 2 items
  let qList = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  assert.equal(qList.total, 2);
  assert.equal(qList.items[0].title, 'Demo Item 1');
  assert.equal(qList.items[1].title, 'Demo Item 2');

  // Move item 2 to rank 0
  const moveRes = await creator.call('/api/watch/rooms/' + id + '/queue', {
    action:'move', entryId:add2.body.added.id, targetRank:0, expectedRevision:add2.body.queueRevision
  });
  assert.equal(moveRes.status, 200);

  qList = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  assert.equal(qList.items[0].title, 'Demo Item 2');
  assert.equal(qList.items[1].title, 'Demo Item 1');

  // Verify snapshot has updated queueSummary and hasNext is true
  state = (await creator.call('/api/watch/rooms/' + id + '?viewer=' + a)).body;
  assert.equal(state.hasNext, true);
  assert.equal(state.queueSummary.queueLength, 2);
  assert.equal(state.queueSummary.next.title, 'Demo Item 2');

  // Advance via media.next: Item 2 becomes current
  await command(creator, id, a, 'media.next');
  state = (await creator.call('/api/watch/rooms/' + id + '?viewer=' + a)).body;
  assert.equal(state.queueSummary.current.title, 'Demo Item 2');
  assert.equal(state.queueSummary.queueLength, 1);
  assert.equal(state.queueSummary.historyLength, 1);

  // History contains the original video
  const hList = (await creator.call('/api/watch/rooms/' + id + '/history')).body;
  assert.equal(hList.total, 1);
  assert.equal(hList.items[0].outcome, 'skipped');

  // Previous at position < 5s replays the history item as a fresh occurrence
  await command(creator, id, a, 'media.previous');
  state = (await creator.call('/api/watch/rooms/' + id + '?viewer=' + a)).body;
  assert.notEqual(state.queueSummary.current.id, hList.items[0].id);

  // Close room and verify reopening restores queue and current item
  const settings = (await creator.call('/api/watch/rooms/' + id + '/settings')).body;
  await creator.call('/api/watch/rooms/' + id + '/close', { epoch:settings.epoch });
  assert.equal(f.app.watch.rooms.size, 0);

  // Reopen
  await creator.call('/api/watch/rooms/' + id + '/reopen', {});
  assert.equal(f.app.watch.rooms.size, 1);

  const restoredState = (await creator.call('/api/watch/rooms/' + id + '?viewer=' + randomUUID())).body;
  assert.ok(restoredState.queueSummary);
  assert.equal(restoredState.queueSummary.queueLength, 1);
  assert.equal(restoredState.queueSummary.next.title, 'Demo Item 1');
});

test('queue Play now and Skip to dispatch through validation and history replay consumes only the selected row',tls,async t => {
  const f = await fixture(t), creator = await f.login('host'), guest = await f.login('guest');
  const id = (await creator.call('/api/watch/rooms', { name:'Queue selections' })).body.id, viewer = randomUUID();
  const route = '/api/watch/rooms/' + id;
  await command(creator, id, viewer, 'media.load', { mediaId:'demo', quality:'direct' });
  const entries = [];
  for (const title of ['First', 'Second', 'Third', 'Fourth', 'Fifth']) {
    const added = await creator.call(route + '/queue', { action:'add', item:{ serverId:'local-demo', mediaId:'demo', type:'movie', title, duration:f.app.watch.demoMedia.duration } });
    assert.equal(added.status, 200); entries.push(added.body.added);
  }
  const play = { action:'playEntry', entryId:entries[2].id, expectedRevision:f.app.watch.roomState.queue.summary(id).queueRevision };
  assert.equal((await guest.call(route + '/queue', play)).status, 403);
  assert.equal((await creator.call(route + '/queue', { ...play, expectedRevision:0 })).status, 409);
  assert.equal((await creator.call(route + '/queue', play)).status, 200);
  let state = (await creator.call(route + '?viewer=' + viewer)).body;
  assert.equal(state.queueSummary.current.id, entries[2].id);
  assert.deepEqual((await creator.call(route + '/queue')).body.items.map(item => item.title), ['First', 'Second', 'Fourth', 'Fifth']);
  await command(creator, id, viewer, 'media.pause');
  await command(creator, id, viewer, 'media.seek.absolute', { seconds:17 });
  const skipped = await creator.call(route + '/queue', { action:'skipTo', entryId:entries[3].id, expectedRevision:state.queueSummary.queueRevision });
  assert.equal(skipped.status, 200);
  const remaining = (await creator.call(route + '/queue')).body.items;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].title, 'Fifth');
  assert.equal(remaining[0].rank, 0, 'Skip to reindexes the remaining queue from zero');
  const history = (await creator.call(route + '/history')).body;
  assert.equal(history.items.find(item => item.id === entries[0].id).outcome, 'skipped');
  assert.equal(history.items.find(item => item.id === entries[1].id).outcome, 'skipped');
  const savedDemo = f.app.watch.demoMedia;
  f.app.watch.demoMedia = undefined;
  assert.equal((await creator.call(route + '/history', { action:'replay', entryId:entries[2].id, resume:true })).status, 400);
  assert.ok(f.app.watch.roomState.queue.getEntry(entries[2].id), 'failed preparation preserves the source history');
  f.app.watch.demoMedia = savedDemo;
  assert.equal((await creator.call(route + '/history', { action:'replay', entryId:entries[2].id, resume:true })).status, 200);
  state = (await creator.call(route + '?viewer=' + viewer)).body;
  assert.equal(state.state.position, 17);
  assert.equal(state.queueSummary.current.title, 'Third');
  assert.notEqual(state.queueSummary.current.id, entries[2].id);
  assert.equal(f.app.watch.roomState.queue.getEntry(entries[2].id), null);
  assert.equal(state.queueSummary.historyCount, history.total);
  assert.equal((await creator.call(route + '/history', { action:'replay', entryId:entries[3].id, resume:false })).status, 200);
  state = (await creator.call(route + '?viewer=' + viewer)).body;
  assert.equal(state.state.position, 0);
  assert.equal(state.queueSummary.current.title, 'Fourth');
  assert.equal(f.app.watch.roomState.queue.getEntry(entries[3].id), null);
  const oldest = (await creator.call(route + '/history')).body.items.at(-1);
  const goBack = { action:'goBack', entryId:oldest.id, expectedRevision:state.queueSummary.queueRevision };
  assert.equal((await guest.call(route + '/history', goBack)).status, 403);
  assert.equal((await creator.call(route + '/history', { ...goBack, expectedRevision:0 })).status, 409);
  assert.equal((await creator.call(route + '/history', goBack)).status, 200);
  state = (await creator.call(route + '?viewer=' + viewer)).body;
  assert.equal(state.queueSummary.current.title, oldest.title);
  assert.equal(state.queueSummary.historyCount, 0);
  assert.deepEqual((await creator.call(route + '/queue')).body.items.map(item => item.title), ['First', 'Second', 'Third', 'Fourth', 'Fifth']);
});

test('live bulk and auto-queue commands normalize Plex episodes, enforce capabilities before catalog access and reject stale revisions',tls,async t => {
  const f = await fixture(t), creator = await f.login('host'), guest = await f.login('guest');
  const id = (await creator.call('/api/watch/rooms',{name:'Bulk queue room'})).body.id, a = randomUUID(), b = randomUUID();
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
  const room = f.app.watch.rooms.get(id), originalMedia = room.mediaVersion, current = f.app.watch.roomState.queue.current(id);
  const episodes = [301,302,303].map((id,index) => ({id:String(id),type:'episode',title:'Episode ' + (index+1),duration:120,showTitle:'Fixture show',parentTitle:'Season 1'}));
  const requests = [], catalog = {principal:'bulk-fixture',queueItems:async query => {requests.push(query);return episodes;}};
  f.app.hub.plexFor = async () => catalog;
  f.app.watch.roomState.identify = async item => item.id === 'demo' ? 'local-demo' : 'fixture-plex';
  await guest.call('/api/watch/rooms/' + id + '?viewer=' + b);
  const bulk = {action:'bulk',type:'show',mediaId:'900',unfinished:true,includeSpecials:true};
  assert.equal((await guest.call('/api/watch/rooms/' + id + '/queue',bulk)).status,403);
  assert.equal(requests.length,0,'an unprivileged viewer cannot trigger a Plex expansion');
  let listed = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  const staleRevision = listed.queueRevision;
  const expanded = await creator.call('/api/watch/rooms/' + id + '/queue',{...bulk,expectedRevision:listed.queueRevision});
  assert.equal(expanded.status,200,JSON.stringify(expanded.body));
  assert.equal(expanded.body.addedCount,3);
  assert.deepEqual(requests,[{type:'show',id:'900',includeSpecials:true}]);
  listed = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  assert.deepEqual(listed.items.map(item => [item.mediaId,item.serverId,item.type,item.title]),episodes.map(item => [item.id,'fixture-plex','episode',item.title]));
  assert.equal(f.app.watch.roomState.queue.current(id).id,current.id); assert.equal(room.mediaVersion,originalMedia);
  for (const action of ['bulk','shuffle','auto']) {
    const response = await creator.call('/api/watch/rooms/' + id + '/queue',{
      ...(action === 'bulk' ? bulk : action === 'auto' ? {action,mode:'following',scope:{type:'show',id:'900'},includeSpecials:false} : {action}),expectedRevision:staleRevision
    });
    assert.equal(response.status,409,JSON.stringify(response.body)); assert.match(response.body.error,/Queue changed/);
  }
  assert.equal(requests.length,1,'stale bulk and auto commands fail before fetching catalog pages');
  assert.equal((await creator.call('/api/watch/rooms/' + id + '/queue',{action:'clear',expectedRevision:listed.queueRevision})).status,200);
  const automatic = await command(creator,id,a,'queue.auto',{mode:'following',scope:{type:'show',id:'900'},includeSpecials:false});
  assert.equal(automatic.body.status,'applied',JSON.stringify(automatic.body));
  listed = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  assert.equal(listed.total,0); assert.equal(f.app.watch.roomState.store.get(id).autoQueue.next.mediaId,'301'); assert.equal(f.app.watch.roomState.store.get(id).autoQueue.next.provenance,'following');
  assert.equal(f.app.watch.roomState.store.get(id).autoQueue.scope.serverId,'fixture-plex');
  assert.equal(f.app.watch.roomState.queue.current(id).id,current.id); assert.equal(room.mediaVersion,originalMedia);
});

test('held bulk expansions recheck a guest capability and active viewer after Plex returns',tls,async t => {
  for (const revoke of ['permission','viewer']) await t.test(revoke,async sub => {
    const f = await fixture(sub), creator = await f.login('host'), guest = await f.login('guest');
    const id = (await creator.call('/api/watch/rooms',{name:'Revoked bulk room'})).body.id, a = randomUUID(), b = randomUUID();
    await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
    let settings = (await creator.call('/api/watch/rooms/' + id + '/settings')).body;
    settings = (await creator.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'permissions',role:'viewer',permissions:{addQueue:true}}})).body;
    await guest.call('/api/watch/rooms/' + id + '?viewer=' + b);
    let started = false, release;
    const held = new Promise(resolve => {release=resolve;});
    const catalog = {principal:'held-bulk-fixture',queueItems:async () => {started=true;await held;return [{id:'301',type:'episode',title:'Held episode',duration:120}];}};
    f.app.hub.plexFor = async () => catalog;
    f.app.watch.roomState.identify = async item => item.id === 'demo' ? 'local-demo' : 'fixture-plex';
    const before = f.app.watch.roomState.queue.list(id), current = f.app.watch.roomState.queue.current(id);
    const pending = guest.call('/api/watch/rooms/' + id + '/queue',{action:'bulk',type:'show',mediaId:'900',includeSpecials:false,unfinished:false,expectedRevision:before.queueRevision});
    try {
      const deadline = Date.now()+2000;
      while (!started && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,5));
      assert.equal(started,true,'the allowed guest reached the awaited Plex expansion');
      if (revoke === 'permission') {
        const updated = await creator.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'permissions',role:'viewer',permissions:{addQueue:false}}});
        assert.equal(updated.status,200,JSON.stringify(updated.body));
      } else assert.equal((await guest.call('/api/watch/rooms/' + id + '/leave',{viewerId:b})).status,200);
    } finally {release();}
    const rejected = await pending;
    assert.equal(rejected.status,403,JSON.stringify(rejected.body));
    const after = f.app.watch.roomState.queue.list(id);
    assert.equal(after.total,0); assert.equal(after.queueRevision,before.queueRevision);
    assert.equal(f.app.watch.roomState.queue.current(id).id,current.id);
  });
});

test('closed room shuffle and random auto-queue use the saved Engine branch while ordinary viewers cannot discover or edit it',tls,async t => {
  const f = await fixture(t), creator = await f.login('host'), guest = await f.login('guest');
  const id = (await creator.call('/api/watch/rooms',{name:'Closed queue room'})).body.id, viewer = randomUUID();
  await command(creator,id,viewer,'media.load',{mediaId:'demo',quality:'direct'});
  const episodes = [301,302,303].map(id => ({id:String(id),type:'episode',title:'Episode ' + id,duration:120}));
  let requests = 0;
  const catalog = {principal:'saved-queue-fixture',queueItems:async () => {requests++;return episodes;}};
  f.app.hub.plexFor = async () => catalog;
  f.app.watch.roomState.identify = async item => item.id === 'demo' ? 'local-demo' : 'fixture-plex';
  assert.equal((await creator.call('/api/watch/rooms/' + id + '/queue',{action:'bulk',type:'show',mediaId:'900',unfinished:false,includeSpecials:false})).status,200);
  const settings = (await creator.call('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal((await creator.call('/api/watch/rooms/' + id + '/close',{epoch:settings.epoch})).status,200);
  assert.equal(f.app.watch.rooms.has(id),false); assert.equal(f.app.hub.rooms.has(id),false);
  assert.equal((await guest.call('/api/watch/rooms/saved')).body.total,0);
  for (const data of [undefined,{action:'shuffle'},{action:'auto',mode:'random',scope:{type:'collection',id:'901'},includeSpecials:false}]) {
    assert.equal((await guest.call('/api/watch/rooms/' + id + '/queue',data)).status,403);
  }
  assert.equal(requests,1,'hidden-room requests do not fetch its catalog');
  let listed = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  const originalIds = listed.items.map(item => item.id).sort();
  const shuffled = await creator.call('/api/watch/rooms/' + id + '/queue',{action:'shuffle',expectedRevision:listed.queueRevision});
  assert.equal(shuffled.status,200,JSON.stringify(shuffled.body));
  listed = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  assert.deepEqual(listed.items.map(item => item.id).sort(),originalIds); assert.deepEqual(listed.items.map(item => item.rank),[0,1,2]);
  assert.equal((await creator.call('/api/watch/rooms/' + id + '/queue',{action:'clear',expectedRevision:listed.queueRevision})).status,200);
  listed = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  const automatic = await creator.call('/api/watch/rooms/' + id + '/queue',{action:'auto',mode:'random',scope:{type:'collection',id:'901'},includeSpecials:false,expectedRevision:listed.queueRevision});
  assert.equal(automatic.status,200,JSON.stringify(automatic.body));
  listed = (await creator.call('/api/watch/rooms/' + id + '/queue')).body;
  assert.equal(listed.total,0); assert.equal(f.app.watch.roomState.store.get(id).autoQueue.next.provenance,'random');
  const saved = f.app.watch.roomState.store.get(id);
  assert.equal(saved.autoQueue.mode,'random'); assert.deepEqual(saved.autoQueue.scope,{type:'collection',id:'901',serverId:'fixture-plex'});
  assert.ok(saved.autoQueue.used.includes(saved.autoQueue.next.mediaId));
  assert.equal(saved.bookmark.mediaId,'demo'); assert.equal(f.app.watch.rooms.has(id),false);
});


test('empty disposal honors the keep toggle, queue and 90 percent retention boundary',tls,async t=>{
  const f=await fixture(t),creator=await f.login('host');
  const make=async options=>(await creator.call('/api/watch/rooms',options)).body.id;
  const empty=await make({name:'Disposable'});
  await f.app.watch.remove(empty);
  assert.throws(()=>f.app.watch.roomState.store.get(empty),/unavailable/);
  const kept=await make({name:'Kept',keepEmpty:true});
  await f.app.watch.remove(kept);
  assert.equal(f.app.watch.roomState.store.get(kept).keepEmpty,true);
  for(const fraction of [.89,.9]) {
    const id=await make({name:'Progress'}),viewer=randomUUID();
    await command(creator,id,viewer,'media.load',{mediaId:'demo',quality:'direct'});
    await command(creator,id,viewer,'media.pause');
    const room=f.app.watch.rooms.get(id);
    await command(creator,id,viewer,'media.seek.absolute',{seconds:room.media.duration*fraction});
    await f.app.watch.remove(id);
    if(fraction<.9)assert.ok(f.app.watch.roomState.store.get(id).bookmark);
    else assert.throws(()=>f.app.watch.roomState.store.get(id),/unavailable/);
  }
});

test('inactivity cleanup respects its floor, occupied rooms and last access rather than checkpoints',tls,async t=>{
  const f=await fixture(t,false,{roomLimits:{minRetained:1,inactiveDays:1}}),creator=await f.login('host');
  const state=f.app.watch.roomState,ids=[];
  for(let i=0;i<3;i++) {
    const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id;ids.push(id);
    await f.app.watch.remove(id);
    state.store.db.prepare('UPDATE watch_rooms SET lastAccessedAt=? WHERE id=?').run(1000+i,id);
  }
  await state.maintain(Date.now());
  assert.equal(state.store.db.prepare('SELECT COUNT(*) AS n FROM watch_rooms').get().n,1);
  assert.equal(state.store.get(ids[2]).id,ids[2]);
  const room=state.store.get(ids[2]);
  await state.store.checkpoint(room.id,room.checkpointRevision,null);
  assert.equal(state.store.get(room.id).lastAccessedAt,1002,'background writes are not access');
});

test('room and server capacity count accounts once and reserve disconnected people',tls,async t=>{
  const f=await fixture(t,false,{roomLimits:{maxMembers:1,maxPeople:2}}),creator=await f.login('host'),guest=await f.login('guest'),third=await f.login('guest2');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id;
  const a=randomUUID(),b=randomUUID();
  assert.equal((await creator.call('/api/watch/rooms/'+id+'?viewer='+a)).status,200);
  assert.equal((await creator.call('/api/watch/rooms/'+id+'?viewer='+b)).status,200);
  assert.equal((await guest.call('/api/watch/rooms/'+id+'?viewer='+randomUUID())).status,429);
  assert.equal((await third.call('/api/watch/me')).status,429);
  const room=f.app.watch.rooms.get(id);
  for(const v of room.viewers.values())v.at=Date.now()-11000;
  f.app.watch.refresh(room);
  assert.equal((await guest.call('/api/watch/rooms/'+id+'?viewer='+randomUUID())).status,429);
  assert.equal((await creator.call('/api/watch/rooms/'+id+'?viewer='+a)).status,200);
});

test('reboot recovery admits ordinary returning viewers, waits for everyone and expires paused',tls,async t=>{
  const f=await fixture(t,true),creator=await f.login('host'),guest=await f.login('guest');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,a=randomUUID(),b=randomUUID();
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
  await guest.call('/api/watch/rooms/'+id+'?viewer='+b);
  await f.app.watch.roomState.save(f.app.watch.rooms.get(id));
  // Model a committed playing intent; actual clients must freshly prepare and report readiness.
  const record=f.app.watch.roomState.store.get(id);
  record.liveState.wasPlaying=true;
  f.app.watch.roomState.store.db.prepare('UPDATE watch_rooms SET liveState=? WHERE id=?').run(JSON.stringify(record.liveState),id);
  await f.app.registry.flush();
  await f.restart();
  const returning=await f.login('guest');
  const joined=await returning.call('/api/watch/rooms/'+id+'?viewer='+b);
  assert.equal(joined.status,200,JSON.stringify(joined.body));
  assert.equal(joined.body.recovery.missing,1);assert.equal(joined.body.state.paused,true);
  const recovery=f.app.watch.roomState.recoveries.get(id);
  await f.app.watch.roomState.maintain(recovery.until+1);
  const room=f.app.watch.rooms.get(id);
  assert.equal(room.recovery,undefined);assert.equal(room.s.state.paused,true);assert.equal(room.manualPaused,true);
});

test('reboot playback resumes only with all expected people ready, or explicit permitted Play',tls,async t=>{
  const f=await fixture(t,true),creator=await f.login('host'),guest=await f.login('guest');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,a=randomUUID(),b=randomUUID();
  const id2=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,a2=randomUUID(),b2=randomUUID();
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
  await guest.call('/api/watch/rooms/'+id+'?viewer='+b);
  await command(creator,id,a,'media.play');
  await command(creator,id2,a2,'media.load',{mediaId:'demo',quality:'direct'});
  await guest.call('/api/watch/rooms/'+id2+'?viewer='+b2);
  await command(creator,id2,a2,'media.play');
  await f.restart();
  const host=await f.login('host'),viewer=await f.login('guest');
  await host.call('/api/watch/rooms/'+id+'?viewer='+a);
  const room=f.app.watch.rooms.get(id),recovery=room.recovery;
  assert.equal(recovery.wasPlaying,true);
  for(const [key,v] of room.viewers)await f.app.watch.ready(room,v.actor,key,room.mediaVersion,true,room.readinessVersion);
  assert.ok(room.recovery,'missing viewer prevents resume');
  await viewer.call('/api/watch/rooms/'+id+'?viewer='+b);
  for(const [key,v] of room.viewers)await f.app.watch.ready(room,v.actor,key,room.mediaVersion,true,room.readinessVersion);
  assert.equal(room.recovery,undefined);assert.equal(room.manualPaused,false);

  // Explicit Pause cancels reboot resume intent even when everyone subsequently returns ready
  await host.call('/api/watch/rooms/'+id2+'?viewer='+a2);
  const room2=f.app.watch.rooms.get(id2);
  assert.ok(room2.recovery);
  await command(host,id2,a2,'media.pause');
  await viewer.call('/api/watch/rooms/'+id2+'?viewer='+b2);
  for(const [key,v] of room2.viewers)await f.app.watch.ready(room2,v.actor,key,room2.mediaVersion,true,room2.readinessVersion);
  assert.equal(room2.recovery,undefined);assert.equal(room2.manualPaused,true);assert.equal(room2.s.state.paused,true);
});


test('permitted Play bypasses missing restart participants and closed rooms remain closed',tls,async t=>{
  const f=await fixture(t,true),creator=await f.login('host'),guest=await f.login('guest');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,a=randomUUID();
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
  await guest.call('/api/watch/rooms/'+id+'?viewer='+randomUUID());
  const closed=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id;
  await f.app.watch.remove(closed);
  await f.restart();
  assert.equal(f.app.watch.roomState.recoveries.has(closed),false);
  const returning=await f.login('host');
  await returning.call('/api/watch/rooms/'+id+'?viewer='+a);
  assert.equal(f.app.watch.roomState.recoveryState(f.app.watch.rooms.get(id)).missing,1);
  assert.equal((await command(returning,id,a,'media.play')).body.status,'applied');
  assert.equal(f.app.watch.rooms.get(id).recovery,undefined);
  assert.equal(f.app.watch.roomState.recoveries.has(id),false);
});

test('saved and open limits remain separate under concurrent room creation',tls,async t=>{
  const f=await fixture(t,false,{roomLimits:{maxSaved:3,maxOpen:2,minRetained:0}}),creator=await f.login('host');
  const attempts=await Promise.all(Array.from({length:3},()=>creator.call('/api/watch/rooms',{keepEmpty:true})));
  assert.equal(attempts.filter(reply=>reply.status===201).length,2);
  assert.equal(attempts.filter(reply=>reply.status===429).length,1);
  await f.app.watch.remove(attempts.find(reply=>reply.status===201).body.id);
  assert.equal((await creator.call('/api/watch/rooms',{keepEmpty:true})).status,201);
  for(const id of [...f.app.watch.rooms.keys()])await f.app.watch.remove(id);
  assert.equal((await creator.call('/api/watch/rooms',{keepEmpty:true})).status,429,'closed records still consume saved slots');
});



test('missing queue media remains removable, blocks raw additions and restores without a media grant',tls,async t=>{
  const f=await fixture(t), client=await f.login('host'), viewer=randomUUID();
  const id=(await client.call('/api/watch/rooms',{keepEmpty:true})).body.id,root='/api/watch/rooms/'+id;
  await client.call(root+'?viewer='+viewer);
  const room=f.app.watch.rooms.get(id), queue=f.app.watch.roomState.queue, plex=f.app.watch.plex;
  const item={serverId:'fixture-server',mediaId:'9',type:'movie',title:'Missing movie',duration:60};
  f.app.hub.plexFor=async()=>plex; plex.allows=async()=>true;
  f.app.watch.roomState.identify=async()=>item.serverId;
  plex.availability=async ids=>new Map(ids.map(id=>[id,false]));
  const missing=()=>Object.assign(new Error('Missing movie is unavailable.'),{code:'MEDIA_UNAVAILABLE',status:409});
  plex.playableItem=async()=>{throw missing();};
  plex.prepare=async()=>{throw missing();};
  const rejected=await command(client,id,viewer,'queue.add',{item,queueRevision:queue.room(id).queueRevision});
  assert.notEqual(rejected.body.status,'applied');assert.equal(queue.pending(id).length,0);
  await queue.playNow(id,room.s.ownerId,item);
  room.media=await f.app.watch.roomState.savedSource(plex,{...item,position:0});
  room.media.roomServerId=item.serverId;
  const response=await client.call(root+'?viewer='+viewer); assert.equal(response.status,200,JSON.stringify(response.body));
  const state=response.body;
  assert.equal(state.unavailableMedia[0].mediaId,'9');assert.equal(state.mediaError,'Missing movie is unavailable.');
  assert.equal(state.mediaUrl,undefined);assert.equal(state.tracks,undefined);
  assert.equal((await client.call(root+'/close',{epoch:state.epoch})).status,200);
  const reopened=await client.call(root+'/reopen',{viewerId:viewer});
  assert.equal(reopened.status,200,JSON.stringify(reopened.body));
  assert.equal(reopened.body.state.unavailableMedia[0].mediaId,'9');
  assert.equal(reopened.body.state.mediaUrl,undefined);
  const entry=queue.current(id);
  const removed=await command(client,id,viewer,'queue.remove',{entryId:entry.id,queueRevision:queue.room(id).queueRevision});
  assert.equal(removed.body.status,'applied');
  assert.deepEqual((await client.call(root+'?viewer='+viewer)).body.unavailableMedia,[]);
});

