'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createApp } = require('../server/app');
const { Hub } = require('../server/core');
const { Watch } = require('../server/watch');
const { Plex } = require('../server/plex');

test('server-owned playback uses the shared authorization engine, timeline, restart consent and idle expiry', async () => {
  const config = { ownerId: 'host', guildId: 'guild', channels: ['commands'] }, hub = new Hub(config, []);
  let member = true, voice = 'call';
  hub.access = { refresh: async () => member, isMember: () => member, voiceChannel: id => id === 'host' ? 'call' : voice,
    validVoiceChannel: id => id === 'call', options: () => ({ available: true }) };
  const watch = new Watch(hub, { stop: async () => {} }, { title: 'test', duration: 60, format: 'file', kind: 'demo' });
  const host = { userId: 'host', guildId: 'guild', channelId: 'commands', surface: 'web', name: 'Host' }, friend = { ...host, userId: 'friend', name: 'Friend' };
  const friendRoom = watch.rooms.get(watch.create(friend));
  assert.equal(friendRoom.s.hostId, friend.userId); assert.equal(friendRoom.s.ownerId, friend.userId);
  watch.remove(friendRoom.s.sessionId);
  assert.throws(() => watch.create({ ...friend, surface: 'discord' }));
  const id = watch.create(host), room = watch.rooms.get(id), viewer = randomUUID();
  const dispatch = (actor, action, args) => hub.dispatch(actor, { sessionId: id, action, args });
  assert.equal(room.s.enabled, false); assert.equal(room.s.mode, 'guild'); assert.equal(room.s.visibility, 'public');
  assert.equal((await watch.list(friend))[0].id, id, 'remote off does not hide a public viewing room');
  assert.deepEqual(await hub.list(friend), [], 'the remote only lists controllable players');
  assert.equal((await dispatch(friend, 'media.play')).status, 'forbidden');
  assert.equal((await dispatch(friend, 'room.visibility', { visibility: 'private' })).status, 'forbidden');
  await dispatch(host, 'room.visibility', { visibility: 'private' });
  assert.deepEqual(await hub.list(friend), []); assert.equal(await watch.canView(room, friend), false);
  await dispatch(host, 'room.visibility', { visibility: 'public' });
  watch.snapshot(room, host, viewer);
  assert.equal((await dispatch(host, 'media.load', { mediaId: 'demo', quality: 'direct' })).status, 'applied');
  await watch.ready(room, host, viewer, room.mediaVersion, true);
  assert.equal((await dispatch(host, 'media.play')).status, 'applied', 'host can play privately with remote off');
  assert.equal((await dispatch({ ...host, surface: 'discord' }, 'room.enable')).status, 'forbidden');
  await dispatch(host, 'room.sharing', { mode: 'voice' }); await dispatch(host, 'room.enable');
  assert.equal(await watch.canView(room, friend), true);
  assert.equal((await dispatch(friend, 'media.play')).status, 'applied');
  room.startAt = undefined; room.changedAt -= 5000; assert.ok(watch.position(room) >= 5);
  await dispatch(friend, 'media.pause'); const stopped = watch.position(room); assert.ok(stopped >= 5);
  await dispatch(friend, 'media.seek.absolute', { seconds: 42 }); assert.equal(watch.position(room), 42);
  room.position = room.media.duration; room.s.state.paused = true;
  assert.equal((await dispatch(friend, 'media.play')).status, 'applied');
  assert.ok(watch.position(room) < .1); assert.equal(room.s.state.paused, false, 'Play after the end restarts');
  room.position = room.media.duration; room.s.state.paused = false;
  assert.equal((await dispatch(friend, 'media.toggle')).status, 'applied');
  assert.ok(watch.position(room) < .1); assert.equal(room.s.state.paused, false, 'toggle at the end is a restart before the expiry sweep');
  await dispatch(friend, 'media.pause'); await dispatch(friend, 'media.seek.absolute', { seconds: 42 });
  assert.equal(watch.snapshot(room, friend, randomUUID()).state.position, 42, 'late join follows the authoritative timeline');
  await dispatch(host, 'room.controls', { control: 'playback', allowed: false });
  assert.equal((await dispatch(friend, 'media.pause')).status, 'forbidden');
  assert.equal((await dispatch(friend, 'zoom.set', { value: 1.2 })).status, 'applied');
  voice = 'other'; assert.equal(await watch.canView(room, friend), true, 'viewing is independent of remote Voice mode');
  assert.equal((await dispatch(friend, 'media.play')).status, 'forbidden');
  voice = 'call'; member = false; assert.equal(await watch.canView(room, friend), false);
  member = true; assert.equal((await dispatch(friend, 'room.disable')).status, 'forbidden');
  watch.snapshot(room, host, randomUUID()); assert.equal(room.s.enabled, false, 'host reload cannot restore sharing');
  await dispatch(host, 'room.enable'); room.viewers.clear(); room.lastActivity -= 11000; watch.sweep();
  assert.equal(room.s.enabled, false); assert.equal(room.s.state.paused, true);
  watch.close(); assert.equal(hub.rooms.size, 0);
  const restarted = new Watch(hub, {}, {}); assert.equal(restarted.rooms.size, 0);
});

test('each server member owns their watch session; administrators cannot manage or discover another private room', async () => {
  const hub = new Hub({ownerId:'admin',guildId:'guild',channels:['commands']}, []);
  const members = new Set(['admin','a','b']);
  hub.access = {refresh:async id=>members.has(id),isMember:id=>members.has(id),options:()=>({available:true})};
  const watch = new Watch(hub, {stop:async()=>{}});
  const actor = userId => ({userId,name:userId,guildId:'guild',channelId:'commands',surface:'web'});
  const a = actor('a'), b = actor('b'), admin = actor('admin'), id = watch.create(a), room = watch.rooms.get(id);
  const bRoom = watch.rooms.get(watch.create(b));
  const dispatch = (who, action, args) => hub.dispatch(who,{sessionId:id,action,args});
  assert.equal(watch.snapshot(room,a,randomUUID()).canManage,true);
  assert.equal(watch.snapshot(bRoom,b,randomUUID()).canManage,true);
  assert.equal((await dispatch(admin,'room.enable')).status,'forbidden');
  assert.equal((await dispatch(b,'room.controls',{control:'playback',allowed:false})).status,'forbidden');
  await dispatch(a,'room.visibility',{visibility:'private'});
  assert.equal(await watch.canView(room,admin),false); assert.equal(await watch.canView(room,b),false);
  assert.equal((await hub.list(admin)).some(s=>s.id===id),false);
  assert.equal((await hub.list(a)).some(s=>s.id===id),true);
  members.delete('a'); assert.equal(await watch.canView(room,a),false);
  assert.equal((await dispatch(a,'room.visibility',{visibility:'public'})).status,'forbidden');
  assert.throws(()=>watch.create(a)); assert.throws(()=>watch.create({...b,guildId:'other'}));
  watch.close();
});

