'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(fetch) {
  const track={mode:'disabled',cues:[],addCue(cue){this.cues.push(cue);},removeCue(cue){this.cues.splice(this.cues.indexOf(cue),1);}};
  const context={window:{},fetch,AbortController,AbortSignal,setTimeout,clearTimeout,
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
test('native caption delay and control clearance preserve explicit cue positions',async()=>{
  const {player,track}=fixture(async()=>({ok:true,json:async()=>({cues:[
    {start:1,end:3,text:'Dialogue'}, {start:2,end:5,text:'Sign',settings:'line:10% position:20% align:start'}]})}));
  player.update({subtitleUrl:'/captions',tracks:{subtitleOffset:1}});await tick();player.layout(true,true);
  assert.equal(track.cues[0].startTime,2);assert.equal(track.cues[0].line,-7);
  assert.equal(track.cues[1].line,10);assert.equal(track.cues[1].snapToLines,false);
  player.layout(false,false);assert.equal(track.cues[0].line,-1);assert.equal(track.cues[1].line,10);
  player.update({subtitleUrl:'/captions',tracks:{subtitleOffset:-2}});
  assert.equal(track.cues[0].startTime,0);assert.equal(track.cues[0].endTime,1);player.destroy();
});
