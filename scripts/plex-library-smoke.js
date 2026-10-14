/* Firefox library UX against synthetic Plex data; no private media or accounts. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{WebSocket}=require('ws'),{createApp}=require('../server/app');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),publicUrl:'https://localhost:6768',ownerId:'demo-host',guildId:'demo-guild',channels:['demo-commands'],demo:true,plexUrl:'http://127.0.0.1:32400',plexToken:'synthetic-fixture-only'};
 const app=createApp(config);let failNext=false;const artworkReads=[];
 const movies=Array.from({length:250},(_,i)=>({ratingKey:String(i+1),type:'movie',title:i<2?'A Sample Movie':i===2?'A Movie with a Longer Title to Check Wrapping':i===249?'Needle beyond the first two hundred':'Sample Movie '+String(i+1).padStart(3,'0'),year:i%2?2023:2020,duration:7200000,editionTitle:i===0?'Theatrical Cut':i===1?'The Final Cut':undefined,Genre:[{id:5,tag:'Sci-Fi'}],contentRating:'PG-13',summary:'A synthetic movie synopsis for checking the library design.',thumb:`/library/metadata/${i+1}/thumb/123`,Director:[{tag:'Sample director'}],Role:[{tag:'Sample actor'}]}));
 const show={ratingKey:'10000',type:'show',title:'A Sample Show',year:2020,childCount:2,thumb:'/library/metadata/10000/thumb/123',summary:'A synthetic television show.'};
 const seasons=[1,2].map(i=>({ratingKey:String(10000+i),type:'season',title:'Season '+i,index:i,leafCount:2,parentRatingKey:'10000',thumb:`/library/metadata/${10000+i}/thumb/123`}));
 const episodes=[1,2].map(i=>({ratingKey:String(10100+i),type:'episode',title:'Episode title '+i,index:i,parentIndex:1,parentRatingKey:'10001',grandparentRatingKey:'10000',grandparentTitle:show.title,year:2020,duration:1800000,summary:'Episode description, kept short enough to scan in a compact row.',thumb:`/library/metadata/${10100+i}/thumb/123`,grandparentThumb:show.thumb}));
 for(const episode of episodes) Object.assign(episode,{contentRating:'TV-14',Genre:[{id:5,tag:'Comedy'},{id:6,tag:'Drama'}],Director:[{tag:'Sample director'}],Role:['Sample actor one','Sample actor two','Sample actor three','Sample actor four','Sample actor five','Sample actor six','Sample actor seven','Sample actor eight'].map(tag=>({tag})),rating:7.9,ratingImage:'themoviedb://image',Media:[{videoResolution:'1080',videoCodec:'h264',bitrate:8000,audioCodec:'aac',audioChannels:2,container:'mkv'}]});
 const collection={ratingKey:'9000',type:'collection',title:'Sample collection',childCount:250,thumb:'/library/collections/9000/thumb/123',summary:'A collection with a defined order.'};
 const solo={...show,ratingKey:'11000',title:'B Single Season Show',childCount:1,thumb:'/library/metadata/11000/thumb/123'};
 const soloSeason={...seasons[0],ratingKey:'11001',parentRatingKey:'11000',thumb:'/library/metadata/11001/thumb/123'};
 const soloEpisodes=episodes.map((x,i)=>({...x,ratingKey:String(11101+i),grandparentRatingKey:'11000',grandparentTitle:solo.title,parentRatingKey:'11001',grandparentThumb:solo.thumb}));
 const all=[...movies,show,solo,...seasons,...episodes,soloSeason,...soloEpisodes,collection];
 app.watch.plex.fetch=async url=>{
  const p=url.pathname,query=url.searchParams;
  if(failNext && p.endsWith('/all')){failNext=false;return new Response('fixture failure',{status:503});}
  if(p==='/photo/:/transcode'){artworkReads.push(query.get('url'));return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),{headers:{'Content-Type':'image/png'}});}
  let data;
  if(p==='/library/sections')data={Directory:[{key:'1',type:'movie',title:'Movies'},{key:'2',type:'show',title:'TV Shows'}]};
  else if(p.endsWith('/genre'))data={Directory:[{key:'5',title:'Sci-Fi'}]};
  else if(p.endsWith('/year'))data={Directory:[{key:'2020',title:'2020'},{key:'2023',title:'2023'}]};
  else if(p.endsWith('/collections'))data={Metadata:[collection],totalSize:1};
  else if(p.endsWith('/all')||p.endsWith('/children')){
   let rows=p==='/library/collections/9000/children'?[...movies].reverse():p==='/library/metadata/10000/children'?seasons:p==='/library/metadata/10001/children'||p==='/library/metadata/10002/children'?episodes:p==='/library/metadata/11000/children'?[soloSeason]:p==='/library/metadata/11001/children'?soloEpisodes:p.includes('/sections/2/')?[show,solo]:movies;
   if(query.get('title'))rows=rows.filter(x=>x.title.toLowerCase().includes(query.get('title').toLowerCase()));
   if(query.get('year'))rows=rows.filter(x=>String(x.year)===query.get('year'));
   if(query.get('sort')){const [field,order]=query.get('sort').split(':');rows=[...rows].sort((a,b)=>{const result=field==='titleSort'?a.title.localeCompare(b.title):(a[field]||0)-(b[field]||0);return order==='desc'?-result:result;});}
   const start=Number(query.get('X-Plex-Container-Start')||0),size=Number(query.get('X-Plex-Container-Size')||120);data={Metadata:rows.slice(start,start+size),totalSize:rows.length};
  }else{const ids=p.split('/').at(-1).split(',');data={Metadata:all.filter(x=>ids.includes(x.ratingKey))};}
  return new Response(JSON.stringify({MediaContainer:data}));
 };
 app.watch.plex.prepare=async id=>({...app.watch.demoMedia,id,title:all.find(x=>x.ratingKey===id)?.title||'Fixture',subtitle:all.find(x=>x.ratingKey===id)?.editionTitle||'',kind:'demo'});
 app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));config.publicUrl=`https://localhost:${app.server.address().port}`;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'radtv-library-firefox-'));let firefox,driver;
 try{
  firefox=spawn(process.env.FIREFOX_BINARY||'C:/Program Files/Mozilla Firefox/firefox.exe',['--headless','--no-remote','--profile',profile,'--remote-debugging-port','0'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const address=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Firefox startup timeout')),20000);const read=b=>{const m=/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(b.toString());if(m){clearTimeout(timer);resolve(m[1]+'/session');}};firefox.stdout.on('data',read);firefox.stderr.on('data',read);});
  driver=new WebSocket(address);await once(driver,'open');let seq=0;const pending=new Map();
  driver.on('message',raw=>{const m=JSON.parse(raw),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.type==='error'?p.reject(Error(m.error+': '+m.message)):p.resolve(m.result);}});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),20000);pending.set(id,{resolve,reject,timer});driver.send(JSON.stringify({id,method,params}));});
  const evaluate=async(context,expression)=>{const r=await command('script.evaluate',{target:{context},expression,awaitPromise:true});if(r.type==='exception')throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async(context,expression,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(await evaluate(context,expression))return;await pause(100);}throw Error('Timeout: '+label);};
  await command('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:true}}});const {context}=await command('browsingContext.create',{type:'tab'});
  await command('browsingContext.setViewport',{context,viewport:{width:1360,height:1200}});await command('browsingContext.navigate',{context,url:config.publicUrl+'/watch?demo=host',wait:'complete'});
  await until(context,'!!me','demo login');await evaluate(context,'document.getElementById("create").click()');await until(context,'document.querySelectorAll(".library-home-card").length===5','Libraries home');
  assert.equal(await evaluate(context,'!!document.getElementById("library-select")'),false);
  await evaluate(context,'history.back()');await pause(200);assert.equal(await evaluate(context,'location.pathname==="/watch" && !document.querySelector(".library-landing").hidden'),true,'Browser Back at Home stays on watch');
  await evaluate(context,'document.querySelector(".library-home-card[data-tab=library]:first-child").click()');await until(context,'document.querySelectorAll(".library-tile").length===48','first library page');
  await evaluate(context,'history.back()');await until(context,'!document.querySelector(".library-landing").hidden','browser Back to Home');
  await evaluate(context,'history.forward()');await until(context,'!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile").length===48','browser Forward to library');
  await evaluate(context,'document.getElementById("library-back").click()');await until(context,'!document.querySelector(".library-landing").hidden','arrow Back to Home');
  await evaluate(context,'document.getElementById("library-forward").click()');await until(context,'!document.querySelector(".library").hidden','arrow Forward to library');
  await evaluate(context,'document.getElementById("library-panel").scrollIntoView()');await until(context,'document.querySelector(".library-art.loaded")','authenticated blob artwork');
  assert.equal(await evaluate(context,'document.querySelector("[data-item=\\\"1\\\"] .library-meta").textContent.includes("Theatrical Cut")'),true);
  failNext=true;await evaluate(context,'document.querySelector(".library-sentinel").scrollIntoView({block:"end"})');await until(context,'document.getElementById("library-note").classList.contains("library-error")','next-page error');
  await pause(400);assert.equal(await evaluate(context,'document.querySelectorAll(".library-tile").length'),48,'Failed page keeps existing items and waits for Retry');
  await evaluate(context,'document.querySelector(".library-footer button").click()');await until(context,'document.querySelectorAll(".library-tile").length>=96','automatically load next page after Retry');
  await evaluate(context,'search.value="Needle";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelectorAll(".library-tile").length===1 && document.querySelector(".library-title").textContent.includes("Needle")','search beyond 200');
  await evaluate(context,'document.querySelector(".library-open").click()');await until(context,'document.querySelector(".library-summary")','title details');
  await evaluate(context,'[...document.querySelectorAll(".library-crumb")].find(n=>n.textContent==="Movies").click()');assert.equal(await evaluate(context,'search.value'), 'Needle');assert.equal(await evaluate(context,'document.querySelectorAll(".library-tile").length'),1);
  await evaluate(context,'search.value="";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelectorAll(".library-tile").length===48','restore library');
  for(let i=0;i<5 && await evaluate(context,'document.querySelectorAll(".library-tile").length<250');i++){
   const before=await evaluate(context,'document.querySelectorAll(".library-tile").length');
   await evaluate(context,'document.querySelector(".library-sentinel").scrollIntoView({block:"end"})');await until(context,`document.querySelectorAll('.library-tile').length>${before}`,'infinite scroll advances');
  }
  assert.equal(await evaluate(context,'document.querySelectorAll(".library-tile").length'),250);
  assert.equal(await evaluate(context,'new Set([...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item)).size'),250);
  await evaluate(context,`globalThis.fixtureAnchor=()=>{const top=document.querySelector('.library-tools').getBoundingClientRect().bottom;const tile=[...document.querySelectorAll('.library-tile')].find(n=>n.getBoundingClientRect().bottom>top);return {id:tile.dataset.item,offset:tile.getBoundingClientRect().top-top};};const tile=document.querySelectorAll('.library-tile')[220];window.scrollBy(0,tile.getBoundingClientRect().top-document.querySelector('.library-tools').getBoundingClientRect().height-12);`);
  await pause(100);
  for(const view of ['list','poster','normal']){
   const anchor=JSON.parse(await evaluate(context,'JSON.stringify(fixtureAnchor())'));
   await evaluate(context,`document.querySelector('.library-views [data-view="${view}"]').click()`);await pause(100);
   const offset=await evaluate(context,`document.querySelector('[data-item="${anchor.id}"]').getBoundingClientRect().top-document.querySelector('.library-tools').getBoundingClientRect().bottom`);
   assert.ok(Math.abs(offset-anchor.offset)<2,`Keep ${anchor.id} at ${anchor.offset} after ${view}, got ${offset}`);
  }
  const anchor=JSON.parse(await evaluate(context,'JSON.stringify(fixtureAnchor())'));
  await evaluate(context,`document.querySelector('[data-item="${anchor.id}"] .library-open').click()`);await until(context,'document.querySelector(".library-summary")','deep item details');
  assert.ok(await evaluate(context,'document.querySelector(".library-overview").getBoundingClientRect().top-document.querySelector(".library-tools").getBoundingClientRect().bottom<50'),'Details appear directly below toolbar');
  assert.ok(await evaluate(context,'Math.abs(document.querySelector(".library-tools").getBoundingClientRect().top)<2'),'Details remain at viewport top');
  await evaluate(context,'history.back()');await until(context,'!document.querySelector(".library").hidden','Browser Back from deep details');await pause(100);
  assert.ok(Math.abs(await evaluate(context,`document.querySelector('[data-item="${anchor.id}"]').getBoundingClientRect().top-document.querySelector('.library-tools').getBoundingClientRect().bottom`)-anchor.offset)<2,'Back restores deep item position');
  await evaluate(context,'history.forward()');await until(context,'document.querySelector(".library-summary")','Browser Forward restores details');
  await evaluate(context,'history.back()');await until(context,'!document.querySelector(".library").hidden','Browser Back restores library again');
  for(const view of ['list','poster','normal']){await evaluate(context,`document.querySelector('.library-views [data-view="${view}"]').click()`);assert.equal(await evaluate(context,'document.getElementById("library-content").dataset.view'),view);}
  await evaluate(context,'document.querySelector(".library-views [data-view=list]").click();document.querySelector(".library-tile").click()');await until(context,'document.querySelector(".library-summary") && document.querySelector(".library").hidden','Whole movie row opens details');
  await evaluate(context,'history.back()');await until(context,'!document.querySelector(".library").hidden','Back to list');
  await evaluate(context,'document.querySelector(".library-tile .library-meta").click()');await until(context,'document.querySelector(".library").hidden','Row metadata also opens details');
  await evaluate(context,'history.back()');await until(context,'!document.querySelector(".library").hidden','Back to list again');
  for(const [name,width,height,theater] of [['normal',3840,2160,false],['theater',3840,2160,true],['activity-size',1920,1080,true],['phone',390,1100,true]]){
   await command('browsingContext.setViewport',{context,viewport:{width,height}});await evaluate(context,`setTheater(${theater});${theater?'toggleDrawer(true);':''}document.querySelector('.library-views [data-view=normal]').click();`);await pause(120);
   const posterWidth=await evaluate(context,'document.querySelector(".library-tile>.library-art").getBoundingClientRect().width');
   await evaluate(context,'document.querySelector(".library-views [data-view=poster]").click()');assert.ok(Math.abs(await evaluate(context,'document.querySelector(".library-tile>.library-art").getBoundingClientRect().width')-posterWidth)<1,'Normal and Poster sizes match at '+name);
   await evaluate(context,'document.querySelector(".library-title").click()');await until(context,'document.querySelector(".movie-detail") && document.querySelector(".library-summary")','Movie details at '+name);await pause(80);
   assert.ok(Math.abs(await evaluate(context,'document.querySelector(".movie-detail .library-art").getBoundingClientRect().width')-posterWidth)<1,'Movie detail poster matches grid at '+name);
   assert.ok(await evaluate(context,'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1'),'Movie details fit '+name);
   const movieShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-movie-details-'+name+'-qa.png'),Buffer.from(movieShot.data,'base64'));
   await evaluate(context,'history.back()');await until(context,'!document.querySelector(".library").hidden','Back to grid at '+name);
   await evaluate(context,'document.querySelector(".library-views [data-view=list]").click()');await pause(200);
   const rows=JSON.parse(await evaluate(context,`JSON.stringify([...document.querySelectorAll('.library-tile')].slice(0,3).map(card=>{const a=card.getBoundingClientRect(),b=card.querySelector('.library-play').getBoundingClientRect();return {size:b.width,top:b.top-a.top,bottom:a.bottom-b.bottom,right:a.right-b.right};}))`));
   for(const row of rows) assert.ok(row.size===55 && Math.abs(row.top-row.bottom)<1 && Math.abs(row.right-row.top)<1,'Play is larger with equal edge spacing at '+name+': '+JSON.stringify(row));
   const listShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-list-'+name+'-qa.png'),Buffer.from(listShot.data,'base64'));
  }
  await evaluate(context,'setTheater(false);document.querySelector(".library-views [data-view=normal]").click()');await command('browsingContext.setViewport',{context,viewport:{width:1360,height:1200}});

  await evaluate(context,'document.querySelector(".library-views [data-view=poster]").click();document.activeElement.blur()');assert.equal(await evaluate(context,'getComputedStyle(document.querySelector(".library-copy")).opacity'),'0');
  await evaluate(context,'document.querySelector(".library-open").focus()');await pause(200);assert.equal(await evaluate(context,'getComputedStyle(document.querySelector(".library-copy")).opacity'),'1');
  await evaluate(context,'document.querySelector(".library-tabs button:last-child").click()');await until(context,'document.querySelector(".library-title")?.textContent==="Sample collection"','collections');
  await evaluate(context,'document.querySelector(".library-open").click()');await until(context,'document.querySelectorAll(".library-tile").length===48','collection members');assert.equal(await evaluate(context,'document.querySelector(".library-title").textContent'),'Needle beyond the first two hundred');
  await evaluate(context,'search.value="A Sample Movie";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelectorAll(".library-tile").length===2','whole collection search');
  await evaluate(context,'document.getElementById("library-filters-toggle").click();const gs=document.querySelector(".library-filters select");gs.value="5";gs.dispatchEvent(new Event("change"))');await until(context,'document.querySelector(".library-count").textContent==="2 items" && document.querySelector(".library-filter-chip")','collection genre filter');
  await evaluate(context,'document.querySelector(".library-tabs button:first-child").click();document.querySelector(".library-choices .library-choice:nth-child(2)").click()');await until(context,'document.querySelector(".library-title")?.textContent==="A Sample Show"','show library');
  await evaluate(context,'document.querySelector(".library-open").click()');await until(context,'document.querySelectorAll(".library-tile").length===2','seasons');
  await evaluate(context,'search.value="Season 1";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelectorAll(".library-tile").length===1 && document.querySelector(".library-title").textContent==="Season 1"','Filtering a multi-season show does not skip the season');
  assert.equal(await evaluate(context,'document.querySelectorAll(".library-tile.episode").length'),0);
  await evaluate(context,'search.value="";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelectorAll(".library-tile").length===2','Restore seasons');
  await evaluate(context,'document.querySelector(".library-open").click()');await until(context,'document.querySelectorAll(".library-tile.episode").length===2','episode rows');assert.equal(await evaluate(context,'document.querySelector(".library-tile.episode .library-art").classList.contains("landscape")'),true);
  await evaluate(context,'document.querySelector(".library-open").click()');await until(context,'document.querySelector(".library-summary")','Episode details');
  assert.equal(await evaluate(context,'[...document.querySelectorAll(".library-crumbs button,.library-crumbs [aria-current]")].map(n=>n.textContent).join("|")'),'Libraries|TV Shows|A Sample Show|Season 1|Episode title 1');
  await until(context,'document.querySelectorAll(".library-detail-art .library-art.loaded").length===1 && document.querySelector(".library-facts")','Episode scene artwork, with full details');
  assert.ok(artworkReads.includes('/library/metadata/10101/thumb/123'),'Episode details use the scene artwork source');
  assert.equal(await evaluate(context,'document.querySelectorAll(".library-detail-art .library-art").length'),1,'Episode details have no show poster');
  assert.equal(await evaluate(context,'document.querySelector(".library-detail-art .landscape img").dataset.kind'),'landscape');
  assert.equal(await evaluate(context,'[...document.querySelectorAll(".library-facts dt")].map(n=>n.textContent).join("|")'),'Director|Cast|Ratings');
  for(const text of ['TV-14','Comedy','Drama','Sample director','Sample actor eight','TMDB 7.9/10','1080p','h264','8.0 Mbps','aac','2 channels','mkv']) assert.equal(await evaluate(context,`document.querySelector('.library-overview').textContent.includes(${JSON.stringify(text)})`),true,'Detail retains '+text);
  await evaluate(context,'document.querySelector(".library-media-info").open=true');
  for(const [name,width,height,theater] of [['normal',3840,2160,false],['theater',3840,2160,true],['activity-size',1920,1080,true],['phone',390,1100,true]]){
   await command('browsingContext.setViewport',{context,viewport:{width,height}});await evaluate(context,`setTheater(${theater});${theater?'toggleDrawer(true);drawer.scrollTop=document.getElementById("library-content").offsetTop;':'document.getElementById("library-content").scrollIntoView();'}`);await pause(150);
   await evaluate(context,'[...document.querySelectorAll(".library-crumb")].find(n=>n.textContent==="Season 1").click()');await until(context,'!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile.episode").length===2','Episode list at '+name);
   await evaluate(context,'document.querySelector(".library-open").click()');await until(context,'document.querySelector(".library-facts") && document.querySelectorAll(".library-detail-art .loaded").length===1','Episode details opened at '+name);
   await evaluate(context,'document.querySelector(".library-media-info").open=true');
   assert.ok(await evaluate(context,'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1'),'Details fit '+name);
   const geometry=JSON.parse(await evaluate(context,`(()=>{const a=document.querySelector('.library-detail-art>.landscape').getBoundingClientRect(),w=document.getElementById('library-content').getBoundingClientRect().width;return JSON.stringify({width:a.width,expected:Math.min(w,420),height:a.height});})()`));assert.ok(Math.abs(geometry.width-geometry.expected)<1 && Math.abs(geometry.height-geometry.width*9/16)<1,'Episode scene fills former combined artwork width at '+name);
   if(width>700) assert.ok(await evaluate(context,'(()=>{const a=document.getElementById("library-back").getBoundingClientRect(),b=document.querySelector(".library-choices").getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2)<2;})()'),'Navigation buttons are centered at '+name);
   const shot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-episode-details-'+name+'-qa.png'),Buffer.from(shot.data,'base64'));
  }
  await evaluate(context,'setTheater(false)');await command('browsingContext.setViewport',{context,viewport:{width:1360,height:1200}});

  await command('browsingContext.setViewport',{context,viewport:{width:390,height:1100}});await evaluate(context,'setTheater(true);toggleDrawer(true)');
  assert.ok(await evaluate(context,'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1'),'Phone episode breadcrumbs fit');
  const crumbsShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-crumbs-phone-qa.png'),Buffer.from(crumbsShot.data,'base64'));
  await evaluate(context,'setTheater(false)');await command('browsingContext.setViewport',{context,viewport:{width:1360,height:1200}});
  await evaluate(context,'[...document.querySelectorAll(".library-crumb")].find(n=>n.textContent==="A Sample Show").click()');await until(context,'document.querySelectorAll(".library-tile").length===2 && !document.querySelector(".library").hidden','Show breadcrumb restores seasons');
  await evaluate(context,'history.back()');await until(context,'document.querySelector(".library-summary")?.textContent==="Episode description, kept short enough to scan in a compact row." && document.querySelector(".library-overview h3").textContent==="Episode title 1"','Back follows breadcrumb visit history');
  await evaluate(context,'document.querySelector(".library-choices .library-choice:nth-child(2)").click()');await until(context,'[...document.querySelectorAll(".library-title")].some(n=>n.textContent==="B Single Season Show")','TV root');
  await evaluate(context,'[...document.querySelectorAll(".library-title")].find(n=>n.textContent==="B Single Season Show").click()');await until(context,'document.querySelectorAll(".library-tile.episode").length===2 && document.querySelector(".library-overview h3")?.textContent==="B Single Season Show"','Single-season show opens episodes directly');
  assert.equal(await evaluate(context,'document.querySelector(".library-tile .library-title").textContent'),'Episode title 1');
  assert.equal(await evaluate(context,'search.placeholder'),'Search episodes');
  await evaluate(context,'search.value="Episode title 2";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelectorAll(".library-tile.episode").length===1 && document.querySelector(".library-title").textContent==="Episode title 2"','Search direct episodes');
  await evaluate(context,'document.querySelector(".library-open").click()');await until(context,'document.querySelector(".library-overview h3")?.textContent==="Episode title 2"','Single-season episode details');
  assert.equal(await evaluate(context,'[...document.querySelectorAll(".library-crumbs button,.library-crumbs [aria-current]")].map(n=>n.textContent).join("|")'),'Libraries|TV Shows|B Single Season Show|Season 1|Episode title 2');
  await evaluate(context,'history.back()');await until(context,'!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile.episode").length===1','Back restores filtered direct episodes');
  await evaluate(context,'history.forward()');await until(context,'document.querySelector(".library-overview h3")?.textContent==="Episode title 2"','Forward restores single-season episode');
  await evaluate(context,'[...document.querySelectorAll(".library-crumb")].find(n=>n.textContent==="Season 1").click()');await until(context,'!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile.episode").length===1','Season breadcrumb returns to direct episode list');
  await evaluate(context,'document.querySelector(".library-choices .library-choice:first-child").click()');
  await evaluate(context,'document.querySelector(".library-tabs button:first-child").click()');await until(context,'document.querySelectorAll(".library-tile").length>=48','library restored');
  await evaluate(context,'document.querySelector(".library-views [data-view=normal]").click();document.getElementById("library-filters-toggle").click()');await until(context,'document.querySelector(".library-filters select").options.length>1','facets');
  await evaluate(context,'const ys=document.querySelectorAll(".library-filters select")[1];ys.value="2023";ys.dispatchEvent(new Event("change"))');await until(context,'document.querySelector(".library-count").textContent.includes("125")','year filter');
  await evaluate(context,'document.querySelector(".library-filter-chip").click()');await until(context,'document.querySelector(".library-count").textContent.includes("250")','remove filter');
  await evaluate(context,'document.getElementById("library-filters-toggle").click();document.getElementById("options-collapse").click()');
  failNext=true;await evaluate(context,'search.value="Temporary failure";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelector(".library-note.library-error") || document.getElementById("library-note").classList.contains("library-error")','local query error');
  await evaluate(context,'document.querySelector(".library-footer button").click()');await until(context,'document.querySelector(".library-count").textContent==="0 items"','explicit retry');
  await evaluate(context,'search.value="";search.dispatchEvent(new Event("input"))');await until(context,'document.querySelectorAll(".library-tile").length===48','library after retry');
  await evaluate(context,'document.getElementById("library-sort").value="random";document.getElementById("library-sort").dispatchEvent(new Event("change"))');await until(context,'document.querySelectorAll(".library-tile").length===48 && document.getElementById("library-direction").title==="Shuffle again"','Random sort');
  const randomOrder=await evaluate(context,'[...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item).join(",")');
  await evaluate(context,'document.querySelector(".library-sentinel").scrollIntoView({block:"end"})');await until(context,'document.querySelectorAll(".library-tile").length>=96','Random next page');
  assert.equal(await evaluate(context,'[...document.querySelectorAll(".library-tile")].slice(0,48).map(n=>n.dataset.item).join(",")'),randomOrder);
  assert.equal(await evaluate(context,'new Set([...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item)).size===document.querySelectorAll(".library-tile").length'),true);
  await evaluate(context,'document.getElementById("library-direction").click()');await until(context,'document.querySelectorAll(".library-tile").length===48','Shuffle again');assert.notEqual(await evaluate(context,'[...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item).join(",")'),randomOrder);
  await evaluate(context,'document.getElementById("library-sort").value="title";document.getElementById("library-sort").dispatchEvent(new Event("change"))');await until(context,'document.querySelectorAll(".library-tile").length===48','Title sort restored');
  await evaluate(context,'document.getElementById("library-home").click();document.getElementById("library-playback-test").click()');
  await until(context,'document.getElementById("playback-frame").contentDocument?.getElementById("diagnostics")?.value','Embedded diagnostics');
  const testShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-test-popup-qa.png'),Buffer.from(testShot.data,'base64'));
  assert.equal(await evaluate(context,'location.pathname'),'/watch');
  assert.ok(await evaluate(context,'document.getElementById("playback-dialog").getBoundingClientRect().height>innerHeight*.9'),'Test popup is almost fullscreen');
  await evaluate(context,'document.getElementById("playback-frame").contentDocument.getElementById("test-video").muted=true;document.getElementById("playback-frame").contentDocument.getElementById("play").click()');await until(context,'document.getElementById("playback-frame").contentDocument.getElementById("test-video").currentTime>0.5','Embedded native test video plays');
  await evaluate(context,'history.back()');await until(context,'!document.getElementById("playback-dialog").open','Browser Back closes popup');assert.equal(await evaluate(context,'document.getElementById("playback-frame").hasAttribute("src")'),false);
  await evaluate(context,'history.forward()');await until(context,'document.getElementById("playback-dialog").open','Browser Forward reopens popup');
  await until(context,'document.getElementById("playback-frame").contentDocument?.getElementById("diagnostics")?.value','Reopened diagnostics');
  await evaluate(context,'document.getElementById("playback-frame").contentDocument.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await until(context,'!document.getElementById("playback-dialog").open','Escape inside diagnostic frame closes popup');
  const homeShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-home-qa.png'),Buffer.from(homeShot.data,'base64'));
  assert.ok(await evaluate(context,'document.getElementById("library-content").getBoundingClientRect().height<innerHeight*2'),'Home does not retain the old grid height');
  await evaluate(context,'document.querySelector(".library-home-card[data-tab=library]:first-child").click()');await until(context,'!document.querySelector(".library").hidden','Return to Movies');
  assert.equal(await evaluate(context,'document.getElementById("library-forward").disabled'),true,'New navigation discards Forward branch');
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
  for(const [name,width,height,theater] of [['normal',3840,2160,false],['theater',3840,2160,true],['activity-size',1920,1080,true],['phone',390,1100,true]]){
   await command('browsingContext.setViewport',{context,viewport:{width,height}});await evaluate(context,`setTheater(${theater});${theater?'toggleDrawer(true);':'document.getElementById("library-panel").scrollIntoView();'}`);await pause(200);
   const report=JSON.parse(await evaluate(context,`(()=>{const area=document.getElementById('library-content').getBoundingClientRect();const overflow=[...document.querySelectorAll('#library-content button,#library-content input,#library-content select')].filter(n=>{const b=n.getBoundingClientRect();return b.width&&(b.left<area.left-1||b.right>area.right+1);}).map(n=>n.className);return JSON.stringify({width:innerWidth,overflow});})()`));assert.deepEqual(report.overflow,[],JSON.stringify(report));
   const shot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-'+name+'-qa.png'),Buffer.from(shot.data,'base64'));
   if(width===390){
    await evaluate(context,'document.getElementById("library-home").click()');assert.ok(await evaluate(context,'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1'),'Phone Home cards fit');
    const homePhone=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-home-phone-qa.png'),Buffer.from(homePhone.data,'base64'));
    await evaluate(context,'document.getElementById("library-playback-test").click()');await until(context,'document.getElementById("playback-frame").contentDocument?.getElementById("diagnostics")?.value','Phone popup');
    assert.ok(await evaluate(context,'(()=>{const d=document.getElementById("playback-frame").contentDocument;return d.documentElement.scrollWidth<=d.documentElement.clientWidth+1;})()'),'Phone diagnostic controls fit');
    const popupPhone=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-test-popup-phone-qa.png'),Buffer.from(popupPhone.data,'base64'));
    await evaluate(context,'document.getElementById("playback-dialog").dispatchEvent(new Event("cancel",{cancelable:true}))');await until(context,'!document.getElementById("playback-dialog").open','Dialog cancel closes popup');
    assert.equal(await evaluate(context,'drawer.hidden'),false,'Closing popup keeps drawer open');
    await evaluate(context,'document.querySelector(".library-home-card[data-tab=library]:first-child").click()');await until(context,'!document.querySelector(".library").hidden','Phone library restored');
   }
   if(theater && width>700){
    await evaluate(context,'drawer.scrollTop=document.getElementById("library-content").offsetTop+600');await pause(100);
    assert.ok(await evaluate(context,'Math.abs(document.querySelector(".library-tools").getBoundingClientRect().top-drawer.getBoundingClientRect().top)<2'),'Sticky toolbar covers the drawer top');
    const scrolled=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-'+name+'-scrolled-qa.png'),Buffer.from(scrolled.data,'base64'));
   }
  }
  await evaluate(context,'document.querySelector(".library-views [data-view=list]").click();document.querySelector("[data-item=\\\"2\\\"] [data-action=play]").click()');await until(context,'state?.mediaId==="2" && drawer.hidden','exact edition accepted and drawer closed');
  assert.equal(await evaluate(context,'state.subtitle'),'The Final Cut');
  assert.equal(await evaluate(context,'document.querySelector(".library-overview").hidden'),true,'List Play does not also open details');
  const {context:activity}=await command('browsingContext.create',{type:'tab'});
  await command('browsingContext.setViewport',{context:activity,viewport:{width:1920,height:1080}});await command('browsingContext.navigate',{context:activity,url:config.publicUrl+'/watch?demo=host&frame_id=fixture',wait:'complete'});
  await until(activity,'document.querySelector("#rooms button")','Activity sessions');await evaluate(activity,'document.querySelector("#rooms button").click()');await until(activity,'document.querySelectorAll(".library-home-card").length===5','Activity home');await evaluate(activity,'document.querySelector(".library-home-card[data-tab=library]:first-child").click()');await until(activity,'document.querySelectorAll(".library-tile").length===48','Activity library');
  await evaluate(activity,'toggleDrawer(true);document.getElementById("options-collapse").click()');assert.equal(await evaluate(activity,'theater && document.body.classList.contains("activity") && !document.getElementById("playback-test-link")'),true);
  const activityShot=await command('browsingContext.captureScreenshot',{context:activity,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts','plex-library-activity-qa.png'),Buffer.from(activityShot.data,'base64'));
  await evaluate(activity,'document.getElementById("library-home").click();document.getElementById("library-playback-test").click()');await until(activity,'document.getElementById("playback-frame").contentDocument?.getElementById("diagnostics")?.value','Activity embedded diagnostics without navigation');
  assert.equal(await evaluate(activity,'JSON.parse(document.getElementById("playback-frame").contentDocument.getElementById("diagnostics").value).environment.discordSdk'),'managed by watch page');
  await evaluate(activity,'updateActivityLayout({layout_mode:1})');await until(activity,'!document.getElementById("playback-dialog").open','PIP closes diagnostics');assert.equal(await evaluate(activity,'getComputedStyle(drawer).display'),'none','PIP stays video-only');
  await evaluate(activity,'updateActivityLayout({layout_mode:0});document.getElementById("close-room").click()');await until(activity,'document.getElementById("library-panel").hidden','Ended session clears library access');
  await evaluate(activity,'history.back()');await pause(150);assert.equal(await evaluate(activity,'location.pathname==="/watch" && document.querySelectorAll(".library-tile,.library-home-card").length===0'),true,'Browser history cannot restore the previous session catalog');
  console.log('[Plex library Firefox] PASS: Home cards, navigation arrows/browser history, separate library switcher, explicit Libraries breadcrumbs, single-season episodes/search/history, centered navigation, scene-only episode art, grid-sized movie posters, whole-row details and larger/evenly spaced Play controls, all detail fields at four viewport sizes, embedded playback test/cleanup, session history isolation; authenticated artwork, complete search, infinite scroll, stable Random pages/shuffle, deep view/detail/back scroll anchors, theater toolbar coverage, editions, collections/order, seasons/episodes, filters and responsive layouts.');
 }finally{driver?.close();firefox?.kill();await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
