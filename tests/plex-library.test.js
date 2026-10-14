'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Plex} = require('../server/plex');
const {watchHttp} = require('../server/watch-http');
const movie = (id, more = {}) => ({ratingKey:String(id),type:'movie',title:'Movie ' + id,year:2020,duration:6000000,thumb:`/library/metadata/${id}/thumb/123`,...more});
const json = data => new Response(JSON.stringify({MediaContainer:data}));
function fixture(handler) { return new Plex({plexUrl:'http://127.0.0.1:32400',plexToken:'fixture-private-token'},handler); }

test('library pagination and native search/sort/filter queries cover titles beyond the former 200-item cutoff', async t => {
  const rows = Array.from({length:250},(_,i)=>movie(i+1)), requests = [];
  const plex = fixture(async (url,options) => {
    requests.push(url); assert.equal(options.headers['X-Plex-Token'],'fixture-private-token'); assert.equal(String(url).includes('fixture-private-token'),false);
    const filtered = rows.filter(x=>!url.searchParams.get('title') || x.title.includes(url.searchParams.get('title')));
    const start = Number(url.searchParams.get('X-Plex-Container-Start')), size = Number(url.searchParams.get('X-Plex-Container-Size'));
    return json({totalSize:filtered.length,Metadata:filtered.slice(start,start+size)});
  }); t.after(()=>plex.close());
  const first = await plex.browse({section:'1',sort:'year',order:'desc',genre:'5',year:'2020'});
  assert.equal(first.items.length,48); assert.equal(first.total,250); assert.equal(first.nextOffset,48);
  assert.equal(requests[0].searchParams.get('sort'),'year:desc'); assert.equal(requests[0].searchParams.get('genre'),'5'); assert.equal(requests[0].searchParams.get('year'),'2020');
  const last = await plex.browse({section:'1',offset:240}); assert.equal(last.items[0].id,'241'); assert.equal(last.nextOffset,null);
  const found = await plex.browse({section:'1',q:'Movie 250'}); assert.equal(found.items[0].id,'250'); assert.equal(found.total,1);
  const before = requests.length; await Promise.all([plex.browse({section:'1',q:'Movie 250'}),plex.browse({section:'1',q:'Movie 250'})]); assert.equal(requests.length,before,'short-lived catalog cache coalesces repeated queries');
  for (const query of [{section:'../secret'},{parent:'https://evil.test'},{section:'1',sort:'unsafe'},{section:'1',offset:'-1'},{section:'1',q:'x'.repeat(201)}]) await assert.rejects(plex.browse(query));
});

test('collection order is retained; filtering reads all child pages instead of filtering a partial collection', async t => {
  const rows = Array.from({length:245},(_,i)=>movie(245-i)), starts = [];
  rows[rows.length-1].title = 'Needle beyond the first two hundred';
  const plex = fixture(async url => {
    assert.equal(url.pathname,'/library/collections/9/children');
    const start = Number(url.searchParams.get('X-Plex-Container-Start')), size = Number(url.searchParams.get('X-Plex-Container-Size')); starts.push(start);
    return json({totalSize:rows.length,Metadata:rows.slice(start,start+size)});
  }); t.after(()=>plex.close());
  const ordered = await plex.browse({section:'1',collection:'9',sort:'default'}); assert.equal(ordered.items[0].id,'245');
  const found = await plex.browse({section:'1',collection:'9',q:'Needle',sort:'default'});
  assert.ok(found.items.some(x=>x.id==='1')); assert.deepEqual(starts,[0,0,120,240]);
  const ascending = await plex.browse({section:'1',collection:'9',sort:'title'}); assert.equal(ascending.items[0].id,'2');
});

test('random sort uses one full-library shuffle across pages and a new seed produces a new order', async t => {
  const rows=Array.from({length:620},(_,i)=>movie(i+1)); let requests=0;
  const plex=fixture(async url=>{requests++;const start=Number(url.searchParams.get('X-Plex-Container-Start')),size=Number(url.searchParams.get('X-Plex-Container-Size'));return json({totalSize:rows.length,Metadata:rows.slice(start,start+size)});});t.after(()=>plex.close());
  const seed='a'.repeat(32),first=await plex.browse({section:'1',sort:'random',seed}),next=await plex.browse({section:'1',sort:'random',seed,offset:48});
  assert.equal(first.total,620);assert.equal(requests,2,'matching catalog fetched once, in bounded batches');
  assert.equal(new Set([...first.items,...next.items].map(x=>x.id)).size,96);assert.ok(first.items.some(x=>Number(x.id)>200));
  assert.deepEqual((await plex.browse({section:'1',sort:'random',seed})).items.map(x=>x.id),first.items.map(x=>x.id));
  assert.notDeepEqual((await plex.browse({section:'1',sort:'random',seed:'b'.repeat(32)})).items.map(x=>x.id),first.items.map(x=>x.id));
  await assert.rejects(plex.browse({section:'1',sort:'random',seed:'unsafe'}));
});

