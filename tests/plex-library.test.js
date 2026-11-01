'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Plex} = require('../server/plex');
const {watchHttp} = require('../server/watch-http');
const movie = (id, more = {}) => ({ratingKey:String(id),type:'movie',title:'Movie ' + id,year:2020,duration:6000000,thumb:`/library/metadata/${id}/thumb/123`,...more});
const json = data => new Response(JSON.stringify({MediaContainer:data}));
function fixture(handler, files) { return new Plex({plexUrl:'http://127.0.0.1:32400',plexToken:'fixture-private-token'},(url,options)=>{
  if (files && url.searchParams.get('checkFiles') === '1') {
    const ids = url.pathname.split('/').pop().split(',');
    return json({Metadata:files.filter(item=>ids.includes(item.ratingKey))});
  }
  return handler(url,options);
}); }

test('library pagination and native search/sort/filter queries cover titles beyond the former 200-item cutoff', async t => {
  const rows = Array.from({length:250},(_,i)=>movie(i+1)), requests = [];
  const plex = fixture(async (url,options) => {
    requests.push(url); assert.equal(options.headers['X-Plex-Token'],'fixture-private-token'); assert.equal(String(url).includes('fixture-private-token'),false);
    const filtered = rows.filter(x=>!url.searchParams.get('title') || x.title.includes(url.searchParams.get('title')));
    const start = Number(url.searchParams.get('X-Plex-Container-Start')), size = Math.min(Number(url.searchParams.get('X-Plex-Container-Size')), 120);
    return json({totalSize:filtered.length,Metadata:filtered.slice(start,start+size)});
  },rows); t.after(()=>plex.close());
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
    const start = Number(url.searchParams.get('X-Plex-Container-Start')), size = Math.min(Number(url.searchParams.get('X-Plex-Container-Size')), 120); starts.push(start);
    return json({totalSize:rows.length,Metadata:rows.slice(start,start+size)});
  },rows); t.after(()=>plex.close());
  const ordered = await plex.browse({section:'1',collection:'9',sort:'default'}); assert.equal(ordered.items[0].id,'245');
  const found = await plex.browse({section:'1',collection:'9',q:'Needle',sort:'default'});
  assert.ok(found.items.some(x=>x.id==='1')); assert.deepEqual(starts,[0,0,120,240]);
  const ascending = await plex.browse({section:'1',collection:'9',sort:'title'}); assert.equal(ascending.items[0].id,'2');
});

test('random sort uses one full-library shuffle across pages and a new seed produces a new order', async t => {
  const rows=Array.from({length:620},(_,i)=>movie(i+1)); let requests=0;
  const plex=fixture(async url=>{requests++;const start=Number(url.searchParams.get('X-Plex-Container-Start')),size=Number(url.searchParams.get('X-Plex-Container-Size'));return json({totalSize:rows.length,Metadata:rows.slice(start,start+size)});},rows);t.after(()=>plex.close());
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

test('show and season queue expansion pages the complete corpus, sorts cross-season episodes and filters Specials', async t => {
  const episodes = Array.from({ length: 245 }, (_, index) => movie(index + 1, {
    type: 'episode', parentIndex: Math.floor(index / 80), index: index % 80 + 1,
    parentTitle: 'Season ' + Math.floor(index / 80), grandparentTitle: 'Paged show'
  })).reverse();
  const requests = [];
  const plex = fixture(async url => {
    requests.push(url.pathname + ':' + url.searchParams.get('X-Plex-Container-Start'));
    const rows = url.pathname.endsWith('/children') ? episodes.filter(item => item.parentIndex === 2) : episodes;
    const start = Number(url.searchParams.get('X-Plex-Container-Start')), size = Math.min(Number(url.searchParams.get('X-Plex-Container-Size')), 120);
    return json({ totalSize: rows.length, Metadata: rows.slice(start, start + size) });
  },episodes); t.after(() => plex.close());
  const normal = await plex.queueItems({ type: 'show', id: '50' });
  assert.equal(normal.length, 165);
  assert.equal(normal[0].id, '81');
  assert.equal(normal[normal.length - 1].id, '245');
  assert.equal(normal[0].parentTitle, 'Season 1');
  assert.deepEqual(requests.slice(0, 3), ['/library/metadata/50/allLeaves:0', '/library/metadata/50/allLeaves:120', '/library/metadata/50/allLeaves:240']);
  const all = await plex.queueItems({ type: 'show', id: '50', includeSpecials: true });
  assert.equal(all.length, 245); assert.equal(all[0].id, '1');
  const season = await plex.queueItems({ type: 'season', id: '52' });
  assert.equal(season.length, 80); assert.equal(season[0].id, '161');
});

test('random scopes accept a movie library or expand mixed collections without duplicating episodes', async t => {
  const episode = movie(3, { type: 'episode', parentIndex: 1, index: 1 });
  const plex = fixture(async url => {
    if (url.pathname === '/library/sections') return json({ Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'show' }] });
    if (url.pathname === '/library/sections/1/all') return json({ totalSize: 1, Metadata: [movie(1)] });
    if (url.pathname === '/library/collections/9/children') return json({ totalSize: 3, Metadata: [movie(1), movie(50, { type: 'show' }), episode] });
    if (url.pathname === '/library/metadata/50/allLeaves') return json({ totalSize: 2, Metadata: [episode, movie(4, { type: 'episode', parentIndex: 0, index: 1 })] });
    throw new Error('Unexpected fixture request');
  },[movie(1),episode,movie(4,{type:'episode'})]); t.after(() => plex.close());
  assert.deepEqual((await plex.queueItems({ type: 'library', id: '1' })).map(item => item.id), ['1']);
  await assert.rejects(plex.queueItems({ type: 'library', id: '2' }), /movie library/);
  assert.deepEqual((await plex.queueItems({ type: 'collection', id: '9' })).map(item => item.id), ['1', '3']);
  assert.deepEqual((await plex.queueItems({ type: 'collection', id: '9', includeSpecials: true })).map(item => item.id), ['1', '4', '3']);
});