test('watch controls require a current viewer or same-call member; locked Activity hints and Admin mode stay scoped', async () => {
  const config={ownerId:'admin',guildId:'guild',channels:['commands']},hub=new Hub(config,[]);
  const voices=new Map([['host','call'],['voice','call'],['admin','call']]);
  hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:id=>voices.get(id),validVoiceChannel:id=>id==='call',options:()=>({available:true})};
  let prepared, entered, release; const started=new Promise(r=>entered=r);
  const watch=new Watch(hub,{stop:async media=>{prepared=media;},prepare:async()=>{entered();return new Promise(r=>release=r);}},{kind:'demo',duration:60,title:'fixture'});
  const actor=userId=>({userId,name:userId,guildId:'guild',channelId:'commands',surface:'web'});
  const host=actor('host'),site=actor('site'),admin=actor('admin'),voice=actor('voice');
  const id=watch.create(host),room=watch.rooms.get(id),h=randomUUID(),v=randomUUID();watch.snapshot(room,host,h);
  const dispatch=(who,action,args)=>hub.dispatch(who,{sessionId:id,action,args});
  await dispatch(host,'media.load',{mediaId:'demo',quality:'direct'});await dispatch(host,'room.enable');
  assert.equal((await dispatch(site,'media.pause')).status,'forbidden','a server member must join the session or call');
  watch.snapshot(room,site,v);assert.equal((await dispatch({...site,surface:'discord'},'media.pause')).status,'applied','site viewers can use chat controls without voice');
  await watch.leave(room,site,v);assert.equal((await dispatch(site,'media.pause')).status,'forbidden','leaving removes viewer authority');
  assert.equal((await dispatch(voice,'media.pause')).status,'applied');voices.delete('voice');
  assert.equal((await dispatch(voice,'media.pause')).status,'forbidden');voices.set('voice','call');
  watch.snapshot(room,site,v);await dispatch(host,'room.visibility',{visibility:'private'});
  assert.equal(room.viewers.has(v),false,'Private removes other viewers immediately');
  assert.deepEqual(await watch.list(voice,false),[],'website cannot discover locked private rooms');
  const locked=(await watch.list(voice,true))[0];assert.equal(locked.locked,true);assert.equal(locked.hostName,'host');assert.equal(locked.viewers,1);
  for(const field of ['members','state','media','title'])assert.equal(field in locked,false);
  voices.delete('voice');assert.deepEqual(await watch.list(voice,true),[],'different call cannot discover private rooms');
  assert.equal(await watch.canView(room,admin),false);assert.equal((await dispatch({...admin,adminMode:true},'room.enable')).status,'forbidden','caller cannot forge Admin mode');
  assert.throws(()=>hub.setAdminMode(host,true));hub.setAdminMode(admin,true);
  assert.equal(await watch.canView(room,admin),true);assert.equal(watch.snapshot(room,admin,randomUUID()).canManage,true);
  room.s.enabled=false;room.s.controls.playback=false;
  assert.equal((await dispatch({...admin,surface:'discord'},'media.pause')).status,'applied','active Admin mode also applies to chat');
  const pending=dispatch(admin,'media.load',{mediaId:'11',quality:'direct'});await started;hub.setAdminMode(admin,false);release({id:'11',duration:60});
  assert.equal((await pending).status,'unavailable','turning Admin mode off cancels an in-flight privileged command');
  assert.equal(prepared.id,'11');assert.equal(room.media.id,'demo');assert.equal(await watch.canView(room,admin),false);
  assert.equal(new Hub(config,[]).adminMode,false,'Admin mode is not durable');watch.close();
});

test('Plex requests keep credentials server-side, restrict origins and prepare browser-compatible transcodes', async () => {
  const requests = [], token = 'private-fixture-token';
  const plex = new Plex({ plexUrl: 'http://127.0.0.1:32400', plexToken: token }, async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ type: 'movie', title: 'Movie', duration: 60000,
      Media: [{ Part: [{ key: '/library/parts/123/0/file.mp4' }] }] }] } }));
  });
  assert.throws(() => plex.url('https://attacker.example/video'));
  const direct = await plex.prepare('12', 'direct'); assert.equal(new URL(direct.start).searchParams.has('X-Plex-Token'), false);
  const transcode = await plex.prepare('12', '720p'); assert.equal(transcode.format, 'hls');
  const url = new URL(transcode.start); assert.equal(url.searchParams.get('videoResolution'), '1280x720'); assert.equal(url.searchParams.get('directPlay'), '0');
  const originalFallback = await plex.prepare('12', 'direct', true, direct);
  assert.equal(originalFallback.format, 'hls'); assert.equal(originalFallback.quality, 'direct'); assert.equal(originalFallback.compatible, true);
  assert.equal(new URL(originalFallback.start).searchParams.has('videoResolution'), false, 'Original fallback keeps source resolution');
  assert.notEqual(originalFallback.transcodeId, transcode.transcodeId);
  for (const request of requests.filter(x => x.url.pathname.endsWith('/decision'))) {
    assert.equal(request.options.headers['X-Plex-Client-Identifier'], request.url.searchParams.get('session'));
  }
  for (const request of requests) { assert.equal(request.options.headers['X-Plex-Token'], token); assert.equal(request.options.redirect, 'manual'); assert.equal(String(request.url).includes(token), false); }
  const refused = new Plex({plexUrl:'http://127.0.0.1:32400',plexToken:token}, async () => new Response(JSON.stringify({MediaContainer:{Metadata:[{Media:[{videoCodec:'hevc'}]}]}})));
  await assert.rejects(refused.prepare('12','720p',false,direct), /could not provide H.264/);
});

