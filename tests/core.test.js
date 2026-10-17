'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Engine = require('../extension/engine');
const { Hub, resolve, hash, PRESENCE_MS } = require('../server/core');
const { DeviceLogin } = require('../server/login');
const config = { ownerId: 'owner', guildId: 'guild', channels: ['commands'] };
const actor = { userId: 'owner', guildId: 'guild', channelId: 'commands' };
test('unnamed players use Discord names, visible numbering and unambiguous targeting', async () => {
  const { hub, register } = setup(); hub.ownerName = 'alice';
  const first = register('');
  assert.deepEqual((await hub.list(actor)).map(s => s.alias), ['alice']);
  assert.equal(resolve(hub.rooms.values(), actor, config).room.roomId, first.roomId);
  const second = register(''), privatePlayer = register('', false);
  hub.rooms.get(first.roomId).mode = hub.rooms.get(second.roomId).mode = 'guild';
  hub.access = { refresh: async () => true, isMember: () => true, voiceChannel:()=> 'call', validVoiceChannel:()=>true };
  const friend = { ...actor, userId: 'friend' };
  assert.deepEqual((await hub.list(friend)).map(s => s.alias), ['alice #1', 'alice #2']);
  assert.equal(resolve(hub.rooms.values(), friend, config, 'alice', Date.now(), hub.access).status, 'ambiguous');
  for (const target of ['alice#2', 'alice #2']) {
    const input = Engine.parse('!ubu.' + target + ' pause');
    assert.equal(resolve(hub.rooms.values(), friend, config, input.target, Date.now(), hub.access).room.roomId, second.roomId);
  }
  hub.rooms.get(second.roomId).enabled = false;
  assert.deepEqual((await hub.list(friend)).map(s => s.alias), ['alice'], 'private and disabled players do not leak through numbers');
  assert.equal(resolve(hub.rooms.values(), friend, config, 'alice', Date.now(), hub.access).room.roomId, first.roomId);
  assert.equal(hub.rooms.get(privatePlayer.roomId).alias, '');
  hub.close();
});
function setup() {
  const deviceId = randomUUID(), secret = 'a'.repeat(64);
  const hub = new Hub(config, [{ id: deviceId, ownerId: 'owner', credentialHash: hash(secret) }]);
  const sent = [];
  const ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
  assert.equal(hub.authenticate(ws, deviceId, secret), true);
  const register = (alias = 'player', enabled = true) => {
    const message = { roomId: randomUUID(), epoch: randomUUID(), alias, enabled, reachable: true, mode: 'owner' };
    hub.update(ws, message); return message;
  };
  return { hub, ws, register, sent };
}
test('command parser has explicit units, bounded finite values and no arbitrary actions', () => {
  for (const prefix of ['!uburoom', '!ubux', '!u']) assert.throws(() => Engine.parse(prefix + ' pause'));
  assert.equal(Engine.parse('!ubu start').action, 'media.seek.start');
  for (const verb of ['end', 'live']) assert.equal(Engine.parse('!ubu ' + verb).action, 'media.seek.end');
  assert.equal(Engine.parse('!ubu.bob.bedroom zoom 150').args.value, 1.5);
  assert.equal(Engine.parse('!ubu zoom 1.5').args.value, 1.5);
  assert.equal(Engine.parse('!ubu zoom 150%').args.value, 1.5);
  assert.equal(Engine.parse('!ubu zoom -0.5%').args.delta, -.005);
  assert.equal(Engine.parse('!ubu volume 50').args.percent, 50);
  for (const text of ['!ubu zoom Infinity', '!ubu zoom NaN', '!ubu zoom 2000%', '!ubu zoom +5', '!ubu volume 101', '!ubu pause now', '!ubu enable', '!ubu eval alert(1)']) assert.throws(() => Engine.parse(text));
  assert.throws(() => Engine.validate({ action: 'zoom.set', args: { value: '1.5' } }));
  let picture = Engine.picture(Engine.DEFAULT, { action: 'zoom.set', args: { value: 16 } });
  picture = Engine.picture(picture, { action: 'stretch.set', args: { axis: 'stretchX', value: 16 } });
  picture = Engine.picture(picture, { action: 'pan.edge', args: { axis: 'x', sign: 1 } });
  assert.ok(picture.x > (1 + 256) / 2, 'pan moves the entire maximum-scale picture out of frame');
  assert.equal(Engine.picture(picture, { action: 'zoom.adjust', args: { delta: .005 } }).zoom, 16, 'fine steps stop at the bound like the original userscript');
  assert.deepEqual(Engine.picture(picture, { action: 'reset.all' }), Engine.DEFAULT);
});
test('individual size resets preserve the other sizes and position', () => {
  const picture = { zoom:1.5,stretchX:1.1,stretchY:.95,x:.08,y:-.04 };
  for (const field of ['zoom','stretchX','stretchY']) {
    assert.deepEqual(Engine.picture(picture,{action:'reset.'+field}),{...picture,[field]:1});
  }
});
test('guest control categories are independent, owner controls remain available and revocations cancel in-flight commands', async () => {
  const { hub, ws, register, sent } = setup(); const registration = register();
  hub.access = { refresh: async () => true, isMember: () => true, voiceChannel:()=> 'call', validVoiceChannel:()=>true, options: () => ({ available:true }) };
  const session = hub.rooms.get(registration.roomId); session.mode = 'guild';
  session.controls = { playback:false, transform:true };
  const friend = { ...actor,userId:'friend' };
  for (const action of ['media.pause','media.play','media.toggle','media.mute','media.unmute','media.seek.start','media.seek.end']) {
    assert.equal((await hub.dispatch(friend,{action,controls:{playback:true}})).status,'forbidden');
  }
  assert.equal((await hub.dispatch(friend,{action:'media.volume.set',args:{percent:50}})).status,'forbidden');
  assert.equal((await hub.dispatch(friend,{action:'media.seek.relative',args:{seconds:15}})).status,'forbidden');
  async function applied(who,input) {
    const reply = hub.dispatch(who,input); await new Promise(resolve=>setImmediate(resolve));
    const wire = sent.at(-1); await hub.ack(ws,{...wire,status:'applied'}); assert.equal((await reply).status,'applied');
  }
  await applied(friend,{action:'zoom.set',args:{value:1.5}});
  await applied(actor,{action:'media.pause'});
  session.controls = {playback:true,transform:false};
  for (const input of [{action:'zoom.set',args:{value:1.5}},{action:'stretch.adjust',args:{axis:'stretchX',delta:.1}},
    {action:'pan.step',args:{axis:'x',sign:1}},{action:'reset.all'},{action:'reset.zoom'},{action:'reset.stretchX'},{action:'reset.stretchY'},{action:'profile.load',args:{slot:1}}]) {
    assert.equal((await hub.dispatch(friend,input)).status,'forbidden');
  }
  await applied(friend,{action:'media.pause'});
  await applied(actor,{action:'reset.all'});
  const pending = hub.dispatch(friend,{action:'media.pause'}); await new Promise(resolve=>setImmediate(resolve));
  const wire = sent.at(-1); session.controls.playback = false;
  await hub.ack(ws,{...wire,status:'applied'}); assert.equal((await pending).status,'unavailable');
  const list = await hub.list(friend); assert.equal(list[0].canPlayback,false);assert.equal(list[0].canTransform,false);
  assert.equal(session.enabled,true,'switching off guest controls does not switch off the connection');
  for (const action of ['room.controls','room.autojoin']) {
    const input = {action,roomId:session.roomId,args:{control:'playback',allowed:true,enabled:true}};
    assert.equal((await hub.dispatch({...friend,surface:'web'},input)).status,'forbidden');
    assert.equal((await hub.dispatch(actor,input)).status,'forbidden','Discord cannot manage these owner settings');
  }
  const { hub: otherHub,ws:otherWs,register:otherRegister,sent:otherSent } = setup();
  const s = otherRegister();otherHub.rooms.get(s.roomId).mode='guild';otherHub.access=hub.access;
  const inFlight=otherHub.dispatch(friend,{action:'media.pause'});await new Promise(resolve=>setImmediate(resolve));
  otherHub.update(otherWs,{...s,mode:'guild',controls:{playback:false,transform:true}});
  assert.equal((await inFlight).status,'unavailable','category changes cancel even without an epoch change');
  assert.equal(otherHub.pending.size,0);otherHub.close();hub.close();
});
test('On join needs per-session opt-in and a fresh join after arming; voice recovery snapshots never claim a join', () => {
  const session = {autoJoin:true,enabled:false,reachable:true,lastAck:2000,autoArmedAt:2000};
  const event = {joined:true,available:true,channelId:'voice',serverNow:2010,expiresAt:5010};
  assert.equal(Engine.joinEligible(session,event,2100),true);
  for (const changes of [{autoJoin:false},{enabled:true},{reachable:false},{lastAck:-6000},{autoArmedAt:2020}]) {
    assert.equal(Engine.joinEligible({...session,...changes},event,2100),false);
  }
  for (const changes of [{joined:false},{available:false},{channelId:null},{expiresAt:2100}]) {
    assert.equal(Engine.joinEligible(session,{...event,...changes},2100),false);
  }
  assert.equal(Engine.joinEligible(session,{...event,serverNow:2510,expiresAt:5510},2100,500),true,'server clock offset is respected');
  const {hub,ws,sent}=setup(); hub.access={options:()=>({available:true}),voiceChannel:()=> 'voice',validVoiceChannel:()=>true};
  const snapshot=hub.voiceMessage();assert.equal(snapshot.joined,false);assert.equal(snapshot.channelId,'voice');
  hub.publishVoice(true);assert.equal(sent.at(-1).joined,true);assert.ok(sent.at(-1).sequence>snapshot.sequence);
  hub.publishVoice(false,true);assert.equal(sent.at(-1).available,false);assert.equal(sent.at(-1).joined,false);
  const count=sent.length;ws.lastSeen=Date.now()-20000;hub.publishVoice(true);assert.equal(sent.length,count,'offline devices get no queued join');hub.close();
  assert.throws(()=>Engine.validate({action:'room.autojoin',args:{enabled:'true'}}));
  assert.throws(()=>Engine.validate({action:'room.controls',args:{control:'transform',allowed:1}}));
});
test('seek boundaries respect the available DVR window and disjoint recordings', () => {
  const ranges = [[130,200],[10,50],[60,90]];
  assert.equal(Engine.seekBoundary(ranges,'start'),10);
  assert.equal(Engine.seekBoundary(ranges,'end'),199.99);
  assert.equal(Engine.seekBoundary([[4,4.005]],'end'),4,'tiny ranges never seek before their beginning');
  for (const ranges of [[],[[0,Infinity]],[[NaN,10]],[[50,10]]]) assert.equal(Engine.seekBoundary(ranges,'start'),undefined);
});
test('routing checks actor, guild, channel, permission mode, opt-in and current presence; ambiguity is rejected', () => {
  const { hub, ws, register } = setup(); const s = register();
  assert.ok(resolve(hub.rooms.values(), actor, config).room);
  for (const denied of [{ ...actor, userId: 'friend' }, { ...actor, channelId: 'other' }, { ...actor, guildId: 'other' }]) {
    assert.equal(resolve(hub.rooms.values(), denied, config).status, 'forbidden');
  }
  const session = hub.rooms.get(s.roomId);
  for (const changes of [{ enabled: false }, { reachable: false }, { mode: 'anyone' }, { lastSeen: Date.now() - PRESENCE_MS - 1 }]) {
    const copy = { ...session, ...changes }; assert.equal(resolve([copy], actor, config, 'player').status, 'forbidden');
  }
  register('player.bedroom');
  assert.equal(resolve(hub.rooms.values(), actor, config).status, 'ambiguous');
  assert.equal(resolve(hub.rooms.values(), actor, config, 'player').status, 'ambiguous');
  assert.ok(resolve(hub.rooms.values(), actor, config, 'player.bedroom').room);
  ws.readyState = 3; assert.equal(resolve(hub.rooms.values(), actor, config).status, 'forbidden'); hub.close();
});
test('acknowledgements are bound to socket, command, epoch and current authorization', async () => {
  const { hub, ws, register, sent } = setup(); const s = register();
  const reply = hub.dispatch(actor, Engine.parse('!ubu mute'));
  const command = sent.at(-1); assert.equal(command.type, 'command');
  hub.ack({}, { ...command, status: 'applied' }); assert.equal(hub.pending.size, 1);
  hub.ack(ws, { ...command, epoch: randomUUID(), status: 'applied' }); assert.equal(hub.pending.size, 1);
  hub.ack(ws, { ...command, status: 'applied' }); assert.equal((await reply).status, 'applied');
  const pending = hub.dispatch(actor, Engine.parse('!ubu pause'));
  hub.update(ws, { ...s, epoch: randomUUID(), enabled: false });
  assert.equal((await pending).status, 'unavailable'); assert.equal(hub.pending.size, 0); hub.close();
});
test('sender labels come from authenticated actors, never command JSON, and do not grant access', async () => {
  const { hub, ws, register, sent } = setup(); register(); hub.ownerName = 'Alice';
  const input = { action: 'media.pause', senderName: 'Forged owner', name: 'Forged name', actor: { userId: 'owner' } };
  const pending = hub.dispatch({ ...actor, name: 'Alex\u202e\n' }, input);
  const command = sent.at(-1);
  assert.equal(command.senderName, 'Alex');
  hub.ack(ws, { ...command, status: 'applied' }); assert.equal((await pending).status, 'applied');
  const fallback = hub.dispatch(actor, input), next = sent.at(-1);
  assert.equal(next.senderName, 'Alice');
  hub.ack(ws, { ...next, status: 'applied' }); assert.equal((await fallback).status, 'applied');
  const count = sent.length;
  assert.equal((await hub.dispatch({ ...actor, userId: 'friend', name: 'Alice' }, input)).status, 'forbidden');
  assert.equal(sent.length, count, 'a matching display name cannot impersonate the host');
  assert.equal(Engine.senderName('x'.repeat(200)).length, 100);
  hub.close();
});
test('disconnect removes consent and pending commands, and reconnect does not replay them', async () => {
  const { hub, ws, register, sent } = setup(); register();
  const reply = hub.dispatch(actor, Engine.parse('!ubu pause'));
  hub.drop(ws); assert.equal((await reply).status, 'unavailable'); assert.equal(hub.rooms.size, 0);
  const count = sent.length, freshSent=[];
  const fresh={readyState:1,send:raw=>freshSent.push(JSON.parse(raw)),close(){this.readyState=3;},terminate(){this.readyState=3;}};
  assert.equal(hub.authenticate(fresh,ws.device.id,'a'.repeat(64)),true);
  hub.update(fresh,{roomId:randomUUID(),epoch:randomUUID(),alias:'player',enabled:false,reachable:true,mode:'owner'});
  assert.equal((await hub.dispatch(actor, Engine.parse('!ubu pause'))).status, 'forbidden');
  assert.equal(sent.length,count);assert.equal(freshSent.length,1,'only the new socket receives the disabled registration acknowledgement'); hub.close();
});