test('queue catalog expansion rejects incomplete, stuck and oversized upstream pagination', async t => {
  const stuck = fixture(async () => json({ totalSize: 240, Metadata: Array.from({ length: 120 }, (_, i) => movie(i + 1)) }));
  const incomplete = fixture(async url => json({ totalSize: 240, Metadata: Number(url.searchParams.get('X-Plex-Container-Start')) ? [] : Array.from({ length: 120 }, (_, i) => movie(i + 1)) }));
  const large = fixture(async () => json({ totalSize: 20001, Metadata: [] }));
  t.after(() => Promise.all([stuck.close(), incomplete.close(), large.close()]));
  await assert.rejects(stuck.queueItems({ type: 'show', id: '50' }), /did not advance/);
  await assert.rejects(incomplete.queueItems({ type: 'show', id: '50' }), /before all items/);
  await assert.rejects(large.queueItems({ type: 'show', id: '50' }), /20000-item/);
});

test('collection expansion bounds upstream work even when every nested show is empty', async t => {
  const shows = Array.from({ length: 201 }, (_, index) => movie(index + 1, { type: 'show' }));
  let requests = 0;
  const plex = fixture(async url => {
    requests++;
    if (url.pathname.startsWith('/library/metadata/')) return json({ totalSize: 0, Metadata: [] });
    const start = Number(url.searchParams.get('X-Plex-Container-Start')), size = Math.min(Number(url.searchParams.get('X-Plex-Container-Size')), 120);
    return json({ totalSize: shows.length, Metadata: shows.slice(start, start + size) });
  }); t.after(() => plex.close());
  await assert.rejects(plex.queueItems({ type: 'collection', id: '900' }), /200-request expansion limit/);
  assert.equal(requests, 200);
});

test('every room-scoped library route rejects inaccessible viewers and rechecks access before returning awaited private data or artwork', async () => {
  let manage = true, waiting, finish, calls = 0;
  const room = {s:{roomId:'room'}}, rooms = new Map([['room',room]]);
  const wait = () => { calls++; waiting?.(); return new Promise(resolve=>{finish=resolve;}); };
  const hub = {access:{isMember:()=>true},canManage:(s,actor)=>manage&&actor.userId==='host'};
  const routes = watchHttp({config:{publicUrl:'https://localhost'},hub,watch:{rooms,canView:async(room,actor)=>manage&&actor.userId==='host',plex:{configured:true,browse:wait,details:wait,filters:wait,artwork:wait,availability:wait}},
    user:async req=>({userId:req.headers.cookie}),webActor:identity=>identity,throttle:()=>true,json:(res,status,data)=>{res.status=status;res.data=data;}});
  for (const suffix of ['','/item','/filters','/art','/availability']) {
    const res={}; await routes.route({method:'GET',headers:{cookie:'guest'},socket:{}},res,new URL('https://localhost/api/watch/library'+suffix+'?room=room&items=1')); assert.equal(res.status,403);
  }
  assert.equal(calls,0);
  for (const suffix of ['','/art','/availability']) {
    manage=true; const ready = new Promise(resolve=>{waiting=resolve;}); const res={};
    const work=routes.route({method:'GET',headers:{cookie:'host'},socket:{}},res,new URL('https://localhost/api/watch/library'+suffix+'?room=room&items=1'));
    await ready; manage=false; finish(suffix==='/availability' ? new Map([['1',false]]) : suffix ? {type:'image/jpeg',bytes:Buffer.from('private image')} : {items:[{title:'private title'}]}); await work;
    assert.equal(res.status,403); assert.equal(JSON.stringify(res.data).includes('private title'),false);
  }
  routes.close();
});

