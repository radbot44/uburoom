'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {Accounts,credentialVault} = require('../server/accounts');
const {RoomStore} = require('../server/room-store');
const Policy = require('../server/room-policy');
const {UserDirectory} = require('../server/user-directory');
const {parseRoster} = require('../server/plex-directory');
const {viewEligible} = require('../server/core');
function fixture(t) {
  const registry=new Accounts(undefined,credentialVault()); t.after(()=>registry.close());
  const creator=registry.resolve('discord','100000000000000001','Leader'),host=registry.resolve('discord','100000000000000002','Host'),viewer=registry.resolve('plex','101','Viewer');
  const store=new RoomStore(registry,{isAdmin:id=>id==='admin'});
  return {registry,creator,host,viewer,store};
}
test('display names survive provider refresh, link/unlink and merge without invalidating authentication',t=>{
  const {registry,host,viewer}=fixture(t);
  const initial=host.revision;
  registry.rename(host.id,'  Custom name  ');
  registry.resolve('discord','100000000000000002','Changed provider');
  registry.link(host.id,'plex','102','Plex alias'); registry.credential('102',{token:'fixture-only'});
  registry.unlink(host.id,'discord','100000000000000002');
  assert.equal(registry.canonical(host.id).name,'Custom name');
  assert.equal(registry.canonical(host.id).revision,initial+1,'Only unlink changes the authentication revision');
  registry.rename(viewer.id,'Custom name');
  for(const name of ['', 'x'.repeat(81),'a\u202eb','a\nb'])assert.throws(()=>registry.rename(host.id,name),/display name/);
  const assigned=registry.resolve('discord','100000000000000009','Assigned account',false);
  assert.equal(assigned.signedInAt,null);
  const proved=registry.resolve('discord','100000000000000009','First login');
  assert.equal(proved.id,assigned.id);assert.equal(proved.name,'First login');assert.ok(proved.signedInAt>0);
  registry.rename(proved.id,'Chosen');registry.merge(proved.id,viewer.id,proved.id);
  assert.equal(registry.canonical(viewer.id).id,proved.id);assert.equal(registry.canonical(viewer.id).name,'Chosen');
});
test('host delegation defaults off, allows additions only, supports self-demotion, and all-hosts is reversible and leader-only',async t=>{
  const {store,creator,host,viewer}=fixture(t);
  let room=await store.create(creator.id,{keepEmpty:true});
  const edit=(actor,change)=>store.edit(room.id,actor,room.revision,change).then(value=>room=value);
  await edit(creator.id,{action:'host.add',userId:host.id});
  await assert.rejects(edit(host.id,{action:'host.add',userId:viewer.id}),{status:403});
  await edit(creator.id,{action:'permissions',role:'host',permissions:{addHosts:true}});
  await edit(host.id,{action:'host.add',userId:viewer.id});
  await assert.rejects(edit(host.id,{action:'host.remove',userId:viewer.id}),{status:403});
  await assert.rejects(edit(viewer.id,{action:'allHosts',enabled:true}),{status:403});
  await assert.rejects(edit('admin',{action:'allHosts',enabled:true}));
  await edit(creator.id,{action:'allHosts',enabled:true});
  await edit(host.id,{action:'host.leave',userId:viewer.id});
  assert.deepEqual(room.hosts,[viewer.id]);assert.equal(Policy.role(room,host.id),'host');
  await edit(creator.id,{action:'permissions.preset',preset:'host-control'});
  assert.equal(room.permissions.allHosts,true);assert.equal(room.permissions.host.addHosts,false);
  await edit(creator.id,{action:'allHosts',enabled:false});
  assert.equal(Policy.role(room,host.id),'viewer');assert.equal(Policy.role(room,viewer.id),'host');
  await assert.rejects(edit(host.id,{action:'host.leave'}),{status:403});
});
test('all-hosts changes controls without exposing private rooms or conferring saved-room access',async t=>{
  const {store,creator,host,viewer}=fixture(t);
  let room=await store.create(creator.id,{visibility:'private',permissions:{allHosts:true}});
  assert.equal(Policy.allowed(room,viewer.id,'roomSettings'),true);
  assert.equal(store.list(viewer.id).total,0);
  assert.throws(()=>store.restore(room.id,viewer.id),{status:403});
  const actor={userId:viewer.id,guildId:'guild',channelId:'channel'},config={guildId:'guild',channels:['channel']};
  const live={...room,kind:'watch',reachable:true,lastSeen:Date.now(),socket:{readyState:1}};
  assert.equal(viewEligible(live,actor,config,Date.now(),{isMember:()=>true}),false);
  room=await store.edit(room.id,creator.id,room.revision,{action:'host.add',userId:viewer.id});
  assert.equal(viewEligible({...live,hosts:room.hosts},actor,config,Date.now(),{isMember:()=>true}),true);
});
test('pending host grants create no account, require exact verified identity, are cancellable, and follow canonical merges',async t=>{
  const {registry,store,creator,host,viewer}=fixture(t);
  let room=await store.create(creator.id,{keepEmpty:true});
  const count=registry.directory().length, subject='100000000000000008';
  room=await store.edit(room.id,creator.id,room.revision,{action:'host.pending.add',provider:'discord',subject,name:'Reserved'});
  assert.equal(registry.directory().length,count);assert.equal(store.pendingHosts(room.id).length,1);
  await assert.rejects(store.edit(room.id,host.id,room.revision,{action:'host.pending.remove',provider:'discord',subject}),{status:403});
  const unproved=registry.resolve('discord',subject,'Reserved',false);
  assert.deepEqual(await store.claimHosts(unproved.id),[]);
  registry.resolve('discord',subject,'Proved');
  await store.claimHosts(unproved.id);
  assert.deepEqual(store.get(room.id).hosts,[unproved.id]);assert.deepEqual(store.pendingHosts(room.id),[]);
  registry.merge(viewer.id,unproved.id,creator.id);
  assert.deepEqual(store.get(room.id).hosts,[viewer.id]);
  room=store.get(room.id);
  room=await store.edit(room.id,creator.id,room.revision,{action:'host.pending.add',provider:'plex',subject:'999',name:'Cancel me'});
  await store.edit(room.id,creator.id,room.revision,{action:'host.pending.remove',provider:'plex',subject:'999'});
  assert.deepEqual(store.pendingHosts(room.id),[]);
});
test('getMany fetches multiple room records in batch and handles invalid or missing IDs',async t=>{
  const {store,creator,host}=fixture(t);
  const room1=await store.create(creator.id,{name:'Batch 1',keepEmpty:true});
  const room2=await store.create(creator.id,{name:'Batch 2',keepEmpty:true});
  await store.edit(room1.id,creator.id,room1.revision,{action:'host.add',userId:host.id});

  const empty=store.getMany(['not-a-uuid']);
  assert.equal(empty.size,0);

  const batch=store.getMany([room1.id,room2.id,'00000000-0000-0000-0000-000000000000']);
  assert.equal(batch.size,2);
  assert.equal(batch.get(room1.id).name,'Batch 1');
  assert.deepEqual(batch.get(room1.id).hosts,[host.id]);
  assert.equal(batch.get(room2.id).name,'Batch 2');
});
test('directory ranks live room/uburoom/known/new users, deduplicates verified aliases, caches sources and excludes private profile data',async t=>{
  const {registry,creator,host,viewer}=fixture(t);
  registry.rename(creator.id,'Match leader');registry.rename(host.id,'Match host');registry.rename(viewer.id,'Match viewer');
  registry.link(viewer.id,'discord','100000000000000005','Match linked');
  registry.resolve('discord','100000000000000006','Match offline');
  registry.resolve('discord','100000000000000007','Match assigned',false);
  let calls=0, now=1;
  const config={directory:{discord:true,plex:false}};
  const directory=new UserDirectory({registry,config,now:()=>now,discordOnline:id=>['100000000000000005','100000000000000008'].includes(id),
    discord:async()=>{calls++;return [{subject:'100000000000000005',name:'Match alias',email:'private'},{subject:'100000000000000008',name:'Match new available'},{subject:'100000000000000009',name:'Match new offline'}];}});
  const socket={readyState:1};directory.connected(socket,host.id);
  const options={members:[creator.id],hosts:[host.id],creatorId:creator.id};
  const found=await directory.search('Match',options);
  assert.deepEqual(found.results.slice(0,4).map(r=>r.userId),[creator.id,host.id,viewer.id,registry.identity('discord','100000000000000006').userId]);
  assert.equal(found.results.length,6);assert.match(found.results[4].caption,/Online on Discord/);
  assert.equal(found.results[1].assigned,true);assert.equal(calls,1);
  assert.equal(JSON.stringify(found).includes('private'),false);assert.equal(JSON.stringify(found).includes('credential'),false);
  assert.equal((await directory.search('Match alias',options)).results[0].userId,viewer.id);assert.equal(calls,1);
  config.directory.discord=false;
  assert.equal((await directory.search('Match',options)).results.length,4);
  await assert.rejects(directory.candidate('discord','100000000000000008'),{status:403});
  directory.disconnected(socket);assert.equal(directory.online().size,0);
  directory.connected(socket,host.id);now=11000;assert.equal(directory.online().size,0);
});
test('provider outages preserve local search and never return invented profiles',async t=>{
  const {registry,creator}=fixture(t);let calls=0;
  const directory=new UserDirectory({registry,config:{},discord:async()=>{calls++;throw Error('secret provider payload');}});
  const result=await directory.search('Leader');assert.equal(result.results[0].userId,creator.id);
  assert.match(result.notices[0],/Discord directory unavailable/);assert.equal(JSON.stringify(result).includes('secret'),false);
  await directory.search('Leader');assert.equal(calls,1);
});
test('live guests are discoverable without publishing unproven account reservations',async t=>{
  const {registry}=fixture(t);
  const guest=registry.create('Guest'),reserved=registry.resolve('plex','999','Guest reservation',false);
  const directory=new UserDirectory({registry,config:{directory:{discord:false,plex:false}}});
  const socket={readyState:1};directory.connected(socket,guest);
  const found=await directory.search('Guest',{members:[guest]});
  assert.equal(found.results.length,1);assert.equal(found.results[0].userId,guest);assert.match(found.results[0].caption,/In this room.*Guest/);
  directory.disconnected(socket);assert.equal((await directory.search('Guest')).results.length,0);
  registry.seen(guest);assert.equal((await directory.search('Guest')).results[0].userId,guest);
  assert.equal(registry.canonical(reserved.id).signedInAt,null);
});
test('Plex directory uses server-scoped accepted shares and real Plex subjects, excludes managed users, pending invites and secrets',()=>{
  const user=(id,extra,server)=>`<User id="${id}" username="name${id}" title="A &amp; B" ${extra}>${server}</User>`;
  const share='<Server machineIdentifier="selected" pending="0" numLibraries="1" accessToken="private-token"/>';
  const xml='<MediaContainer>'+user('1','email="private"',share)+user('2','restricted="1"',share)+user('3','',share.replace('pending="0"','pending="1"'))+user('4','',share.replace('selected','other'))+'</MediaContainer>';
  assert.deepEqual(parseRoster(xml,'selected'),[{subject:'1',name:'A & B',alias:'name1'}]);
  assert.throws(()=>parseRoster('<!DOCTYPE x>'+xml,'selected'),/Unsupported/);
  assert.throws(()=>parseRoster('unexpected','selected'),/Unsupported/);
});