test('initial readiness honors deliberate pause; episode navigation and host succession preserve the room', async () => {
  const config = { ownerId: 'host', guildId: 'guild', channels: ['commands'] }, hub = new Hub(config, []);
  hub.access = { refresh: async () => true, isMember: () => true, voiceChannel: () => 'call', validVoiceChannel: () => true, options: () => ({ available: true }) };
  const plex = { stop: async () => {}, prepare: async (id, quality) => ({ id, title: 'Episode ' + id, subtitle: 'Show · Season 1 · 2026', duration: 120, quality, format: 'file',
    previousId: Number(id) > 1 ? String(Number(id) - 1) : undefined, nextId: Number(id) < 3 ? String(Number(id) + 1) : undefined }) };
  const watch = new Watch(hub, plex);
  const actor = id => ({ userId: id, guildId: 'guild', channelId: 'commands', surface: 'web', name: id });
  const host = actor('host'), a = actor('a'), b = actor('b'), late = actor('late');
  const id = watch.create(host), room = watch.rooms.get(id), hId = randomUUID(), aId = randomUUID(), bId = randomUUID(), lateId = randomUUID();
  const dispatch = (who, action, args) => hub.dispatch(who, { sessionId: id, action, args });
  watch.snapshot(room, host, hId);
  await dispatch(host, 'room.sharing', { mode: 'guild' }); await dispatch(host, 'room.enable');
  watch.snapshot(room, a, aId); room.viewers.get(aId).joinedAt -= 100;
  watch.snapshot(room, b, bId);
  assert.throws(() => watch.snapshot(room, b, aId), /identity mismatch/);
  await assert.rejects(watch.ready(room, b, aId, room.mediaVersion, true), /Invalid readiness/);
  await watch.leave(room, b, aId); assert.equal(room.viewers.has(aId), true, 'a viewer cannot remove someone else');
  await dispatch(host, 'media.load', { mediaId: '2', quality: 'direct' });
  const ready = (who, viewer) => watch.ready(room, who, viewer, room.mediaVersion, true);
  await ready(host, hId); await ready(a, aId); assert.equal(room.s.state.paused, true);
  await dispatch(host, 'media.pause'); await ready(b, bId); assert.equal(room.s.state.paused, true, 'readiness cannot undo an explicit pause');
  await dispatch(host, 'media.play'); await ready(b, bId); assert.equal(room.s.state.paused, false);
  watch.snapshot(room, late, lateId); assert.equal(room.s.state.paused, false, 'unready late joiner does not pause the group');
  await dispatch(host, 'media.pause'); await dispatch(host, 'media.seek.absolute', { seconds: 30 });
  await dispatch(a, 'media.previous'); assert.equal(room.media.id, '2'); assert.equal(room.position, 0);
  await dispatch(a, 'media.previous'); assert.equal(room.media.id, '1'); assert.equal(room.position, 0);
  await dispatch(a, 'media.next'); assert.equal(room.media.id, '2', 'next loads the next episode regardless of current position');
  await dispatch(host, 'media.pause'); await dispatch(host, 'media.seek.absolute', { seconds: 35 });
  await dispatch(host, 'media.quality.set', { quality: '1080p' }); assert.equal(room.position, 35); assert.equal(room.manualPaused, true);
  assert.equal(room.s.state.paused, true, 'quality changes retain pause and position');
  await dispatch(host, 'room.controls', { control: 'playback', allowed: false });
  const version = room.mediaVersion, epoch = room.s.epoch;
  await watch.leave(room, host, hId);
  assert.equal(room.s.hostId, 'a'); assert.equal(room.s.ownerId, 'host', 'administrator identity is not transferred');
  assert.equal(room.mediaVersion, version); assert.equal(room.position, 35); assert.equal(room.s.enabled, true);
  assert.equal(room.s.mode,'guild');assert.notEqual(room.s.epoch, epoch); assert.equal(room.s.controls.playback, false);
  assert.equal(watch.snapshot(room, a, aId).canManage, true); assert.equal(room.s.enabled, true, 'intentional handoff preserves remote enablement');
  assert.equal((await dispatch(host, 'media.load', { mediaId: '3', quality: 'direct' })).status, 'forbidden', 'former host cannot manage the inherited session');
  assert.equal((await dispatch(a, 'media.load', { mediaId: '3', quality: 'direct' })).status, 'applied');
  await watch.leave(room, a, aId); assert.equal(room.s.hostId, 'b');
  await watch.leave(room, late, lateId); await watch.leave(room, b, bId); assert.equal(watch.rooms.has(id), false);
});

test('host election skips revoked or expired viewers and respects session privacy', async () => {
  const hub = new Hub({ ownerId: 'host', guildId: 'guild', channels: ['commands'] }, []);
  hub.access = { refresh: async id => id !== 'revoked', isMember: () => true, voiceChannel: () => 'call', validVoiceChannel: () => true, options: () => ({ available: true }) };
  const watch = new Watch(hub, { stop: async () => {} });
  const actor = userId => ({ userId, guildId: 'guild', channelId: 'commands', surface: 'web', name: userId });
  const host = actor('host'), create = () => { const id = watch.create(host); return watch.rooms.get(id); };
  const room = create(), hostViewer = randomUUID();
  watch.snapshot(room, host, hostViewer); room.s.enabled = true; room.s.mode = 'guild';
  for (const id of ['expired', 'revoked', 'eligible']) {
    const viewer = randomUUID(); watch.snapshot(room, actor(id), viewer, async () => id !== 'expired');
    room.viewers.get(viewer).joinedAt += ['expired', 'revoked', 'eligible'].indexOf(id);
  }
  await watch.leave(room, host, hostViewer); assert.equal(room.s.hostId, 'eligible');
  watch.remove(room.s.sessionId);
  const privateRoom = create(), privateHost = randomUUID();
  watch.snapshot(privateRoom, host, privateHost); privateRoom.s.enabled = true; privateRoom.s.mode = 'guild';
  watch.snapshot(privateRoom, actor('eligible'), randomUUID()); privateRoom.s.visibility = 'private';
  await watch.leave(privateRoom, host, privateHost);
  assert.equal(watch.rooms.has(privateRoom.s.sessionId), false, 'revoked viewers cannot take over a private room');
  watch.close();
});

test('host heartbeat expiry revokes remote consent before a guest takes over', async () => {
  const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
  hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  const watch=new Watch(hub,{stop:async()=>{}});
  const actor=userId=>({userId,name:userId,guildId:'guild',channelId:'commands',surface:'web'});
  const host=actor('host'),guest=actor('guest'),id=watch.create(host),room=watch.rooms.get(id),hostId=randomUUID(),guestId=randomUUID();
  watch.snapshot(room,host,hostId);watch.snapshot(room,guest,guestId);
  assert.equal((await hub.dispatch(host,{sessionId:id,action:'room.enable'})).status,'applied');
  const epoch=room.s.epoch;
  room.viewers.get(hostId).at=Date.now()-11000;
  watch.refresh(room);
  assert.equal(room.s.enabled,false,'host timeout removes consent even while a guest keeps the room alive');
  assert.equal(room.s.mode,'owner');assert.notEqual(room.s.epoch,epoch,'stale commands cannot replay after disconnect');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(room.s.hostId,'guest');assert.equal(room.s.enabled,false,'successor must opt in to remote control');
  watch.close();
});

test('privacy removal releases the initial playback gate when the remaining host is ready', async () => {
  const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
  hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  const watch=new Watch(hub,{stop:async()=>{}},{title:'fixture',duration:60,format:'file',kind:'demo'});
  const actor=userId=>({userId,name:userId,guildId:'guild',channelId:'commands',surface:'web'});
  const host=actor('host'),guest=actor('guest'),id=watch.create(host),room=watch.rooms.get(id),hostId=randomUUID(),guestId=randomUUID();
  watch.snapshot(room,host,hostId);watch.snapshot(room,guest,guestId);
  assert.equal((await hub.dispatch(host,{sessionId:id,action:'media.load',args:{mediaId:'demo',quality:'direct'}})).status,'applied');
  await watch.ready(room,host,hostId,room.mediaVersion,true);
  assert.equal(room.initialGate,true,'unready guest holds the initial start');
  assert.equal((await hub.dispatch(host,{sessionId:id,action:'room.visibility',args:{visibility:'private'}})).status,'applied');
  assert.equal(room.viewers.has(guestId),false);
  assert.equal(room.initialGate,false);
  assert.equal(room.s.state.paused,false,'ready host starts after the guest is removed');
  watch.close();
});