test('lobby catalog, details, filters and artwork recheck identity and Plex scope after awaited reads', async () => {
  let signedIn = true, principal = 'viewer', waiting, finish;
  const wait = () => { waiting(); return new Promise(resolve => { finish = resolve; }); };
  const plex = {configured:true,principal:'viewer',browse:wait,details:wait,filters:wait,artwork:wait,availability:wait,visible:async()=>true};
  const hub = {access:{isMember:()=>true},plexFor:async()=>({...plex,principal})};
  const routes = watchHttp({config:{publicUrl:'https://localhost'},hub,watch:{rooms:new Map()},
    user:async()=>signedIn?{userId:'viewer'}:undefined,webActor:identity=>identity,throttle:()=>true,json:(res,status,data)=>{res.status=status;res.data=data;}});
  try {
    for (const suffix of ['','/item','/filters','/art','/availability']) {
      for (const revoke of [()=>{signedIn=false;},()=>{principal='changed';}]) {
        signedIn=true;principal='viewer';const ready=new Promise(resolve=>{waiting=resolve;}),res={};
        const work=routes.route({method:'GET',headers:{},socket:{}},res,new URL('https://localhost/api/watch/library'+suffix+'?items=1'));
        await ready;revoke();finish(suffix==='/availability'?new Map([['1',false]]):suffix==='/art'?{type:'image/png',bytes:Buffer.from('private')}:{items:[{title:'private'}]});await work;
        assert.equal(res.status,403);assert.equal(JSON.stringify(res.data).includes('private'),false);
      }
    }
    signedIn=false;const denied={};await routes.route({method:'GET',headers:{},socket:{}},denied,new URL('https://localhost/api/watch/library'));
    assert.equal(denied.status,401);
  } finally { routes.close(); }
});

test('room watch party history takes priority over personal Plex progress in library listings and details', async () => {
  const room = {
    s: { roomId: 'room-1' },
    media: { id: '10', duration: 7200 }
  };
  const rooms = new Map([['room-1', room]]);
  const hub = { access: { isMember: () => true }, canManage: () => true };
  const mockItems = [
    { id: '10', title: 'Live In Room', duration: 7200, viewOffset: 300 },
    { id: '20', title: 'Personal Only', duration: 7200, viewOffset: 450 }
  ];
  const plex = {
    configured: true,
    principal: 'discord-shared',
    browse: async () => ({ items: mockItems.map(x => ({ ...x })), total: 2 }),
    details: async id => ({ ...mockItems.find(x => x.id === id) }),
    visible: async () => true
  };
  const watch = {
    rooms,
    position: () => 1500,
    canView: async () => true,
    plex
  };
  const routes = watchHttp({
    config: { publicUrl: 'https://localhost' },
    hub,
    watch,
    user: async () => ({ userId: 'host' }),
    webActor: id => id,
    throttle: () => true,
    json: (res, status, data) => { res.status = status; res.data = data; }
  });
  try {
    const listRes = {};
    await routes.route({ method: 'GET', headers: {}, socket: {} }, listRes, new URL('https://localhost/api/watch/library?room=room-1'));
    assert.equal(listRes.status, 200);
    assert.equal(listRes.data.items[0].viewOffset, 1500, 'room position took priority over personal viewOffset');
    assert.equal(listRes.data.items[1].viewOffset, 450, 'personal viewOffset kept when room has no history');

    const itemRes = {};
    await routes.route({ method: 'GET', headers: {}, socket: {} }, itemRes, new URL('https://localhost/api/watch/library/item?room=room-1&item=10'));
    assert.equal(itemRes.status, 200);
    assert.equal(itemRes.data.item.viewOffset, 1500);
  } finally {
    routes.close();
  }
});


