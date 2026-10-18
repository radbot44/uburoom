'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {trackLabel}=require('../web/watch-player-ui');
const {QUALITIES}=require('../shared/room-protocol');
test('track labels separate language, codec and layout from Plex display titles and custom names',()=>{
  assert.equal(trackLabel({label:'Unknown (PCM Stereo)',codec:'pcm',channels:2,available:true}),'Unknown · PCM · Stereo');
  assert.equal(trackLabel({language:'eng',title:'Original theatrical mix',label:'English (AAC 5.1)',codec:'aac',channels:6,available:true}),'English · AAC · 5.1');
  assert.equal(trackLabel({languageName:'Japanese',codec:'pcm_s16le',channels:1,available:true}),'Japanese · PCM · Mono');
  assert.equal(trackLabel({language:'und',codec:'srt',forced:true,sdh:true,available:true}),'Unknown · SRT · Forced · SDH');
  assert.equal(trackLabel({languageName:'und',language:'und',codec:'pcm',channels:2,available:true}),'Unknown · PCM · Stereo');
  assert.equal(trackLabel({languageName:'French',codec:'ass',available:false}),'French · ASS · Unavailable');
});
test('quality display includes the progressive resolution suffix without changing preset identifiers',()=>{
  assert.equal(QUALITIES.find(q=>q.id==='1080p20').label,'1080p · 20 Mbps');
  assert.equal(QUALITIES.find(q=>q.id==='720p4').label,'720p · 4 Mbps');
});