test('a timed-out viewer can rejoin the same media with personal tracks but a fresh stream', () => {
  const hub = new Hub({ ownerId:'host', guildId:'guild', channels:['commands'] }, []);
  hub.access = { refresh:async()=>true, isMember:()=>true, voiceChannel:()=> 'call', validVoiceChannel:()=>true, options:()=>({available:true}) };
  const watch = new Watch(hub,{stop:async()=>{}});
  const actor = userId => ({userId,guildId:'guild',channelId:'commands',surface:'web',name:userId});
  const host=actor('host'),guest=actor('guest'),room=watch.rooms.get(watch.create(host)),hostId=randomUUID(),guestId=randomUUID();
  watch.snapshot(room,host,hostId);watch.snapshot(room,guest,guestId);
  const previous=room.viewers.get(guestId);
  previous.trackChoice={audioId:'1042',subtitleId:'off',audioIntent:{language:'fr'}};
  previous.quality='1080p';previous.subtitleOffset=2;previous.streamVersion=randomUUID();
  previous.at=Date.now()-11000;
  const oldEpoch=previous.observationEpoch;
  watch.refresh(room);
  assert.equal(room.viewers.has(guestId),false);
  assert.throws(()=>watch.snapshot(room,actor('other'),guestId),/identity mismatch/);
  const newTab=randomUUID();watch.snapshot(room,guest,newTab);
  assert.equal(room.viewers.get(newTab).trackChoice,undefined,'a new tab does not inherit personal choices');
  watch.snapshot(room,guest,guestId);
  const restored=room.viewers.get(guestId);
  assert.deepEqual(restored.trackChoice,previous.trackChoice);
  assert.equal(restored.quality,'1080p');assert.equal(restored.subtitleOffset,2);
  assert.notEqual(restored.observationEpoch,oldEpoch,'old playback observations cannot resume');
  assert.equal(restored.streamVersion,undefined,'a new personal stream must be prepared');
  assert.equal(room.s.enabled,false,'rejoin never enables remote control');
  restored.at=Date.now()-11000;watch.refresh(room);
  room.mediaVersion=randomUUID();watch.refresh(room);
  watch.snapshot(room,guest,guestId);
  assert.equal(room.viewers.get(guestId).trackChoice,undefined,'a changed title cannot reuse numeric track IDs');
  room.viewers.get(guestId).trackChoice={audioId:'1042'};
  room.viewers.get(guestId).at=Date.now()-11000;watch.refresh(room);
  room.disconnectedViewers.get(guestId).expires=Date.now()-1;
  watch.snapshot(room,guest,guestId);
  assert.equal(room.viewers.get(guestId).trackChoice,undefined,'expired reconnect state is ignored');
  room.viewers.get(guestId).trackChoice={audioId:'1042'};
  room.viewers.get(guestId).at=Date.now()-11000;watch.refresh(room);
  watch.leave(room,guest,guestId);
  watch.snapshot(room,guest,guestId);
  assert.equal(room.viewers.get(guestId).trackChoice,undefined,'explicit leave does not restore personal choices');
  watch.close();
});