test('editions, people and ratings are sanitized; private artwork paths never leave the server', async t => {
  let imageRequests = 0;
  const plex = fixture(async url => {
    if (url.pathname === '/photo/:/transcode') { imageRequests++; assert.match(url.searchParams.get('url'),/^\/library\/metadata\/2\/thumb/); return new Response(Buffer.from('fixture image'),{headers:{'Content-Type':'image/jpeg'}}); }
    return json({Metadata:[movie(2,{editionTitle:'The Final Cut',summary:'Synopsis',Director:[{tag:'Director'}],Role:[{tag:'Actor'}],rating:8.4,ratingImage:'imdb://image.rating',
      Media:[{videoResolution:'1080',videoCodec:'h264',Part:[{key:'/library/parts/2/0/file.mp4'}]}]})]});
  }); t.after(()=>plex.close());
  const detail = await plex.details('2'); assert.equal(detail.edition,'The Final Cut'); assert.deepEqual(detail.cast,['Actor']); assert.equal(detail.ratings[0].source,'IMDb');
  assert.equal(detail.hasPoster,true); assert.equal(JSON.stringify(detail).includes('/library/metadata'),false); assert.equal(JSON.stringify(detail).includes('fixture-private-token'),false);
  assert.match((await plex.prepare('2','direct')).subtitle,/The Final Cut/);
  await plex.artwork('2'); await plex.artwork('2'); assert.equal(imageRequests,1);
  assert.equal(plex.items([movie(3,{thumb:'https://evil.test/private.jpg'})])[0].hasPoster,false);
  await assert.rejects(plex.artwork('2','unsafe'));
});

test('collection genre filters use complete tags when Plex listing rows omit the matching genre', async t => {
  const plex = fixture(async url => {
    if (url.pathname.endsWith('/genre')) return json({Directory:[{key:'5',title:'Action'}]});
    if (url.pathname.endsWith('/year')) return json({Directory:[]});
    if (url.pathname.startsWith('/library/metadata/')) return json({Metadata:[movie(1,{Genre:[{id:2,tag:'Drama'},{id:3,tag:'Thriller'},{id:5,tag:'Action'}]})]});
    return json({totalSize:1,Metadata:[movie(1,{Genre:[{id:2,tag:'Drama'},{id:3,tag:'Thriller'}]})]});
  }); t.after(()=>plex.close());
  const result = await plex.browse({section:'1',collection:'9',genre:'5',sort:'default'}); assert.equal(result.total,1); assert.equal(result.items[0].id,'1');
});

test('every library route rejects guests and rechecks ownership before returning awaited private data or artwork', async () => {
  let manage = true, waiting, finish, calls = 0;
  const room = {s:{sessionId:'room'}}, rooms = new Map([['room',room]]);
  const wait = () => { calls++; waiting?.(); return new Promise(resolve=>{finish=resolve;}); };
  const hub = {access:{isMember:()=>true},canManage:(s,actor)=>manage&&actor.userId==='host'};
  const routes = watchHttp({config:{publicUrl:'https://localhost'},hub,watch:{rooms,canView:async()=>true,plex:{configured:true,browse:wait,details:wait,filters:wait,artwork:wait}},
    user:async req=>({userId:req.headers.cookie}),webActor:identity=>identity,throttle:()=>true,json:(res,status,data)=>{res.status=status;res.data=data;}});
  for (const suffix of ['','/item','/filters','/art']) {
    const res={}; await routes.route({method:'GET',headers:{cookie:'guest'},socket:{}},res,new URL('https://localhost/api/watch/library'+suffix+'?session=room')); assert.equal(res.status,403);
  }
  assert.equal(calls,0);
  for (const suffix of ['','/art']) {
    manage=true; const ready = new Promise(resolve=>{waiting=resolve;}); const res={};
    const work=routes.route({method:'GET',headers:{cookie:'host'},socket:{}},res,new URL('https://localhost/api/watch/library'+suffix+'?session=room'));
    await ready; manage=false; finish(suffix ? {type:'image/jpeg',bytes:Buffer.from('private image')} : {items:[{title:'private title'}]}); await work;
    assert.equal(res.status,403); assert.equal(JSON.stringify(res.data).includes('private title'),false);
  }
  routes.close();
});
