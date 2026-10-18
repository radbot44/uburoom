'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {confirm}=require('../server/plex-output');
function decision(extra={}) {return {Metadata:[{Media:[{videoCodec:'h264',Part:[{Stream:[{streamType:1,codec:'h264'}]}],...extra}]}]};}
const options={ceiling:{width:1280,height:720,bitrate:4000}};
test('Plex output needs one confirmed H.264 stream; requested facts are never invented',()=>{
  const actual=confirm(decision(),options);
  assert.equal(actual.videoCodec,'h264');assert.equal(actual.audioCodec,undefined);assert.equal(actual.bitrate,undefined);assert.equal(actual.width,undefined);
  for(const value of [{},{Metadata:[]},decision({Part:[]}),decision({Part:[{Stream:[]}]}),decision({videoCodec:'hevc'}),
    {...decision(),generalDecisionCode:2000},{Metadata:[...decision().Metadata,...decision().Metadata]}]) assert.throws(()=>confirm(value,options),/H.264/);
  assert.throws(()=>confirm(decision({Part:[{Stream:[{streamType:1,codec:'h264'},{streamType:1,codec:'h264'}]}]}),options),/H.264/);
});
test('Plex output confirms audio identity and burned captions without accepting missing or ambiguous audio',()=>{
  const value=decision({audioCodec:'aac'}),streams=value.Metadata[0].Media[0].Part[0].Stream;
  const requested={...options,audio:{id:'12'},burn:true,subtitle:{id:'22'}};
  assert.throws(()=>confirm(value,requested),/audio/);
  streams.push({streamType:2,id:12,codec:'aac',selected:1},{streamType:3,id:22,decision:'burn'});
  assert.equal(confirm(value,requested).audioCodec,'aac');
  streams[1].id=11;assert.throws(()=>confirm(value,requested),/audio/);streams[1].id=12;
  streams.push({streamType:2,id:13,codec:'aac',selected:1});assert.throws(()=>confirm(value,requested),/audio/);streams.pop();
  streams[2].id=23;assert.throws(()=>confirm(value,requested),/subtitle/);
});
test('Plex reported dimensions and bitrate must respect the requested ceiling',()=>{
  assert.deepEqual(confirm(decision({width:1280,height:720,bitrate:3500}),options),{videoCodec:'h264',audioCodec:undefined,width:1280,height:720,bitrate:3500});
  for(const extra of [{width:1920},{height:1080},{width:0},{bitrate:'unknown'},{height:-1}])assert.throws(()=>confirm(decision(extra),options),/limits/);
  const withAudio=decision({audioCodec:'aac',bitrate:4200});
  withAudio.Metadata[0].Media[0].Part[0].Stream.push({streamType:2,codec:'aac'});
  withAudio.Metadata[0].Media[0].Part[0].Stream[0].bitrate=4000;
  assert.equal(confirm(withAudio,options).bitrate,4200,'total bitrate can include audio above the video ceiling');
  withAudio.Metadata[0].Media[0].Part[0].Stream[0].bitrate=4001;assert.throws(()=>confirm(withAudio,options),/limits/);
  const value=decision({width:1280});value.Metadata[0].Media[0].Part[0].Stream[0].width=640;
  assert.throws(()=>confirm(value,options),/contradictory/);
});