test('an empty timed-out room admits only its eligible host tab and revokes old command and playback state', async () => {
  const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
  let member=true;
  hub.access={refresh:async()=>member,isMember:()=>member,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  const stopped=[],watch=new Watch(hub,{stop:async media=>{if(media)stopped.push(media);}});
  const host={userId:'host',name:'Host',surface:'web',guildId:'guild',channelId:'commands'},guest={...host,userId:'guest'};
  const id=watch.create(host),room=watch.rooms.get(id),viewerId=randomUUID();
  watch.snapshot(room,host,viewerId);
  const old=room.viewers.get(viewerId),oldEpoch=room.s.epoch;
  old.trackChoice={audioId:'12',subtitleId:'off'};old.quality='1080p';old.media={privateStream:true};old.streamVersion=randomUUID();
  old.at=Date.now()-11000;room.s.enabled=true;
  watch.refresh(room);
  assert.equal(watch.rooms.get(id),room);assert.equal(room.reconnecting,true);
  assert.equal(hub.rooms.has(id),false,'dormant rooms cannot receive commands');
  assert.equal((await hub.dispatch(host,{sessionId:id,action:'room.enable'})).status,'forbidden');
  assert.equal(room.s.enabled,false);assert.notEqual(room.s.epoch,oldEpoch);
  assert.deepEqual(stopped,[old.media]);assert.equal(room.viewers.size,0,'old media grants have no matching viewer');
  assert.equal(await watch.canView(room,guest),false);assert.deepEqual(await watch.list(guest,true),[]);
  assert.throws(()=>watch.snapshot(room,guest,viewerId),/identity mismatch/);
  assert.throws(()=>watch.snapshot(room,host,randomUUID()),/unavailable/);
  member=false;assert.equal(await watch.canView(room,host),false);
  assert.throws(()=>watch.snapshot(room,host,viewerId),/unavailable/);
  member=true;assert.equal(await watch.canView(room,host),true);
  watch.snapshot(room,host,viewerId);
  const restored=room.viewers.get(viewerId);
  assert.deepEqual(restored.trackChoice,old.trackChoice);assert.equal(restored.quality,'1080p');
  assert.notEqual(restored.observationEpoch,old.observationEpoch);assert.equal(restored.media,undefined);assert.equal(restored.streamVersion,undefined);
  assert.equal(hub.rooms.get(id),room.s);assert.equal(room.s.enabled,false);
  watch.close();
});

test('retained host rooms count toward the limit and expire on grace, media change, leave or close', async () => {
  const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
  hub.access={refresh:async()=>true,isMember:()=>true};
  const watch=new Watch(hub,{stop:async()=>{}}),host={userId:'host',name:'Host',surface:'web',guildId:'guild',channelId:'commands'};
  const timedOut=()=>{
    const room=watch.rooms.get(watch.create(host)),viewerId=randomUUID();watch.snapshot(room,host,viewerId);
    room.viewers.get(viewerId).at=Date.now()-11000;watch.refresh(room);return {room,viewerId};
  };
  const rooms=Array.from({length:4},timedOut);
  assert.throws(()=>watch.create(host),/Close an existing/);
  const [expired,changed,left,closed]=rooms;
  const deadline=expired.room.disconnectedViewers.get(expired.viewerId).expires;
  watch.refresh(expired.room,deadline-1);assert.equal(watch.rooms.has(expired.room.s.sessionId),true);
  watch.refresh(expired.room,deadline);assert.equal(watch.rooms.has(expired.room.s.sessionId),false);
  assert.throws(()=>watch.snapshot(expired.room,host,expired.viewerId),/unavailable/,'expired room cannot be resurrected');
  changed.room.mediaVersion=randomUUID();watch.refresh(changed.room);assert.equal(watch.rooms.has(changed.room.s.sessionId),false);
  await watch.leave(left.room,host,left.viewerId);assert.equal(watch.rooms.has(left.room.s.sessionId),false);
  watch.remove(closed.room.s.sessionId);assert.equal(watch.rooms.size,0);
  watch.close();
});

test('episode metadata uses the same subtitle and cross-season ordering for library and playback', async () => {
  const episodes = [
    { ratingKey: '10', type: 'episode', grandparentRatingKey: '99', title: 'First', grandparentTitle: 'Show', parentIndex: 1, index: 1, year: 2025 },
    { ratingKey: '11', type: 'episode', grandparentRatingKey: '99', title: 'Finale', grandparentTitle: 'Show', parentIndex: 1, index: 2, year: 2025 },
    { ratingKey: '12', type: 'episode', grandparentRatingKey: '99', title: 'New season', grandparentTitle: 'Show', parentIndex: 2, index: 1, year: 2026 }
  ];
  const plex = new Plex({ plexUrl: 'http://127.0.0.1:32400', plexToken: 'fixture' }, async () => new Response(JSON.stringify({ MediaContainer: { Metadata: episodes } })));
  assert.equal(plex.items([episodes[2]])[0].subtitle, 'Show · Season 2 · Episode 1 · 2026');
  assert.deepEqual(await plex.neighbors(episodes[1]), { previousId: '10', nextId: '12' });
  assert.equal(plex.subtitle({ type: 'movie', year: 2024 }), '2024');
});

test('watch quality and audio belong to an authenticated viewer; shared playback and picture still use permissions', async () => {
  const hub = new Hub({ ownerId:'host', guildId:'guild', channels:['commands'] }, []);
  hub.access = { refresh:async()=>true, isMember:()=>true, voiceChannel:()=>'call', validVoiceChannel:()=>true, options:()=>({available:true}) };
  const stopped = [], plex = { stop:async media=>stopped.push(media), prepare:async(id, quality, compatible)=>({id,quality,compatible,kind:'plex',duration:60,format:'hls',resources:new Map()}) };
  const watch = new Watch(hub, plex), host = {userId:'host',guildId:'guild',channelId:'commands',surface:'web'}, guest = {...host,userId:'guest'};
  const id = watch.create(host), room = watch.rooms.get(id), a = randomUUID(), b = randomUUID();
  watch.snapshot(room,host,a); room.s.enabled=true; room.s.mode='guild'; watch.snapshot(room,guest,b);
  room.media = {id:'12',kind:'plex',duration:60};
  await watch.prepareViewer(room,host,a); await watch.prepareViewer(room,guest,b);
  assert.notEqual(room.viewers.get(a).media,room.viewers.get(b).media,'each viewer has its own stream');
  const version=room.mediaVersion, other=room.viewers.get(a).media, guestOld=room.viewers.get(b).media;
  room.s.controls.playback=false;
  const command=(actor,viewerId,action,args)=>hub.dispatch({...actor,watchViewerId:viewerId},{sessionId:id,action,args});
  assert.equal((await command(guest,b,'media.pause')).status,'forbidden');
  assert.equal((await command(guest,b,'media.volume.set',{percent:25})).status,'applied');
  await command(guest,b,'media.mute');
  assert.equal(watch.snapshot(room,guest,b).state.volume,25); assert.equal(watch.snapshot(room,guest,b).state.muted,true);
  assert.equal(watch.snapshot(room,host,a).state.volume,50); assert.equal(room.s.state.muted,false);
  assert.equal((await command(guest,b,'media.quality.set',{quality:'1080p',compatible:true})).status,'applied');
  assert.equal(room.viewers.get(a).media,other); assert.equal(room.mediaVersion,version); assert.equal(room.viewers.get(b).media.quality,'1080p');
  assert.ok(stopped.includes(guestOld));
  assert.equal((await command(guest,a,'media.mute')).status,'unsupported','cannot spoof another viewer');
  assert.equal((await hub.dispatch({...host,surface:'discord'},{sessionId:id,action:'media.mute'})).status,'unsupported','unaddressed personal settings cannot mute the room');
  assert.equal((await command(guest,b,'zoom.set',{value:1.2})).status,'applied');
  room.s.enabled=false;
  assert.equal((await command(guest,b,'media.quality.set',{quality:'720p'})).status,'applied','personal quality works with remote off');
  room.s.visibility = 'private';
  assert.equal((await command(guest,b,'media.quality.set',{quality:'720p'})).status,'forbidden','personal quality never bypasses privacy');
  const personal = room.viewers.get(b); personal.compatible = true; personal.fallback = 'av1';
  watch.dropMedia(room);
  assert.equal(personal.compatible,false,'new content gets a fresh compatibility decision');
  assert.equal(personal.fallback,undefined); assert.equal(personal.quality,'720p','personal quality survives new content');
  watch.close();
});

test('slow personal quality preparation has a bounded completion budget and retains live authorization',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  for(const outcome of ['success','expired','stale-input','epoch','left','media','logout','access']) {
    const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
    hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
    let finish,started,live=true,allowed=true;
    const preparing=new Promise(resolve=>{started=resolve;}),stopped=[];
    const replacement={kind:'plex',id:'12',duration:60,format:'hls',quality:'720p4'};
    const plex={stop:async media=>stopped.push(media),prepare:async()=>{started();await new Promise(resolve=>{finish=resolve;});return replacement;}};
    const watch=new Watch(hub,plex),host={userId:'host',guildId:'guild',channelId:'commands',surface:'web'};
    const id=watch.create(host),room=watch.rooms.get(id),viewerId=randomUUID();
    watch.snapshot(room,host,viewerId,async()=>live);
    room.media={kind:'plex',id:'12',duration:60};
    const viewer=room.viewers.get(viewerId),old={kind:'plex',duration:60};viewer.media=old;viewer.mediaVersion=room.mediaVersion;
    const originalCanView=watch.canView.bind(watch);watch.canView=async(...args)=>allowed&&await originalCanView(...args);
    const command=(action,args,expiresAt=now+2500)=>hub.dispatch({...host,watchViewerId:viewerId},{sessionId:id,action,args,expiresAt});
    const result=command('media.quality.set',{quality:'720p4'},outcome==='stale-input'?now-1:now+2500);
    if(outcome==='stale-input') {
      assert.equal((await result).status,'unavailable');assert.equal(viewer.media,old);watch.close();hub.close();continue;
    }
    await preparing;now+=4000;
    // Polling and room controls stay independent of private Plex preparation.
    watch.snapshot(room,host,viewerId,async()=>live);
    assert.equal((await command('media.pause')).status,'applied');
    assert.equal((await command('media.quality.set',{quality:'1080p'})).status,'unavailable','no concurrent replacement');
    if(outcome==='expired')now+=26001;
    if(outcome==='epoch')room.s.epoch=randomUUID();
    if(outcome==='left')room.viewers.delete(viewerId);
    if(outcome==='media')room.mediaVersion=randomUUID();
    if(outcome==='logout')live=false;
    if(outcome==='access')allowed=false;
    finish();assert.equal((await result).status,outcome==='success'?'applied':'unavailable',outcome);
    assert.equal(viewer.media,outcome==='success'?replacement:old,outcome);
    assert.ok(stopped.includes(outcome==='success'?old:replacement),'discard unused stream');
    assert.equal(viewer.updating,false);
    watch.close();hub.close();
  }
});

