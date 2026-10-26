'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), https = require('node:https');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server/app');
const { controlClient } = require('./helpers/control-client');
const certFile = path.join(__dirname,'../certs/server-cert.pem');
const tls = {skip:!fs.existsSync(certFile)};

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
  return {get app(){return app;},login,roleUsers,subjects,async restart(){await app.close();await start();}};
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
  settings = (await admin.call('/api/watch/rooms/' + id + '/settings',{revision:settings.revision,change:{action:'rename',name:'Moderated name'}})).body;
  assert.equal(settings.creator.name,'Demo host');
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
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
  await guest.call('/api/watch/rooms/'+id+'?viewer='+b);
  await command(creator,id,a,'media.play');
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


test('explicit Pause cancels reboot resume intent even when everyone subsequently returns ready',tls,async t=>{
  const f=await fixture(t,true),creator=await f.login('host'),guest=await f.login('guest');
  const id=(await creator.call('/api/watch/rooms',{keepEmpty:true})).body.id,a=randomUUID(),b=randomUUID();
  await command(creator,id,a,'media.load',{mediaId:'demo',quality:'direct'});
  await guest.call('/api/watch/rooms/'+id+'?viewer='+b);await command(creator,id,a,'media.play');
  await f.restart();
  const host=await f.login('host'),viewer=await f.login('guest');
  await host.call('/api/watch/rooms/'+id+'?viewer='+a);
  assert.ok(f.app.watch.rooms.get(id).recovery);
  await command(host,id,a,'media.pause');
  await viewer.call('/api/watch/rooms/'+id+'?viewer='+b);
  const room=f.app.watch.rooms.get(id);
  for(const [key,v] of room.viewers)await f.app.watch.ready(room,v.actor,key,room.mediaVersion,true,room.readinessVersion);
  assert.equal(room.recovery,undefined);assert.equal(room.manualPaused,true);assert.equal(room.s.state.paused,true);
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
