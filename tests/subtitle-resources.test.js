'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Resources=require('../server/subtitle-resources'),Tracks=require('../server/media-tracks');
function media(format='ass',external=true){
  const row={id:21,index:3,codec:format,streamType:3,...(external?{key:'/library/streams/21.'+(format==='pgs'?'sup':format==='vobsub'?'sub':'ass')}:{})};
  const tracks=Tracks.catalog({Stream:[row]},{browserSubtitles:true,extractSubtitles:true});
  return {tracks,selection:Tracks.select(tracks,{subtitleId:'21'}),captionVersion:'generation',subtitleAbort:new AbortController(),sourceStart:'http://fixture.invalid/file',source:{Media:[{Part:[{Stream:[row]}]}]}};
}
test('browser subtitle negotiation preserves legacy burn-in and explicit fallback',()=>{
  const rows={Stream:['ass','ssa','pgs','vobsub'].map((codec,i)=>({id:i+1,index:i+2,streamType:3,codec}))};
  assert.ok(Tracks.catalog(rows).subtitles.every(row=>row.delivery==='burn'));
  const available=Tracks.catalog(rows,{browserSubtitles:true,extractSubtitles:true});assert.deepEqual(available.subtitles.map(row=>row.delivery),['ass','ass','pgs','vobsub']);
  assert.equal(Tracks.select(available,{subtitleId:'1',subtitleMode:'burn'}).subtitle.delivery,'burn');assert.equal(available.subtitles[0].delivery,'ass');
  assert.ok(Tracks.catalog(rows,{browserSubtitles:true}).subtitles.every(row=>row.delivery==='burn'),'embedded extraction needs configured tools');
});
test('original external assets retain bytes and VobSub companions; cache stays selection-local',async()=>{
  const calls=[],m=media('vobsub'),plex={request:async key=>{calls.push(key);return new Response(key.endsWith('.idx')?'palette and timestamps':new Uint8Array([0,1,2,3]));}};
  try{const value=await Resources.load(plex,m,new AbortController().signal);
    assert.deepEqual(calls,['/library/streams/21.sub','/library/streams/21.idx']);assert.equal(value.assets.get('index').toString(),'palette and timestamps');
    assert.equal(await Resources.load(plex,m,new AbortController().signal),value);assert.equal(calls.length,2);
    const other=media('vobsub');try{assert.notEqual(await Resources.load(plex,other,new AbortController().signal),value);}finally{Resources.clear(other);}
  }finally{Resources.clear(m);}
});
test('selection change during original-resource fetch cannot populate or return a stale cache',async()=>{
  const m=media();let finish;const plex={request:()=>new Promise(resolve=>finish=resolve)};
  const request=Resources.load(plex,m,new AbortController().signal);m.captionVersion='next';m.subtitleAbort.abort();finish(new Response('old'));
  await assert.rejects(request);assert.equal(m.subtitleAssets,undefined);Resources.clear(m);
});
test('embedded ASS and bitmap extraction map the selected absolute stream without video encoding',async()=>{
  for(const format of ['ass','pgs','vobsub']){
    const m=media(format,false),commands=[],plex={};
    plex.av1={ffmpeg:'fixture-ffmpeg',ffprobe:'fixture-ffprobe',input:async(source,signal,action)=>{assert.equal(source.plexContext,plex);return action('http://127.0.0.1/opaque-capability');},
      run:async(binary,args)=>{commands.push({binary,args});return binary==='fixture-ffprobe'?Buffer.from('{"streams":[]}'):Buffer.from('subtitle');}};
    try{const value=await Resources.load(plex,m,new AbortController().signal),args=commands.at(-1).args;
      assert.equal(args[args.indexOf('-map')+1],'0:3');assert.equal(args[args.indexOf('-c:s')+1],'copy');assert.equal(args.includes('-c:v'),false);
      assert.equal(args[args.indexOf('-f')+1],format==='vobsub'?'matroska':format==='pgs'?'sup':'ass');assert.equal(value.assets.get('data').toString(),'subtitle');
      if(format==='vobsub')assert.equal(value.fileName,'track.mks');
    }finally{Resources.clear(m);}
  }
});
test('raw subtitle reads reject errors and enforce their byte budget',async()=>{
  await assert.rejects(Resources.read(new Response('denied',{status:403}),new AbortController().signal),/unavailable/);
  await assert.rejects(Resources.read(new Response('too large'),new AbortController().signal,2),/size/);
});

test('too many embedded fonts fail explicitly instead of silently dropping authored fonts',async()=>{
  const m=media('ass',false);let extractionStarted=false;
  const plex={av1:{ffmpeg:'fixture-ffmpeg',ffprobe:'fixture-ffprobe',input:async(source,signal,action)=>action('http://127.0.0.1/capability'),
    run:async(binary)=>{if(binary==='fixture-ffmpeg'){extractionStarted=true;return Buffer.from('subtitle');}
      return Buffer.from(JSON.stringify({streams:Array.from({length:33},(_,i)=>({index:i+4,codec_type:'attachment',tags:{mimetype:'font/ttf',filename:i+'.ttf'}}))}));}}};
  try{await assert.rejects(Resources.load(plex,m,new AbortController().signal),/could not be extracted.*Plex burn-in/);assert.equal(extractionStarted,false);assert.equal(m.subtitleAssets,undefined);}
  finally{Resources.clear(m);}
});
