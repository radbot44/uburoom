'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(fetch,renderers) {
  const track={mode:'disabled',cues:[],addCue(cue){this.cues.push(cue);},removeCue(cue){this.cues.splice(this.cues.indexOf(cue),1);}};
  const context={window:{uburoomSubtitleRenderers:renderers},fetch,AbortController,AbortSignal,setTimeout,clearTimeout,
    VTTCue:class {constructor(start,end,text){this.startTime=start;this.endTime=end;this.text=text;}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/watch-subtitles.js'),'utf8'),context);
  return {track,player:new context.window.uburoomSubtitles({addTextTrack:()=>track,textTracks:{addEventListener(){}}},()=>{})};
}
test('late captions cannot reappear after Off or replace a newer selection',async()=>{
  const requests=[];
  const {player,track}=fixture(url=>new Promise(resolve=>requests.push({url,resolve})));
  const finish=(index,text)=>requests[index].resolve({ok:true,json:async()=>({cues:[{start:1,end:3,text}]})});
  player.update({subtitleUrl:'/old'});player.update({});finish(0,'old');await tick();
  assert.equal(track.mode,'disabled');assert.equal(track.cues.length,0);
  player.update({subtitleUrl:'/second'});player.update({subtitleUrl:'/new'});finish(1,'second');await tick();
  assert.equal(requests[2].url,'/new');finish(2,'new');await tick();
  assert.equal(track.cues.length,1);assert.equal(track.cues[0].text,'new');player.destroy();
});

test('changing tracks during a retry clears the cancelled timer and loads the new selection',async()=>{
  const requests=[];
  const {player,track}=fixture(async url=>{
    requests.push(url);
    if(url==='/failed')throw new Error('Resource unavailable');
    return {ok:true,json:async()=>({cues:[{start:1,end:3,text:'New track'}]})};
  });
  try {
    player.update({subtitleUrl:'/failed'});await tick();assert.ok(player.timer);
    player.update({});player.update({subtitleUrl:'/new'});await tick();
    assert.deepEqual(requests,['/failed','/new']);assert.equal(player.loaded,true);
    assert.equal(track.cues[0].text,'New track');assert.equal(player.timer,undefined);
  } finally {player.destroy();}
});

test('a renderer finishing after Off is destroyed and cannot restore a stale overlay',async()=>{
  let finish,destroyed=0;
  const {player,track}=fixture(async url=>url.endsWith('/data')?new Response(new Uint8Array([1,2])):
    new Response(JSON.stringify({format:'pgs',data:'/selected/data',fonts:[]})),{create:()=>new Promise(resolve=>finish=resolve)});
  player.update({subtitleUrl:'/selected'});for(let i=0;i<8&&!finish;i++)await tick();assert.ok(finish);
  player.update({});finish({destroy(){destroyed++;}});await tick();
  assert.equal(destroyed,1);assert.equal(player.renderer,undefined);assert.equal(track.mode,'disabled');player.destroy();
});

test('renderer delay and picture updates do not reload data or recreate the renderer',async()=>{
  const offsets=[],pictures=[];let loads=0,disposed=0;
  const renderer={destroy(){disposed++;},offset(value){offsets.push(value);},picture(value){pictures.push(value.zoom);}};
  const {player,track}=fixture(async url=>{loads++;return url.endsWith('/data')?new Response(new Uint8Array([1])):
    new Response(JSON.stringify({format:'pgs',data:'/selected/data',fonts:[]}));},{create:async()=>renderer});
  player.update({subtitleUrl:'/selected',tracks:{subtitleOffset:0}});for(let i=0;i<8&&!player.loaded;i++)await tick();assert.equal(player.loaded,true);
  player.update({subtitleUrl:'/selected',tracks:{subtitleOffset:2},state:{picture:{zoom:1.5}}});
  assert.equal(loads,2);assert.deepEqual(offsets,[0,2]);assert.deepEqual(pictures,[1.5]);assert.equal(track.mode,'disabled');player.destroy();assert.equal(disposed,1);
});
test('native caption delay and control clearance preserve explicit cue positions',async()=>{
  const {player,track}=fixture(async()=>({ok:true,json:async()=>({cues:[
    {start:1,end:3,text:'Dialogue'}, {start:2,end:5,text:'Sign',settings:'line:10% position:20% align:start'}]})}));
  player.update({subtitleUrl:'/captions',tracks:{subtitleOffset:1}});await tick();player.layout(true,7);
  assert.equal(track.cues[0].startTime,2);assert.equal(track.cues[0].line,-7);
  assert.equal(track.cues[1].line,10);assert.equal(track.cues[1].snapToLines,false);
  player.layout(true,5);assert.equal(track.cues[0].line,-5);assert.equal(track.cues[1].line,10);
  player.layout(false);assert.equal(track.cues[0].line,-1);assert.equal(track.cues[1].line,10);
  player.update({subtitleUrl:'/captions',tracks:{subtitleOffset:-2}});
  assert.equal(track.cues[0].startTime,0);assert.equal(track.cues[0].endTime,1);player.destroy();
});