test('HLS recovery replaces only the authorized viewer stream and preserves personal tracks and room intent',async()=>{
  const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
  hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  const prepared=[],stopped=[];
  const plex={prepare:async(id,quality,compatible,source,fallback,choices)=>{
    const media={id,kind:'plex',format:'hls',duration:60,quality,selection:{audio:{id:choices.audioId},subtitle:{id:choices.subtitleId}}};
    prepared.push({media,choices});return media;
  },stop:async media=>stopped.push(media)};
  const watch=new Watch(hub,plex),host={userId:'host',guildId:'guild',channelId:'commands',surface:'web'},guest={...host,userId:'guest'};
  const id=watch.create(host),room=watch.rooms.get(id),a=randomUUID(),b=randomUUID();
  watch.snapshot(room,host,a);watch.snapshot(room,guest,b);
  room.media={id:'104',kind:'plex',duration:60};room.position=18;room.manualPaused=true;room.s.state.paused=true;
  await watch.prepareViewer(room,host,a);await watch.prepareViewer(room,guest,b);
  const viewer=room.viewers.get(b),other=room.viewers.get(a).media,old=viewer.media,version=room.mediaVersion,epoch=room.s.epoch;
  viewer.trackChoice={audioId:'1042',subtitleId:'1044'};
  const command=(actor,viewerId,args)=>hub.dispatch({...actor,watchViewerId:viewerId},{sessionId:id,action:'media.stream.refresh',args});
  const args={mediaVersion:version,streamVersion:viewer.streamVersion};
  assert.equal((await command(guest,b,args)).status,'applied');
  assert.notEqual(viewer.media,old);assert.equal(room.viewers.get(a).media,other);
  assert.equal(prepared.at(-1).choices.audioId,'1042');assert.equal(prepared.at(-1).choices.subtitleId,'1044');
  assert.equal(room.position,18);assert.equal(room.manualPaused,true);assert.equal(room.s.state.paused,true);
  assert.equal(room.s.enabled,false);assert.equal(room.s.epoch,epoch);assert.equal(room.mediaVersion,version);
  assert.ok(stopped.includes(old));
  assert.equal((await command(guest,b,args)).status,'unavailable','stale stream cannot replace its successor');
  assert.equal((await command(guest,a,{mediaVersion:version,streamVersion:room.viewers.get(a).streamVersion})).status,'unsupported','viewer identity is bound to the actor');
  let release;
  plex.prepare=async()=>new Promise(resolve=>{release=()=>resolve({id:'104',kind:'plex',format:'hls',duration:60});});
  const active=viewer.media,pending=command(guest,b,{mediaVersion:version,streamVersion:viewer.streamVersion});
  for(let i=0;i<10&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(release,'refresh entered preparation');
  room.s.visibility='private';
  release();
  assert.equal((await pending).status,'unavailable','revoked permission cancels an in-flight refresh');
  assert.equal(viewer.media,active,'revocation keeps the old player attached until normal access cleanup');
  assert.equal((await command(guest,b,{mediaVersion:version,streamVersion:viewer.streamVersion})).status,'forbidden');
  watch.close();
});

test('real HTTPS watch endpoints reject impersonation, stale commands and revoked media grants', { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) }, async t => {
  const cert = fs.readFileSync(path.join(__dirname, '../certs/server-cert.pem'));
  const config = { cert, key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')), publicUrl: 'https://localhost:6768',
    ownerId: 'host', guildId: 'guild', channels: ['commands'], demo: true, clientId: '123456789012345678', clientSecret: 'fixture-secret' };
  const app = createApp(config, { oauthFetch: async url => new Response(JSON.stringify(url.endsWith('/token') ? { access_token: 'discord-fixture' } : { id: 'demo-guest', username: 'Verified guest' })) }); let member = true;
  app.hub.access = { refresh: async () => member, isMember: () => member, voiceChannel: () => 'call', validVoiceChannel: () => true, options: () => ({ available: true }) };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const port = app.server.address().port; config.publicUrl = `https://localhost:${port}`;
  async function request(route, method = 'GET', data, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'localhost', port, path: route, method, ca: cert, headers: { 'Content-Type': 'application/json', Origin: config.publicUrl, ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
          const raw = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: res.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) : raw });
        });
      }); req.on('error', reject); req.end(data && JSON.stringify(data));
    });
  }
  assert.equal((await request('/api/watch/rooms')).status, 401);
  const testPage = await request('/watch/test');
  assert.equal(testPage.status, 200); assert.match(testPage.headers['content-security-policy'], /frame-ancestors 'self' https:\/\/discord.com/);
  assert.match(testPage.headers['content-security-policy'], /frame-src 'self'/);
  assert.match(testPage.body.toString(), /Copy diagnostics/);
  const testVideo = await request('/watch/test/sample.mp4', 'GET', undefined, {Range:'bytes=0-15'});
  assert.equal(testVideo.status, 206); assert.equal(testVideo.body.length, 16);
  assert.equal(testVideo.headers['content-type'], 'video/mp4');
  assert.equal((await request('/watch/test/sample.mp4', 'HEAD')).status, 200);
  assert.equal((await request('/watch/test/sample.mp4', 'GET', undefined, {Range:'bytes=999999999-'})).status, 416);
  const activityOrigin = `https://${config.clientId}.discordsays.com`;
  assert.equal((await request('/api/watch/activity-login', 'POST', { code: 'fixture' })).status, 403, 'web origin cannot impersonate an Activity login');
  const activityLogin = (await request('/api/watch/activity-login', 'POST', { code: 'fixture', userId: 'host', owner: true }, { Origin: activityOrigin })).body;
  assert.equal(activityLogin.owner, false, 'Activity identity comes from Discord, not caller JSON');
  assert.equal(activityLogin.name, 'Verified guest');
  const activityHeaders = { Origin: activityOrigin, Authorization: 'Bearer ' + activityLogin.token };
  const created = await request('/api/watch/rooms', 'POST', {userId:'host'}, activityHeaders);
  assert.equal(created.status, 201, 'verified member can create a room');
  assert.equal(app.watch.rooms.get(created.body.id).s.hostId, 'demo-guest', 'creator comes from verified identity');
  assert.equal((await request('/api/watch/library?session=' + created.body.id, 'GET', undefined, activityHeaders)).status, 200);
  app.watch.remove(created.body.id);
  for (const route of ['/', '/activity', '/watch/test', '/auth/discord']) {
    const redirected = await request(route + '?frame_id=fixture');
    assert.equal(redirected.status, 302); assert.equal(redirected.headers.location, '/watch?frame_id=fixture');
  }
  const embeddedTest = await request('/watch/test?frame_id=fixture&embedded=1','GET',undefined,{'Sec-Fetch-Dest':'iframe'});
  assert.equal(embeddedTest.status,200,'Activity can embed the public diagnostic inside watch');
  assert.match(embeddedTest.body.toString(),/Codec playback test/);
  assert.equal((await request('/watch/test?frame_id=fixture&embedded=1')).status,302,'Top-level Activity navigation still stays on watch');
  member = false;
  assert.equal((await request('/api/watch/activity-login', 'POST', { code: 'fixture' }, { Origin: activityOrigin })).status, 403);
  assert.equal((await request('/api/watch/me', 'GET', undefined, activityHeaders)).status, 401, 'existing Activity login is revoked for a removed member');
  assert.equal((await request('/api/watch/rooms', 'POST', {}, activityHeaders)).status, 401);
  member = true;
  const hostLogin = (await request('/api/watch/demo-login', 'POST', { persona: 'host' })).body;
  const guestLogin = (await request('/api/watch/demo-login', 'POST', { persona: 'guest' })).body;
  const host = { Authorization: 'Bearer ' + hostLogin.token }, guest = { Authorization: 'Bearer ' + guestLogin.token };
  assert.equal((await request('/api/watch/admin-mode','POST',{enabled:true,userId:'host'},guest)).status,403);
  assert.equal(app.hub.adminMode,false);
  const guestCreated = (await request('/api/watch/rooms', 'POST', { userId: 'host' }, guest)).body.id;
  assert.equal(app.watch.rooms.get(guestCreated).s.hostId, 'demo-guest'); app.watch.remove(guestCreated);
  assert.equal((await request('/api/watch/rooms', 'POST', {}, { ...host, Origin: 'https://evil.example' })).status, 401);
  const id = (await request('/api/watch/rooms', 'POST', {}, host)).body.id, viewer = randomUUID();
  const getState = () => request(`/api/watch/rooms/${id}?viewer=${viewer}`, 'GET', undefined, host);
  const command = async (action, args) => {
    const state = (await getState()).body;
    return request(`/api/watch/rooms/${id}/command`, 'POST', { epoch: state.epoch, expiresAt: Date.now() + 2500, command: { action, args } }, host);
  };
  assert.equal((await request('/api/watch/rooms', 'GET', undefined, guest)).body.rooms[0].id, id);
  assert.equal((await command('media.load', { mediaId: 'demo', quality: 'direct' })).body.status, 'applied');
  const observedState=(await getState()).body;
  assert.ok(observedState.timing.serverSentAt>=observedState.timing.serverReceivedAt);
  assert.ok(observedState.serverNow>=observedState.timing.serverReceivedAt && observedState.serverNow<=observedState.timing.serverSentAt);
  assert.ok(Math.abs(observedState.timing.serverSentAt-observedState.timing.serverReceivedAt-observedState.timing.serverProcessingMs)<5);
  assert.equal((await getState()).body.timing.clockEpoch,observedState.timing.clockEpoch);
  assert.equal((await request('/playback-timing.js')).status,200,'timing module is served to the player');
  const observation={viewerId:viewer,mediaVersion:observedState.mediaVersion,streamVersion:observedState.streamVersion,observationEpoch:observedState.observationEpoch,sequence:1,sampleAt:1000,observedAt:Date.now(),position:0,state:'paused',frames:0,rate:1,discontinuity:0,userId:'demo-guest',mediaId:'fake'};
  const observe= (data,headers=host)=>request(`/api/watch/rooms/${id}/observe`,'POST',data,headers);
  assert.equal((await observe(observation,guest)).status,403,'another account cannot report this viewer');
  assert.equal((await observe(observation,{...host,Origin:'https://evil.example'})).status,401);
  const acceptedObservation=await observe(observation);
  assert.equal(acceptedObservation.status,200);assert.equal(acceptedObservation.body.credit.reason,'baseline');
  const replayObservation=await observe(observation);
  assert.equal(replayObservation.status,409,'report replay rejected');assert.equal(replayObservation.body.rejection,'sequence-replayed');
  const originalObserve=app.watch.tracking.observe;
  try {
    app.watch.tracking.observe=()=>{throw new Error('secret database path and token');};
    const failed=await observe({...observation,sequence:2,sampleAt:2000});
    assert.equal(failed.status,503);assert.equal(failed.body.rejection,'storage-failure');assert.ok(!JSON.stringify(failed.body).includes('secret'));
  } finally {app.watch.tracking.observe=originalObserve;}
  const ownHistory=(await request('/api/watch/playback','GET',undefined,host)).body;
  assert.equal(ownHistory.sessions[0].userId,'host');assert.equal(ownHistory.sessions[0].mediaId,'demo','server derives media');
  assert.equal((await request('/api/watch/playback?userId=host','GET',undefined,guest)).body.sessions.length,0,'history is private to the authenticated account');
  await command('room.sharing', { mode: 'guild' }); await command('room.enable');
  const guestViewer = randomUUID();
  const guestState = (await request(`/api/watch/rooms/${id}?viewer=${guestViewer}`, 'GET', undefined, guest)).body;
  const media = await request(guestState.mediaUrl, 'GET', undefined, { Range: 'bytes=0-15' });
  assert.equal(media.status, 206); assert.equal(media.body.length, 16); assert.match(media.headers['content-range'], /^bytes 0-15\//);
  const stale = await request(`/api/watch/rooms/${id}/command`, 'POST', { epoch: randomUUID(), expiresAt: Date.now() + 2000, command: { action: 'media.play' } }, guest);
  assert.equal(stale.status, 409);
  member = false; assert.equal((await request(guestState.mediaUrl)).status, 403);
  member = true; await command('room.disable'); assert.equal((await request(guestState.mediaUrl)).status, 200, 'remote off leaves public media accessible');
  const replacementLogin = (await request('/api/watch/demo-login','POST',{persona:'guest'})).body;
  assert.ok(replacementLogin.expiresAt>Date.now());
  const replacementGuest = {Authorization:'Bearer '+replacementLogin.token};
  const replacementState = (await request(`/api/watch/rooms/${id}?viewer=${guestViewer}`,'GET',undefined,replacementGuest)).body;
  assert.equal(replacementState.streamVersion,guestState.streamVersion,'identity renewal retains the personal stream');
  assert.notEqual(replacementState.mediaUrl,guestState.mediaUrl,'identity renewal rotates the media grant');
  assert.equal((await request(guestState.mediaUrl)).status,403,'old identity grant is revoked');
  assert.equal((await request(replacementState.mediaUrl)).status,200);
  await command('room.visibility', {visibility:'private'}); assert.equal((await request(replacementState.mediaUrl)).status, 403);
  const privateState = await request(`/api/watch/rooms/${id}?viewer=${randomUUID()}`, 'GET', undefined, guest); assert.equal(privateState.status, 403);
  const placeholder=(await request('/api/watch/rooms','GET',undefined,activityHeaders)).body.rooms[0];
  assert.equal(placeholder.locked,true);assert.equal(placeholder.id,id);assert.equal('members' in placeholder,false);
  assert.deepEqual((await request('/api/watch/rooms?activity=true','GET',undefined,guest)).body.rooms,[],'website query cannot opt into private hints');
  const other=(await request('/api/watch/rooms','POST',{},guest)).body.id;
  let otherState=(await request(`/api/watch/rooms/${other}?viewer=${randomUUID()}`,'GET',undefined,guest)).body;
  await request(`/api/watch/rooms/${other}/command`,'POST',{epoch:otherState.epoch,expiresAt:Date.now()+2000,command:{action:'room.visibility',args:{visibility:'private'}}},guest);
  assert.equal((await request(`/api/watch/rooms/${other}?viewer=${randomUUID()}`,'GET',undefined,host)).status,403);
  assert.equal((await request('/api/watch/admin-mode','POST',{enabled:true},host)).status,200);
  assert.equal((await request('/api/watch/me','GET',undefined,host)).body.adminMode,true);
  otherState=(await request(`/api/watch/rooms/${other}?viewer=${randomUUID()}`,'GET',undefined,host)).body;
  assert.equal(otherState.canManage,true);assert.equal(otherState.isHost,false);
  assert.equal((await request(`/api/watch/rooms/${other}/close`,'POST',{},host)).status,200);
  await request('/api/watch/admin-mode','POST',{enabled:false},host);
  // AV1 resources reuse the same private grant, identity and stream revision.
  const room = app.watch.rooms.get(id), local = room.viewers.get(viewer);
  room.mediaVersion = randomUUID(); room.position = 0; room.s.state.paused = true;
  app.watch.plex.av1.ffmpeg = 'fixture-only';
  const av1 = {kind:'plex',format:'av1',videoCodec:'av1',duration:180,av1Lease:app.watch.plex.av1.acquire({id:'123',duration:180},'direct')};
  room.media = {...room.media,duration:180};
  local.media = av1; local.mediaVersion = room.mediaVersion; local.streamVersion = randomUUID();
  let chunks = 0;
  app.watch.plex.av1.chunk = async () => { chunks++; return {video:Buffer.from('private fixture webm'),audio:Buffer.from('opus')}; };
  const av1State = (await getState()).body, base = av1State.mediaUrl.replace(/\/start$/, '/chunk-video-');
  assert.equal((await request(base + '0')).status, 200);
  assert.equal((await request(base + '10')).status, 200, 'bounded ahead buffer is available while paused');
  assert.equal((await request(base + '11')).status, 403, 'prefetch cannot exceed the shared ahead window');
  assert.equal((await request(base + '100')).status, 403, 'AV1 cannot transcode an arbitrary offset');
  assert.equal(chunks,2);
  room.position = 120; room.s.state.duration = 180;
  assert.equal((await request(base + '14')).status,403,'old rewind chunks are outside the authorized window');
  assert.equal((await request(base + '15')).status,200,'recent rewind window remains available');
  local.streamVersion = randomUUID();
  assert.equal((await request(base + '0')).status, 403, 'quality replacement invalidates AV1 grants');
  const renewed = (await getState()).body;
  app.watch.remove(id);
  assert.equal((await request(renewed.mediaUrl)).status, 403, 'room removal revokes AV1 manifests');
  const transferId=(await request('/api/watch/rooms','POST',{},host)).body.id;
  const transferHostId=randomUUID(),transferGuestId=randomUUID();
  const transferHostState=(await request(`/api/watch/rooms/${transferId}?viewer=${transferHostId}`,'GET',undefined,host)).body;
  await request(`/api/watch/rooms/${transferId}?viewer=${transferGuestId}`,'GET',undefined,guest);
  assert.equal((await request(`/api/watch/rooms/${transferId}/command`,'POST',{
    epoch:transferHostState.epoch,expiresAt:Date.now()+2000,command:{action:'room.enable'}
  },host)).body.status,'applied');
  const oldEpoch=app.watch.rooms.get(transferId).s.epoch;
  assert.equal((await request(`/api/watch/rooms/${transferId}/leave`,'POST',{viewerId:transferHostId},host)).status,200);
  const successor=(await request(`/api/watch/rooms/${transferId}?viewer=${transferGuestId}`,'GET',undefined,guest)).body;
  assert.equal(successor.isHost,true);assert.equal(successor.enabled,true);
  assert.notEqual(successor.epoch,oldEpoch);
  assert.equal((await request(`/api/watch/rooms/${transferId}/command`,'POST',{
    epoch:oldEpoch,expiresAt:Date.now()+2000,command:{action:'room.enable'}
  },guest)).status,409,'the old host epoch cannot apply commands after transfer');
  app.watch.remove(transferId);
});

