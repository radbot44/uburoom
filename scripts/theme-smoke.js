/* Explicit appearance combinations against disposable identities and media. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {fixturePlex}=require('./playback-baseline');
const {playbackBrowser}=require('./lib/playback-browser');
function contrastSamples() {
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');canvas.width=canvas.height=1;
  const luminance=value=>{context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);};
  const root=getComputedStyle(document.documentElement),color=name=>root.getPropertyValue('--'+name);
  return [['text','card'],['muted','card'],['on-primary','primary'],['accent-text','elevated']].map(([a,b])=>{const x=luminance(color(a)),y=luminance(color(b));return {pair:a+'/'+b,ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};});
}
async function main() {
  const name=process.argv.find(arg=>arg.startsWith('--browser='))?.slice(10) || 'chrome';
  const output=path.resolve('artifacts/theme-'+name);fs.mkdirSync(output,{recursive:true});
  const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['fixture'],demo:true,plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  const media=path.resolve('artifacts/playback-media-tracks'),manifest=JSON.parse(fs.readFileSync(path.join(media,'manifest.json')));
  const app=createApp(config,{plexFetch:fixturePlex(media,manifest)});app.hub.access={refresh:async()=>true,isMember:()=>true,options:()=>({available:true})};
  const brandingRequests=[];
  app.server.on('request',req=>{if(/^\/(?:assets\/branding\/|favicon\.|theme\.js)/.test(req.url))brandingRequests.push(req.url);});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  let browser;
  try {
    browser=await playbackBrowser(name);const page=await browser.page(config.publicUrl+'/watch?demo=host');
    const run=code=>browser.evaluate(page,code),until=(code,label)=>browser.until(page,code,label);
    await browser.viewport(page,1360,1000);await until('typeof transport!=="undefined" && transport?.ready','Login');
    assert.equal(await run('document.documentElement.dataset.theme+"/"+document.documentElement.dataset.accent'),'dark/orange');
    await run('createRoom().then(()=>true)');await run('execute({action:"media.load",args:{mediaId:"101",quality:"direct"}}).then(()=>true)');
    await until('videoFrames>2','Decoded media');await run('execute({action:"media.pause"}).then(()=>true)');
    await run('(()=>{window.faviconChanges=0;const observer=new MutationObserver(records=>{window.faviconChanges+=records.length;});for(const link of document.querySelectorAll("link[rel=icon]"))observer.observe(link,{attributes:true,attributeFilter:["href"]});return true;})()');
    const favicons=await run('JSON.stringify([...document.querySelectorAll("link[rel=icon]")].map(link=>link.getAttribute("href")))');
    brandingRequests.length=0;
    await run('(()=>{for(let i=0;i<20;i++)document.getElementById("accent-toggle").click();return true;})()');
    assert.equal(await run('document.documentElement.dataset.sunrise'),'true');
    assert.equal(await run('document.querySelectorAll(".sunrise-burst>span").length'),80);
    await until('document.documentElement.dataset.accent==="pink"','Sunrise starts its pink leg');
    const intermediate=await run('new Promise(resolve=>{const deadline=performance.now()+1500;function sample(){const value=getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();if(!["rgb(255, 153, 84)","rgb(255, 113, 151)"].includes(value)||performance.now()>deadline)resolve(value);else requestAnimationFrame(sample);}sample();})');
    assert.notEqual(intermediate.trim(),'rgb(255, 153, 84)');assert.notEqual(intermediate.trim(),'rgb(255, 113, 151)','Accent interpolates during the fade');
    await browser.screenshot(page,path.join(output,'sunrise-active.png'));
    await run('new Promise(resolve=>setTimeout(()=>resolve(true),250))');
    await browser.click(page,'accent-toggle');
    assert.equal(await run('document.documentElement.dataset.sunrise'),undefined);
    assert.equal(await run('document.documentElement.dataset.accent'),'orange');
    await run('(()=>{for(let i=0;i<20;i++)document.getElementById("theme-toggle").click();return true;})()');
    assert.equal(await run('document.querySelectorAll(".sunrise-burst>span").length'),28);
    assert.equal(await run('document.documentElement.dataset.theme'),'dark');
    await browser.screenshot(page,path.join(output,'theme-dud.png'));
    await run('(async()=>{for(let i=0;i<1000;i++)document.getElementById(i%2?"theme-toggle":"accent-toggle").click();await Promise.all([...document.querySelectorAll("img.brand")].map(img=>img.decode()));return true;})()');
    await run('localStorage.setItem("uburoom.appearance",JSON.stringify({theme:"dark",accent:"orange"}));window.dispatchEvent(new StorageEvent("storage",{key:"uburoom.appearance"}));true');
    await run('Promise.all([...document.querySelectorAll(".appearance-toggle")].flatMap(button=>button.getAnimations()).map(animation=>animation.finished)).then(()=>true)');
    assert.equal(brandingRequests.length,0,'Rapid appearance changes make no branding requests');
    assert.equal(await run('window.faviconChanges'),0,'Sunrise and rapid toggling never reassign favicon URLs');
    assert.equal(await run('JSON.stringify([...document.querySelectorAll("link[rel=icon]")].map(link=>link.getAttribute("href")))'),favicons,'Favicon links stay static');
    assert.equal(await run('fetch("/watch").then(r=>r.status)'),200,'Refresh remains available after rapid toggling');
    for(const [theme,accent] of [['dark','orange'],['dark','pink'],['light','pink'],['light','orange']]) {
      await browser.viewport(page,1360,1000);
      if(await run('document.documentElement.dataset.theme')!==theme)await browser.click(page,'theme-toggle');
      if(await run('document.documentElement.dataset.accent')!==accent)await browser.click(page,'accent-toggle');
      await run('Promise.all(document.documentElement.getAnimations().map(animation=>animation.finished)).then(()=>true)');
      const palette=JSON.parse(await run('JSON.stringify(["background","card","elevated","border","text","muted","orange","pink","primary","secondary"].map(key=>getComputedStyle(document.documentElement).getPropertyValue("--"+key).trim()))'));
      const colors=theme==='dark'?['#101217','#1B1E26','#292E38','#393F4D','#F8F7F4','#AAB0BC']:['#F8F6F2','#FFFEFC','#F0ECE6','#DDD7CF','#242329','#706D77'];
      assert.deepEqual(palette,[...colors,'#FF9954','#FF7197',accent==='orange'?'rgb(255, 153, 84)':'rgb(255, 113, 151)',accent==='orange'?'rgb(255, 113, 151)':'rgb(255, 153, 84)']);
      const contrast=JSON.parse(await run('JSON.stringify(('+contrastSamples.toString()+')())'));
      for(const sample of contrast)assert.ok(sample.ratio>=4.5,theme+'/'+accent+' '+sample.pair+' contrast '+sample.ratio);
      assert.equal(await run('getComputedStyle(document.getElementById("stage")).backgroundColor'),'rgb(0, 0, 0)');
      assert.equal(await run('getComputedStyle(document.querySelector(".transport")).color'),'rgb(248, 247, 244)');
      assert.equal(await run('getComputedStyle(document.documentElement).colorScheme'),theme);
      assert.equal(await run('document.getElementById("theme-toggle").getAttribute("aria-checked")'),String(theme==='light'));
      assert.equal(await run('document.getElementById("accent-toggle").getAttribute("aria-checked")'),String(accent==='pink'));
      assert.equal(await run('getComputedStyle(document.querySelector("#accent-toggle .appearance-thumb")).backgroundColor'),accent==='pink'?'rgb(255, 113, 151)':'rgb(255, 153, 84)');
      assert.equal(await run('getComputedStyle(document.querySelector("#accent-toggle .appearance-track")).backgroundColor'),theme==='dark'?'rgb(41, 46, 56)':'rgb(240, 236, 230)');
      assert.equal(await run('document.querySelectorAll(".appearance-label").length===0 && document.querySelectorAll("#theme-toggle .appearance-thumb svg").length===1 && !document.querySelector("#accent-toggle svg")'),true,'Theme uses a semantic icon; accent is color-only, with no visible labels');
      assert.equal(await run('document.querySelector(".appearance-track").offsetWidth<document.getElementById("remote-settings").shadowRoot.querySelector(".control-track").offsetWidth'),true,'Header switches are narrower than Room options');
      const svg=await run('decodeURIComponent(document.querySelector("img.brand").src.split(",")[1])');
      assert.ok(svg.includes('fill="'+(theme==='dark'?'#F8F7F4':'#242329')+'"'));
      assert.ok(svg.includes('id="letter-u-first" fill="'+(accent==='orange'?'#FF9954':'#FF7197')+'"'));
      assert.equal(await run('[...document.querySelectorAll("link[rel=icon]")].find(link=>link.type==="image/svg+xml").getAttribute("href")'),'/favicon.svg','Every appearance keeps the canonical static favicon');
      await run('toggleRemote(true);true');
      const remoteColor=await run('getComputedStyle(document.getElementById("remote").shadowRoot.querySelector(".remote")).backgroundColor');
      assert.equal(remoteColor,theme==='dark'?'rgb(27, 30, 38)':'rgb(255, 254, 252)');
      await browser.screenshot(page,path.join(output,theme+'-'+accent+'-remote.png'));await run('toggleRemote(false);true');
      await browser.click(page,'tracks-open');await until('document.getElementById("player-settings-menu").matches(":popover-open")','Desktop menu');
      await browser.click(page,'settings-quality');await until('!document.getElementById("player-settings-choices").hidden','Quality submenu');
      await browser.screenshot(page,path.join(output,theme+'-'+accent+'-menus.png'));
      assert.equal(await run('getComputedStyle(document.getElementById("player-settings-menu")).backgroundColor'),remoteColor);
      await run('playerUI.closeSettings();true');
      await browser.viewport(page,390,844);await run('window.scrollTo(0,0);true');
      await until('innerWidth===390','Phone viewport applied');
      assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'Phone has no page overflow');
      await browser.screenshot(page,path.join(output,theme+'-'+accent+'-phone.png'));
      assert.equal(await run('(()=>{const a=document.getElementById("accent-toggle").getBoundingClientRect(),b=document.getElementById("identity").getBoundingClientRect();return a.right<=b.left && Math.abs(a.top-b.top)<10;})()'),true,'Appearance immediately precedes username');
      await browser.click(page,'tracks-open');await until('document.getElementById("tracks-dialog").open','Phone settings');
      assert.equal(await run('getComputedStyle(document.getElementById("tracks-dialog")).backgroundColor'),remoteColor);
      await browser.screenshot(page,path.join(output,theme+'-'+accent+'-dialog.png'));await browser.click(page,'tracks-close');
      await browser.viewport(page,320,844);assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'Narrow phone fits switches');
    }
    const second=await browser.page(config.publicUrl+'/watch?demo=guest');
    await browser.viewport(second,1360,1000);
    await browser.until(second,'typeof transport!=="undefined" && transport?.ready','Second tab login');
    await browser.until(second,'document.getElementById("theme-toggle")?.getAttribute("aria-checked")==="true"','Saved appearance');
    assert.equal(await browser.evaluate(second,'document.documentElement.dataset.accent'),'orange');
    await browser.click(second,'accent-toggle');
    await browser.until(second,'document.documentElement.dataset.accent==="pink"','Accent toggle in second tab');
    await browser.activate(page);await until('document.documentElement.dataset.accent==="pink"','Cross-tab preference update');
    for(const route of ['/auth/handoff','/auth/error','/demo-plex','/demo-discord']) {
      const extra=await browser.page(config.publicUrl+route);
      assert.equal(await browser.evaluate(extra,'document.documentElement.dataset.theme+"/"+document.documentElement.dataset.accent'),'light/pink',route+' uses saved appearance');
    }
    assert.equal(await run('window.faviconChanges'),0,'All appearance combinations and cross-tab changes leave favicon links untouched');
    console.log(name+': all appearance combinations, remote, branding, static favicons, player menus, phone/dialogs, persistence, cross-tab and sign-in pages passed');
  } finally {await browser?.close();await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