test('a replaced device socket cannot register a new remotely enabled session', async () => {
  const {hub,ws,register}=setup(), previous=register();
  const replacement={readyState:1,send:()=>{},close(){this.readyState=3;},terminate(){this.readyState=3;}};
  assert.equal(hub.authenticate(replacement,ws.device.id,'a'.repeat(64)),true);
  assert.equal(hub.rooms.size,0,'replacing the socket drops its old sessions');
  ws.readyState=1; // A queued old message may reach the hub before close completes.
  assert.throws(()=>hub.update(ws,{...previous,roomId:randomUUID(),enabled:true}),/Device disconnected/);
  assert.equal(hub.rooms.size,0,'a stale socket cannot restore remote consent');
  hub.update(replacement,{...previous,roomId:randomUUID(),enabled:false});
  assert.equal(hub.rooms.size,1,'the current socket can register a fresh disabled session');
  hub.close();
});
test('expired commands cannot acknowledge success or survive a changed permission', async () => {
  const { hub, ws, register, sent } = setup(); register();
  const reply = hub.dispatch(actor, Engine.parse('!ubu mute')); const command = sent.at(-1);
  hub.pending.get(command.id).sentAt -= 4000;
  hub.ack(ws, { ...command, status: 'applied' }); assert.equal((await reply).status, 'unavailable');
  const next = hub.dispatch(actor, Engine.parse('!ubu mute')); const second = sent.at(-1);
  hub.rooms.get(second.roomId).mode = 'voice';
  hub.ack(ws, { ...second, status: 'applied' }); assert.equal((await next).status, 'unavailable'); hub.close();
});
test('device login binds the verifier and private completion code, expires and cannot replay', () => {
  const login = new DeviceLogin(), deviceId = randomUUID(), verifier = 'b'.repeat(64), state = 'c'.repeat(64);
  const id = login.start(deviceId, hash(verifier), state);
  assert.throws(() => login.finish(id, verifier, 'a'.repeat(64)), 'login alone does not issue a device credential');
  const approved = login.approve(id, 'owner'); assert.equal(approved.state, state);
  assert.throws(() => login.finish(id, 'a'.repeat(64), approved.code));
  const paired = login.finish(id, verifier, approved.code);
  assert.equal(paired.deviceId, deviceId); assert.equal(paired.ownerId, 'owner');
  assert.match(paired.credential, /^[a-f0-9]{64}$/);
  assert.throws(() => login.finish(id, verifier, approved.code));
  const expired = login.start(deviceId, hash(verifier), state);
  login.requests.get(expired).expires = Date.now() - 1; assert.throws(() => login.approve(expired, 'owner'));
  const guessed = login.start(deviceId, hash(verifier), state);
  for (let n = 0; n < 5; n++) assert.throws(() => login.finish(guessed, 'wrong', 'wrong'));
  assert.equal(login.get(guessed), undefined);
});

