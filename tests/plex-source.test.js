'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Plex}=require('../server/plex');
const Sources=require('../server/plex-source');
const source=(id,extra={})=>({id,videoCodec:'h264',height:720,bitrate:4000,Part:[{id:id*10,key:'/library/parts/'+id*10+'/file',Stream:[]}],...extra});
test('source inventory skips incomplete entries and pins identities across reordering without substituting cuts',()=>{
  const item={duration:60000,editionTitle:'Original',Media:[{id:0,Part:[{}]},source(1),source(2)]};
  const selected=Sources.select(item);assert.equal(selected.media.id,1);assert.equal(selected.mediaIndex,1);
  item.Media.reverse();assert.equal(Sources.select(item,selected.identity).mediaIndex,1);
  item.Media.unshift(source(3));assert.equal(Sources.select(item,selected.identity).mediaIndex,2);
  item.editionTitle='Extended';assert.throws(()=>Sources.select(item,selected.identity),/source changed/);item.editionTitle='Original';
  item.Media=item.Media.filter(media=>media.id!==1);assert.throws(()=>Sources.select(item,selected.identity),/source changed/);
  assert.equal(Sources.inventory({duration:60000,Media:[source(1,{Part:[{key:'/library/parts/1/file'},{key:'/library/parts/2/file'}]})]}).some(entry=>entry.eligible),false);
  assert.throws(()=>Sources.select({duration:60000,Media:[source(1,{duration:30000})]}),/complete file/);
});
test('Plex pins a later source across scopes and preference reads and sends its actual indices',async()=>{
  let reordered=false,audio='11';const requests=[];
  const playable=source(2),other=source(3,{height:1080,bitrate:20000});
  playable.Part[0].Stream=[{streamType:1,codec:'h264'},{streamType:2,id:11,codec:'ac3',selected:1},{streamType:2,id:12,codec:'ac3'}];
  const plex=new Plex({plexUrl:'http://fixture.invalid:32400',plexToken:'synthetic'},async(input,options={})=>{
    const url=new URL(input);requests.push({url,token:options.headers['X-Plex-Token']});
    const json=body=>new Response(JSON.stringify({MediaContainer:body}));
    if(url.pathname==='/library/metadata/1'){
      const item={type:'movie',title:'Fixture',duration:60000,Media:reordered?[other,playable]:[{Part:[{}]},playable,other]};
      playable.Part[0].Stream.filter(s=>s.streamType===2).forEach(s=>s.selected=String(s.id)===audio?1:0);
      return json({Metadata:[item]});
    }
    if(url.pathname==='/library/parts/20'){audio=url.searchParams.get('audioStreamID');return json({});}
    if(url.pathname.endsWith('/decision'))return json({Metadata:[{Media:[{videoCodec:'h264',audioCodec:'aac',Part:[{Stream:[{streamType:1,codec:'h264'},{streamType:2,id:Number(audio),codec:'aac',selected:1}]}]}]}]});
    if(url.pathname.endsWith('/start.m3u8'))return new Response('#EXTM3U\nchild.m3u8\n');
    return json({});
  });
  try{
    const initial=await plex.prepare('1','direct',false,undefined,undefined,{sourceOnly:true});
    assert.equal(initial.sourceSelection.mediaId,'2');assert.deepEqual(plex.qualities(initial).map(q=>q.id),['direct','720p4','720p2']);
    reordered=true;const scoped=plex.scope('viewer-only','viewer');
    const media=await scoped.prepare('1','720p4',false,initial,undefined,{audioId:'12'});
    assert.equal(new URL(media.start).searchParams.get('mediaIndex'),'1');assert.equal(new URL(media.start).searchParams.get('partIndex'),'0');
    assert.equal(audio,'11');assert.equal(media.selection.audio.id,'12');
    assert.ok(requests.filter(r=>r.url.pathname==='/library/parts/20').every(r=>r.token==='viewer-only'));
    assert.equal(requests.some(r=>r.url.pathname==='/library/parts/30'),false);
    await scoped.stop(media);
    playable.id=9;await assert.rejects(()=>scoped.prepare('1','direct',false,initial),/source changed/);
  }finally{await plex.close();}
});
