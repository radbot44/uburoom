'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Watch}=require('../server/watch'),{Hub}=require('../server/core');
const {PlaybackError}=require('../server/av1');

for(const operation of ['initial','quality','tracks','refresh'])test(operation+' replacement fences stale work and owns discarded streams',async()=>{
  for(const outcome of ['success','media','viewer','stream','revoked','logout','expired','failure']){
    let access=true,live=true,permitted=true,release,started;
    const began=new Promise(resolve=>{started=resolve;}),stopped=[];
    const candidate={kind:'plex',format:'hls',duration:60};
    const plex={stop:async media=>{if(media)stopped.push(media);},prepare:async()=>{
      started();await new Promise(resolve=>{release=resolve;});
      if(outcome==='failure')throw new PlaybackError('Fixture preparation failed');return candidate;
    }};
    const hub=new Hub({ownerId:'host',guildId:'guild',channels:['commands']},[]);
    hub.access={isMember:()=>true,refresh:async()=>true,options:()=>({available:true})};
    const watch=new Watch(hub,plex),actor={userId:'host',guildId:'guild',channelId:'commands',surface:'web',watchViewerId:randomUUID()};
    const room=watch.rooms.get(watch.create(actor));
    watch.snapshot(room,actor,actor.watchViewerId,async()=>live);watch.canView=async()=>access;
    room.media={kind:'plex',id:'1',duration:60};room.position=22;room.manualPaused=true;
    const viewer=room.viewers.get(actor.watchViewerId),audio=[{id:'11',codec:'aac',available:true,selected:true},{id:'12',codec:'aac',available:true}];
    const old={kind:'plex',format:'hls',tracks:{audio,subtitles:[]},selection:{audio:audio[0]},duration:60};
    viewer.media=old;viewer.mediaVersion=operation==='initial'?'older':room.mediaVersion;viewer.streamVersion=randomUUID();
    const args={mediaVersion:room.mediaVersion,streamVersion:viewer.streamVersion,audioId:'12'};
    const run=()=>operation==='initial'?watch.prepareViewer(room,actor,actor.watchViewerId):operation==='quality'?
      watch.execute(room,{action:'media.quality.set',args:{quality:'720p4'}},actor,()=>permitted):operation==='tracks'?
        watch.changeTracks(room,viewer,args,actor,()=>permitted):watch.refreshStream(room,viewer,args,actor,()=>permitted);
    try{
      const pending=run();await began;
      if(outcome==='media')room.mediaVersion=randomUUID();
      if(outcome==='viewer')room.viewers.delete(actor.watchViewerId);
      if(outcome==='stream')viewer.streamVersion=randomUUID();
      if(outcome==='revoked')access=false;
      if(outcome==='logout')live=false;
      if(outcome==='expired')permitted=false;
      release();
      if(outcome==='failure'&&operation==='initial')await assert.rejects(pending,/Fixture/);else await pending;
      const applied=outcome==='success'||operation==='initial'&&outcome==='expired';
      assert.equal(viewer.media,applied?candidate:old,operation+': '+outcome);
      assert.equal(stopped.filter(media=>media===(applied?old:candidate)).length,outcome==='failure'?0:1,'one owner disposes the discarded stream');
      assert.equal(room.position,22);assert.equal(room.manualPaused,true);assert.equal(room.s.enabled,false);
      assert.equal(viewer.updating || false,false);assert.equal(viewer.preparing,undefined);
    }finally{watch.close();hub.close();}
  }
});