test('sharing gates friends by current guild/voice membership and keeps owner actions private', async () => {
  const { hub, ws, register, sent } = setup();
  const voice = '111111111111111111', otherVoice = '222222222222222222';
  const members = new Set(['friend']), voices = new Map([['owner', voice], ['friend', voice]]);
  hub.access = { refresh: async id => members.has(id), isMember: id => members.has(id),
    validVoiceChannel: id => [voice, otherVoice].includes(id), voiceChannel: id => voices.get(id) };
  const friend = { ...actor, userId: 'friend' }, s = register('bob');
  const input = Engine.parse('!ubu.bob pause');
  voices.set('friend', otherVoice);
  assert.equal((await hub.dispatch(friend, input)).status, 'forbidden');
  voices.set('friend', voice);
  // Legacy clients cannot pick a channel: their field is ignored by the server.
  hub.update(ws, { ...s, mode: 'voice', voiceChannelId: otherVoice });
  assert.equal(hub.rooms.get(s.roomId).voiceChannelId, undefined);
  const applied = hub.dispatch(friend, input); await new Promise(resolve => setImmediate(resolve));
  const command = sent.at(-1); await hub.ack(ws, { ...command, status: 'applied' });
  assert.equal((await applied).status, 'applied');
  for (const action of ['room.disable', 'profile.save']) {
    assert.equal((await hub.dispatch(friend, { action, args: { slot: 1 } })).status, 'forbidden');
  }
  const pending = hub.dispatch(friend, input); await new Promise(resolve => setImmediate(resolve));
  const inFlight = sent.at(-1); voices.set('friend', otherVoice);
  await hub.ack(ws, { ...inFlight, status: 'applied' }); assert.equal((await pending).status, 'unavailable');
  assert.equal((await hub.dispatch(friend, input)).status, 'forbidden');
  assert.ok(resolve(hub.rooms.values(), actor, config, 'bob', Date.now(), hub.access).room, 'owner retains access outside the voice channel');
  voices.set('owner', otherVoice);
  assert.ok(resolve(hub.rooms.values(), friend, config, 'bob', Date.now(), hub.access).room, 'access follows the host to a new channel');
  const moving = hub.dispatch(friend, input); await new Promise(resolve => setImmediate(resolve));
  const beforeMove = sent.at(-1); voices.set('owner', voice); voices.set('friend', voice);
  await hub.ack(ws, { ...beforeMove, status: 'applied' });
  assert.equal((await moving).status, 'unavailable', 'moving together cannot acknowledge a command from the previous channel');
  voices.delete('owner');
  assert.equal((await hub.dispatch(friend, input)).status, 'forbidden', 'host outside voice does not share with friends');
  assert.deepEqual(await hub.list(friend), [], 'voice session stays private while host is outside voice');
  voices.delete('friend');
  assert.equal((await hub.dispatch(friend, input)).status, 'forbidden', 'two absent voice states must not match');
  assert.ok(resolve(hub.rooms.values(), actor, config, 'bob', Date.now(), hub.access).room);
  hub.update(ws, { ...s, mode: 'guild' });
  assert.equal(resolve(hub.rooms.values(), friend, config, 'bob', Date.now(), hub.access).status, 'forbidden', 'legacy guild mode cannot broaden access');
  voices.set('owner', voice); voices.set('friend', voice);
  const guildCommand = hub.dispatch(friend, input); await new Promise(resolve => setImmediate(resolve));
  const beforeDeparture = sent.at(-1); members.delete('friend');
  await hub.ack(ws, { ...beforeDeparture, status: 'applied' }); assert.equal((await guildCommand).status, 'unavailable');
  assert.equal((await hub.dispatch(friend, input)).status, 'forbidden');
  hub.close();
});

