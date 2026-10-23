'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Engine = require('../shared/engine');
const { Hub, resolve, hash, PRESENCE_MS } = require('../server/core');
const config = { ownerId: 'owner', guildId: 'guild', channels: ['commands'] };
const actor = { userId: 'owner', guildId: 'guild', channelId: 'commands' };
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
test('seek boundaries respect the available DVR window and disjoint recordings', () => {
  const ranges = [[130,200],[10,50],[60,90]];
  assert.equal(Engine.seekBoundary(ranges,'start'),10);
  assert.equal(Engine.seekBoundary(ranges,'end'),199.99);
  assert.equal(Engine.seekBoundary([[4,4.005]],'end'),4,'tiny ranges never seek before their beginning');
  for (const ranges of [[],[[0,Infinity]],[[NaN,10]],[[50,10]]]) assert.equal(Engine.seekBoundary(ranges,'start'),undefined);
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

test('legacy room management aliases are rejected', () => {
  for (const [name, args] of Object.entries({enable:{},disable:{},sharing:{mode:'owner'},visibility:{visibility:'private'},controls:{control:'playback',allowed:false},autojoin:{enabled:true}})) {
    assert.throws(() => Engine.validate({action:'session.'+name,args}));
    assert.equal(Engine.validate({action:'room.'+name,args}).action,'room.'+name);
  }
  assert.throws(() => Engine.validate({action:'session.controls',args:{control:'playback',allowed:'yes'}}));
  assert.throws(() => Engine.validate({action:'session.unknown'}));
});

test('current queue removal validates its optional advance intent', () => {
  const entryId = randomUUID();
  assert.equal(Engine.validate({action:'queue.remove',args:{entryId,advance:true}}).args.advance,true);
  assert.equal(Engine.validate({action:'queue.remove',args:{entryId,advance:false}}).args.advance,false);
  assert.equal(Object.hasOwn(Engine.validate({action:'queue.remove',args:{entryId}}).args,'advance'),false);
  assert.throws(() => Engine.validate({action:'queue.remove',args:{entryId,advance:'true'}}),/advance/);
});

test('live watch rooms use the shared engine and reject removed management actions', async () => {
  const hub = new Hub(config);
  hub.access = {refresh: async()=>true, isMember:()=>true};
  const host = {...actor,surface:'web'};
  const guest = {...actor,userId:'friend',surface:'web'};
  const roomId = randomUUID(), room = {
    kind:'watch',roomId,epoch:randomUUID(),alias:'livingroom',ownerId:'owner',
    hostId:'owner',hostName:'owner',ownerName:'owner',visibility:'public',
    lastSeen:Date.now(),reachable:true,socket:{readyState:1},
    controls:{...Engine.CONTROLS},state:{picture:{...Engine.DEFAULT},paused:true,muted:false,volume:50,seekable:false},
    execute:async command=>({status:'applied',message:command.action})
  };
  hub.rooms.set(roomId,room);
  assert.equal((await hub.list(guest))[0].id,roomId);
  assert.equal((await hub.dispatch(host,{roomId,action:'media.pause'})).status,'applied');
  assert.equal((await hub.dispatch(guest,{roomId,action:'media.pause'})).status,'applied');
  room.controls.playback=false;
  assert.equal((await hub.dispatch(guest,{roomId,action:'media.pause'})).status,'forbidden');
  for(const action of ['room.enable','room.disable','room.sharing','room.autojoin','room.controls'])
    assert.throws(()=>Engine.validate({action}),/Unsupported/);
  assert.throws(()=>Engine.parse('!ubu off'),/Unsupported|Unknown/);
  hub.close();
});
