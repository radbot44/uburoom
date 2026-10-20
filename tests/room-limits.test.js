'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { configuration, DEFAULTS } = require('../server/room-limits');
const { RoomPresence } = require('../server/room-presence');
const { Accounts, credentialVault } = require('../server/accounts');
const { RoomStore } = require('../server/room-store');

test('room limit defaults and contradictory configuration are validated before startup',()=>{
  assert.deepEqual(configuration(),DEFAULTS);
  assert.equal(configuration().maxSaved,50);assert.equal(configuration().maxOpen,5);
  assert.equal(configuration().maxQueue,50);assert.equal(configuration().maxHistory,150);
  for(const value of [{max_saved:0},{min_retained:51},{max_open:51},{max_members:1.5},{max_people:'100'},{inactive_days:-1},{recovery_seconds:0},{max_queue:0}]) assert.throws(()=>configuration(value));
  assert.equal(configuration({max_history:0}).maxHistory,0);
});

test('server admission deduplicates accounts and expires reservations exactly at the deadline',()=>{
  let now=1000;const presence=new RoomPresence(2,()=>now);
  presence.enter('one');presence.enter('one');presence.enter('two');
  assert.throws(()=>presence.enter('three'),error=>error.status===429);
  now=60999;presence.enter('one');
  assert.throws(()=>presence.enter('three'),/Server full/);
  now=61000;presence.enter('three');assert.equal(presence.people.size,2);
});

test('saved-room limits and capacity edits are enforced independently of active slots',async t=>{
  const registry=new Accounts(undefined,credentialVault());t.after(()=>registry.close());
  const store=new RoomStore(registry,{limits:{...DEFAULTS,maxSaved:2,maxMembers:4}});
  const owner=registry.resolve('plex','1','Owner').id,viewer=registry.resolve('plex','2','Viewer').id;
  const room=await store.create(owner,{maxMembers:2});await store.create(owner);
  await assert.rejects(store.create(owner),error=>error.status===429);
  await assert.rejects(store.edit(room.id,owner,room.revision,{action:'maxMembers',value:5}),/capacity/);
  await assert.rejects(store.edit(room.id,viewer,room.revision,{action:'keepEmpty',enabled:true}),error=>error.status===403);
  assert.equal((await store.edit(room.id,owner,room.revision,{action:'maxMembers',value:1})).maxMembers,1);
});


test('abrupt process exit retains committed room intent without restoring streams or consent',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
  const {execFileSync}=require('node:child_process'),{Hub}=require('../server/core'),{Watch}=require('../server/watch');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-room-crash-'));
  const file=path.join(directory,'accounts.sqlite'),key=path.join(directory,'original.key');
  fs.writeFileSync(key,crypto.randomBytes(32));const originalKey=fs.readFileSync(key);
  let registry,watch;
  t.after(async()=>{await watch?.close();await registry?.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('uburoom-room-crash-'));fs.rmSync(directory,{recursive:true,force:true});});
  const source=`
    const {Accounts,credentialVault}=require('./server/accounts'),{RoomStore}=require('./server/room-store');
    (async()=>{
      const registry=new Accounts(process.argv[1],credentialVault(process.argv[2])),store=new RoomStore(registry);
      const creator=registry.resolve('plex','1','Crash fixture').id,room=await store.create(creator,{keepEmpty:true});
      await store.checkpoint(room.id,0,{serverId:'local-demo',mediaId:'demo',type:'movie',title:'Fixture',duration:60,position:12});
      registry.db.prepare('UPDATE watch_rooms SET liveState=? WHERE id=?').run(JSON.stringify({viewers:[creator],wasPlaying:true}),room.id);
      await registry.flush();process.stdout.write(JSON.stringify({id:room.id,creator}));process.exit(0);
    })().catch(()=>process.exit(1));`;
  const saved=JSON.parse(execFileSync(process.execPath,['-e',source,file,key],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',stdio:['ignore','pipe','ignore']}));
  registry=new Accounts(file,credentialVault(key));
  const hub=new Hub({ownerId:'fixture',guildId:'fixture',channels:['fixture']},[]);hub.access={isMember:()=>true,refresh:async()=>true};
  watch=new Watch(hub,{stop:async()=>{}},{id:'demo',kind:'demo',title:'Fixture',duration:60},registry);
  watch.roomState.startRecovery();
  const actor={userId:saved.creator,name:'Crash fixture',surface:'web',guildId:'fixture',channelId:'fixture'};
  await watch.roomState.recover(saved.id,actor,async()=>true);
  const room=watch.rooms.get(saved.id);assert.equal(room.position,12);assert.equal(room.s.state.paused,true);assert.equal(room.s.enabled,false);
  assert.equal(room.viewers.size,0);assert.equal(room.recovery.wasPlaying,true);assert.deepEqual(fs.readFileSync(key),originalKey);
});


test('lowered history limits trim on startup without erasing compact completion progress',async t=>{
  const {RoomQueue}=require('../server/room-queue'),{WatchRooms}=require('../server/watch-rooms');
  const registry=new Accounts(undefined,credentialVault());let state;
  t.after(async()=>{await state?.close();await registry.close();});
  const store=new RoomStore(registry),queue=new RoomQueue(registry,store),owner=registry.resolve('plex','1','Owner').id;
  const room=await store.create(owner,{keepEmpty:true}),items=Array.from({length:4},(_,i)=>({serverId:'fixture',mediaId:String(i+1),type:'episode',title:'Episode',duration:60}));
  await queue.playNow(room.id,owner,items[0]);await queue.addBulk(room.id,owner,items.slice(1));
  for(let i=0;i<3;i++)await queue.next(room.id,owner,{outcome:'completed'});
  assert.equal(queue.history(room.id).total,3);
  state=new WatchRooms({hub:{config:{roomLimits:{maxHistory:1}},isAdmin:()=>false},rooms:new Map()},registry);
  assert.equal(state.queue.history(room.id).total,1);
  assert.equal(registry.db.prepare('SELECT COUNT(*) AS n FROM watch_room_progress').get().n,3);
});