test('sharing changes cancel pending commands and private rooms do not create friend ambiguity', async () => {
  const { hub, ws, register, sent } = setup();
  hub.access = { refresh: async () => true, isMember: () => true, validVoiceChannel: () => true, voiceChannel: () => 'call' };
  const friend = { ...actor, userId: 'friend' }, publicSession = register('bob.livingroom');
  register('bob.private', false);
  hub.update(ws, { ...publicSession, mode: 'guild' });
  assert.equal(resolve(hub.rooms.values(), friend, config, undefined, Date.now(), hub.access).room.alias, 'bob.livingroom');
  assert.equal(resolve(hub.rooms.values(), friend, config, 'bob.private', Date.now(), hub.access).status, 'forbidden');
  const pending = hub.dispatch(friend, Engine.parse('!ubu pause')); await new Promise(resolve => setImmediate(resolve));
  const old = sent.at(-1);
  hub.update(ws, { ...publicSession, mode: 'owner', epoch: randomUUID() });
  assert.equal((await pending).status, 'unavailable'); await hub.ack(ws, { ...old, status: 'applied' });
  assert.equal(hub.pending.size, 0);
  hub.update(ws, { ...publicSession, mode: 'guild' });
  const second = register('bob.bedroom'); hub.update(ws, { ...second, mode: 'guild' });
  assert.equal((await hub.dispatch(friend, Engine.parse('!ubu pause'))).status, 'ambiguous');
  assert.ok(resolve(hub.rooms.values(), friend, config, 'bob.bedroom', Date.now(), hub.access).room);
  for (const denied of [{ ...friend, guildId: 'other' }, { ...friend, channelId: 'other' }]) {
    assert.equal((await hub.dispatch(denied, Engine.parse('!ubu pause'))).status, 'forbidden');
  }
  hub.close();
});