test('intentional host leave preserves disabled remote settings while logout revokes consent', async () => {
  for (const [reason, enabled, mode, expectedMode] of [['left',false,'voice','voice'],['logout',true,'guild','owner']]) {
    const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
    hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true};
    const watch=new Watch(hub,{stop:async()=>{}});
    try {
      const actor=userId=>({userId,name:userId,guildId:'guild',channelId:'commands',surface:'web'});
      const host=actor('host'),guest=actor('guest'),room=watch.rooms.get(watch.create(host)),hostId=randomUUID(),guestId=randomUUID();
      watch.snapshot(room,host,hostId);watch.snapshot(room,guest,guestId);
      room.s.enabled=enabled;room.s.mode=mode;const epoch=room.s.epoch;
      await watch.leave(room,host,hostId,reason);
      assert.equal(room.s.hostId,'guest');assert.equal(room.s.enabled,false);
      assert.equal(room.s.mode,expectedMode);assert.notEqual(room.s.epoch,epoch);
      assert.equal(watch.snapshot(room,guest,guestId).enabled,false,'handoff never enables an off remote');
    } finally {watch.close();}
  }
});


test('shared seeks wait for fresh viewer buffers and reject superseded readiness', async () => {
  const hub = new Hub({ownerId:'host',guildId:'guild',channels:['commands']}, []);
  hub.access = {isMember:()=>true, refresh:async()=>true};
  const watch = new Watch(hub, {stop:async()=>{}}, {title:'fixture',duration:120,format:'file',kind:'demo'});
  const host = {userId:'host',name:'Host',guildId:'guild',channelId:'commands',surface:'web'};
  const room = watch.rooms.get(watch.create(host)), first = randomUUID(), second = randomUUID();
  watch.snapshot(room,host,first); watch.snapshot(room,host,second);
  const dispatch = (action,args) => hub.dispatch(host,{sessionId:room.s.sessionId,action,args});
  const ready = viewer => watch.ready(room,host,viewer,room.mediaVersion,true,room.readinessVersion);
  assert.equal((await dispatch('media.load',{mediaId:'demo',quality:'direct'})).status,'applied');
  await ready(first); await ready(second);
  assert.equal(room.s.state.paused,false);
  await dispatch('media.seek.absolute',{seconds:40});
  assert.equal(room.s.state.paused,true); assert.equal(watch.position(room),40);
  const old = room.readinessVersion;
  await ready(first); assert.equal(room.s.state.paused,true);
  await dispatch('media.seek.relative',{seconds:10});
  await assert.rejects(watch.ready(room,host,second,room.mediaVersion,true,old), /Invalid readiness/);
  await ready(second); assert.equal(room.s.state.paused,true);
  await ready(first); assert.equal(room.s.state.paused,false);
  assert.equal(room.position,50); assert.ok(room.startAt > Date.now());
  await watch.ready(room,host,second,room.mediaVersion,false,room.readinessVersion);
  assert.equal(room.s.state.paused,false,'ordinary buffering does not stop healthy viewers');
  await dispatch('media.seek.start'); await dispatch('media.pause');
  await ready(first); await ready(second);
  assert.equal(room.s.state.paused,true,'explicit pause cancels automatic resume');
  await dispatch('media.play'); assert.equal(room.s.state.paused,false);
  await dispatch('media.seek.absolute',{seconds:60});
  await ready(first); await watch.leave(room,host,second);
  assert.equal(room.s.state.paused,false,'departed viewers do not hold the seek gate');
  watch.close();
});