test('file checks mark missing library entries and reject playback before subtitles or queue expansion', async t => {
  const rows = [movie(1),movie(2)], checked = rows.map((item,index)=>({...item,Media:[{id:index+1,Part:[{id:index+1,key:'/library/parts/'+(index+1)+'/file.mp4',exists:!index,accessible:!index}]}]}));
  const plex = fixture(async url => {
    if (url.pathname === '/library/sections') return json({Directory:[{key:'1',type:'movie'}]});
    if (url.pathname.startsWith('/library/metadata/')) {
      assert.equal(url.searchParams.get('checkFiles'),'1');
      const ids = url.pathname.split('/').pop().split(',');
      return json({Metadata:checked.filter(item=>ids.includes(item.ratingKey))});
    }
    return json({totalSize:rows.length,Metadata:rows});
  }); t.after(()=>plex.close());
  const result = await plex.browse({section:'1'});
  assert.deepEqual(result.items.map(item=>item.available),[true,true],'Listing renders before file checks');
  assert.deepEqual([...await plex.availability(['1','2'])],[['1',true],['2',false]]);
  assert.deepEqual((await plex.browse({section:'1'})).items.map(item=>item.available),[true,false],'Known per-item statuses are included immediately');
  assert.deepEqual((await plex.queueItems({type:'library',id:'1'})).map(item=>item.id),['1']);
  await assert.rejects(plex.playableItem('2'),{code:'MEDIA_UNAVAILABLE'});
  await assert.rejects(plex.prepare('2','direct',false,undefined,undefined,{subtitleId:'auto'}),{code:'MEDIA_UNAVAILABLE'});
  checked[1].Media.push({...checked[0].Media[0],id:3});
  assert.equal((await plex.prepare('2','direct',false,undefined,undefined,{sourceOnly:true})).sourceSelection.mediaId,'3');
});


test('slow file checks never hold catalog reads and overlapping requests reuse item checks within their Plex scope', async t=>{
  let release,started,checks=0;
  const ready=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  const plex=fixture(async url=>{
    if (url.searchParams.has('checkFiles')) {
      checks++;started();await hold;
      return json({Metadata:[movie(1,{Media:[{Part:[{exists:false,accessible:false}]}]}),movie(2)]});
    }
    return json({totalSize:2,Metadata:[movie(1),movie(2)]});
  }); t.after(()=>plex.close());
  const initial=await plex.browse({section:'1'}); assert.equal(initial.items.length,2);assert.equal(checks,0);
  const first=plex.availability(['1','2']);await ready;
  const overlap=plex.availability(['1']);
  assert.equal((await plex.browse({section:'1'})).items.length,2,'Listing returns while file check remains held');
  assert.equal(checks,1);release();
  assert.equal((await first).get('1'),false);assert.equal((await overlap).get('1'),false);
  assert.equal((await plex.availability(['2','1'])).get('1'),false);assert.equal(checks,1,'Changed batch order reuses item results');
  assert.equal((await plex.browse({section:'1'})).items[0].available,false);
  const personal=plex.scope('fixture-personal-token','fixture-personal');
  assert.equal((await personal.browse({section:'1'})).items[0].available,true,'Private scopes do not reuse another scope status');
  await personal.availability(['1']);assert.equal(checks,2);
});

test('prepare parses and normalizes item chapters and markers chronologically', async t => {
  const itemWithChapters = movie(1, {
    duration: 120000,
    Media: [{ id: 1, videoCodec: 'h264', Part: [{ id: 1, key: '/library/parts/1/file.mp4', Stream: [{ id: 10, streamType: 1, codec: 'h264' }] }] }],
    Chapter: [
      { id: 2, index: 2, tag: 'Chapter 2', startTimeOffset: 30000, endTimeOffset: 90000 },
      { id: 1, index: 1, tag: 'Prologue', startTimeOffset: 0, endTimeOffset: 30000 }
    ],
    Marker: [
      { id: 101, type: 'intro', startTimeOffset: 15000, endTimeOffset: 45000 },
      { id: 102, type: 'credits', startTimeOffset: 100000, endTimeOffset: 120000 }
    ]
  });
  const plex = fixture(async () => json({ Metadata: [itemWithChapters] }));
  t.after(() => plex.close());
  const media = await plex.prepare('1', 'direct', false, undefined, undefined, { sourceOnly: true });
  assert.equal(media.chapters.length, 2);
  assert.equal(media.chapters[0].title, 'Prologue');
  assert.equal(media.chapters[0].startTime, 0);
  assert.equal(media.chapters[0].endTime, 30);
  assert.equal(media.chapters[1].title, 'Chapter 2');
  assert.equal(media.chapters[1].startTime, 30);
  assert.equal(media.chapters[1].endTime, 90);

  assert.equal(media.markers.length, 2);
  assert.equal(media.markers[0].type, 'intro');
  assert.equal(media.markers[0].startTime, 15);
  assert.equal(media.markers[0].endTime, 45);
  assert.equal(media.markers[1].type, 'credits');
  assert.equal(media.markers[1].startTime, 100);
  assert.equal(media.markers[1].endTime, 120);
});