test('media seeking stays inside available DVR ranges and snapshots contain only validated state', () => {
  assert.equal(Engine.parse('!ubu seek -15').args.seconds, -15);
  assert.throws(() => Engine.parse('!ubu seek Infinity'));
  assert.throws(() => Engine.validate({ action: 'media.seek.relative', args: { seconds: 601 } }));
  assert.equal(Engine.seekTarget(25, [[10, 40]], -15), 10);
  assert.equal(Engine.seekTarget(35, [[10, 40]], 15), 39.99);
  assert.equal(Engine.seekTarget(12, [], 15), undefined);
  assert.equal(Engine.seekTarget(10, [[10, 40]], -15), undefined);
  assert.equal(Engine.seekTarget(20, [[10, 25], [40, 60]], 30), 50);
  const state = Engine.snapshot({ picture: { ...Engine.DEFAULT, secret: 'private title' }, title: 'private title', volume: 72, paused: true, profileSlots: [1, 1, 10] });
  assert.deepEqual(state.picture, Engine.DEFAULT); assert.equal(state.title, undefined); assert.deepEqual(state.profileSlots, [1]);
  assert.equal(Engine.snapshot({ picture: { ...Engine.DEFAULT, zoom: Infinity } }), undefined);
});

test('only the host web surface manages disabled sessions and commands still expire or cancel on restart', async () => {
  const { hub, ws, register, sent } = setup(), s = register('player', false);
  hub.access = { options: () => ({ available: true }), refresh: async () => true, isMember: () => true, voiceChannel:()=> 'call', validVoiceChannel:()=>true };
  const host = { ...actor, surface: 'web' }, input = { roomId: s.roomId, action: 'room.enable' };
  for (const denied of [actor, { ...host, userId: 'friend' }, { ...host, channelId: 'other' }]) assert.equal((await hub.dispatch(denied, input)).status, 'forbidden');
  assert.equal((await hub.dispatch(host, { ...input, action: 'media.pause' })).status, 'forbidden');
  const expired = hub.dispatch(host, input), old = sent.at(-1); hub.pending.get(old.id).sentAt -= 4000;
  await hub.ack(ws, { ...old, status: 'applied' }); assert.equal((await expired).status, 'unavailable');
  assert.equal(hub.rooms.get(s.roomId).enabled, false);
  const enabled = hub.dispatch(host, input), on = sent.at(-1); await hub.ack(ws, { ...on, status: 'applied' });
  assert.equal((await enabled).status, 'applied'); assert.equal(hub.rooms.get(s.roomId).enabled, true);
  const media = hub.dispatch(actor, { action: 'media.pause' });
  const policy = hub.dispatch(host, { ...input, action: 'room.sharing', args: { mode: 'guild' } }), change = sent.at(-1);
  await hub.ack(ws, { ...change, status: 'applied' }); assert.equal((await policy).status, 'applied');
  assert.equal((await media).status, 'unavailable', 'policy changes cancel earlier commands');
  const restart = hub.dispatch(host, input); hub.update(ws, { ...s, epoch: randomUUID() });
  assert.equal((await restart).status, 'unavailable'); assert.equal(hub.rooms.get(s.roomId).enabled, false);
  hub.close();
});

test('legacy room management aliases are rejected', () => {
  for (const [name, args] of Object.entries({enable:{},disable:{},sharing:{mode:'owner'},visibility:{visibility:'private'},controls:{control:'playback',allowed:false},autojoin:{enabled:true}})) {
    assert.throws(() => Engine.validate({action:'session.'+name,args}));
    assert.equal(Engine.validate({action:'room.'+name,args}).action,'room.'+name);
  }
  assert.throws(() => Engine.validate({action:'session.controls',args:{control:'playback',allowed:'yes'}}));
  assert.throws(() => Engine.validate({action:'session.unknown'}));
});