test('toggle treats startup and seek readiness as playing intent', async () => {
  const hub = new Hub({ownerId:'host',guildId:'guild',channels:['commands']}, []);
  hub.access = {isMember:()=>true,refresh:async()=>true};
  const watch = new Watch(hub,{stop:async()=>{}},{title:'fixture',duration:60,format:'file',kind:'demo'});
  const host = {userId:'host',name:'Host',guildId:'guild',channelId:'commands',surface:'web'};
  const room = watch.rooms.get(watch.create(host)), viewer = randomUUID();
  watch.snapshot(room,host,viewer);
  const dispatch = (action,args) => hub.dispatch(host,{sessionId:room.s.sessionId,action,args});
  await dispatch('media.load',{mediaId:'demo',quality:'direct'});
  assert.equal(watch.snapshot(room,host,viewer).state.waitingForReady,true);
  await dispatch('media.toggle');
  assert.equal(room.manualPaused,true,'toggle deliberately pauses pending startup');
  await watch.ready(room,host,viewer,room.mediaVersion,true);
  assert.equal(room.s.state.paused,true);
  assert.equal(watch.snapshot(room,host,viewer).state.waitingForReady,false);
  await dispatch('media.toggle');
  assert.equal(room.s.state.paused,false);
  await dispatch('media.seek.relative',{seconds:15});
  assert.equal(watch.snapshot(room,host,viewer).state.waitingForReady,true);
  await dispatch('media.toggle');
  assert.equal(room.manualPaused,true,'toggle deliberately pauses pending seek');
  await watch.ready(room,host,viewer,room.mediaVersion,true,room.readinessVersion);
  assert.equal(room.s.state.paused,true);
  await dispatch('media.toggle');
  assert.equal(room.s.state.paused,false);
  watch.close();
});