test('viewOffset extraction maps actionable progress in seconds and omits unstarted or credits progress', async t => {
  const inProgress = movie(10, { duration: 6000000, viewOffset: 125000 }); // 125s of 6000s -> 125s
  const justStarted = movie(11, { duration: 6000000, viewOffset: 5000 }); // 5s -> omitted (< 10s)
  const inCredits = movie(12, { duration: 6000000, viewOffset: 5800000 }); // 5800s of 6000s (96.6%) -> omitted (> 92%)
  const unstarted = movie(13, { duration: 6000000 });

  const plex = fixture(async () => json({ Metadata: [inProgress, justStarted, inCredits, unstarted] }));
  t.after(() => plex.close());

  const items = plex.items([inProgress, justStarted, inCredits, unstarted]);
  assert.equal(items[0].viewOffset, 125);
  assert.equal(items[1].viewOffset, undefined);
  assert.equal(items[2].viewOffset, undefined);
  assert.equal(items[3].viewOffset, undefined);
});

test('multi-media movies expand into separate edition cards and details returns otherEditions', async t => {
  const multiMediaMovie = movie(20, {
    title: 'Blade Runner',
    year: 1982,
    duration: 7000000,
    librarySectionID: '1',
    Media: [
      { id: 101, videoResolution: '4k', videoCodec: 'hevc', bitrate: 24000, container: 'mkv', Part: [{ id: 1, key: '/library/parts/1/file.mkv' }] },
      { id: 102, videoResolution: '1080', videoCodec: 'h264', bitrate: 8000, container: 'mp4', Part: [{ id: 2, key: '/library/parts/2/file.mp4' }] }
    ]
  });
  const siblingCut = movie(21, {
    title: 'Blade Runner',
    year: 1982,
    duration: 7020000,
    editionTitle: 'Director\'s Cut',
    librarySectionID: '1',
    Media: [{ id: 103, videoResolution: '1080', videoCodec: 'h264', bitrate: 8500, container: 'mp4', Part: [{ id: 3, key: '/library/parts/3/file.mp4' }] }]
  });

  const plex = fixture(async url => {
    if (url.pathname === '/library/sections/1/all') {
      return json({ Metadata: [multiMediaMovie, siblingCut] });
    }
    if (url.pathname === '/library/metadata/20') {
      return json({ Metadata: [multiMediaMovie] });
    }
    if (url.pathname === '/library/metadata/21') {
      return json({ Metadata: [siblingCut] });
    }
    return json({ Metadata: [] });
  });
  t.after(() => plex.close());

  const expanded = plex.items([multiMediaMovie]);
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0].id, '20:101');
  assert.equal(expanded[0].edition, '4K HEVC');
  assert.equal(expanded[0].subtitle, '1982 · 4K HEVC');
  assert.equal(expanded[1].id, '20:102');
  assert.equal(expanded[1].edition, '1080p H264');
  assert.equal(expanded[1].subtitle, '1982 · 1080p H264');

  const detail = await plex.details('20:101');
  assert.equal(detail.id, '20:101');
  assert.ok(Array.isArray(detail.otherEditions));
  // Sibling internal Media (102) and sibling section item (21)
  assert.equal(detail.otherEditions.length, 2);
  assert.equal(detail.otherEditions[0].id, '20:102');
  assert.equal(detail.otherEditions[0].edition, '1080p H264');
  assert.equal(detail.otherEditions[1].id, '21');
  assert.equal(detail.otherEditions[1].edition, 'Director\'s Cut');

  const prepared = await plex.prepare('20:102', 'direct', false, undefined, undefined, { sourceOnly: true });
  assert.equal(prepared.id, '20:102');
  assert.equal(prepared.sourceSelection.mediaId, '102');
});
