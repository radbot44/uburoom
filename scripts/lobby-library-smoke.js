/* Lobby browsing and room entry against isolated catalog/media fixtures. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { playbackBrowser } = require('./lib/playback-browser');
const root = path.resolve(__dirname, '..');
async function main() {
  const name = process.argv.find(x => x.startsWith('--browser='))?.split('=')[1] || 'chrome';
  const config = {cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost:6768',ownerId:'demo-host',guildId:'demo-guild',channels:['demo-commands'],demo:true,
    plexUrl:'http://library-fixture.invalid:32400',plexToken:'synthetic-fixture-only'};
  const movie = {ratingKey:'1',type:'movie',title:'Lobby fixture movie',year:2026,duration:60000};
  const app = createApp(config);
  app.watch.plex.fetch = async url => {
    let data;
    if (url.pathname === '/library/sections') data = {Directory:[{key:'1',type:'movie',title:'Movies'}]};
    else if (url.pathname.endsWith('/all')) data = {Metadata:[movie],totalSize:1};
    else if (url.pathname === '/library/metadata/1') data = {Metadata:[movie]};
    else data = {Directory:[]};
    return new Response(JSON.stringify({MediaContainer:data}));
  };
  app.watch.plex.prepare = async id => ({...app.watch.demoMedia,id,title:movie.title,kind:'demo'});
  app.hub.access = {refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  config.publicUrl = 'https://localhost:' + app.server.address().port;
  let browser;
  try {
    browser = await playbackBrowser(name);
    const host = await browser.page(config.publicUrl + '/watch?demo=host');
    const run = expression => browser.evaluate(host,expression);
    const until = (expression,label) => browser.until(host,expression,label);
    const shot = label => browser.screenshot(host,path.join(root,'artifacts','lobby-' + name + '-' + label + '.png'));
    await browser.viewport(host,1360,1100);
    await until('document.querySelectorAll(".library-home-card").length > 0','Lobby library');
    assert.equal(app.watch.rooms.size,0);
    assert.equal(await run('!$("options-panel").hidden && $("watch-settings").inert && !$("options-panel").inert && getComputedStyle($("watch-settings")).opacity === "0.4" && !$("watch-settings").hidden && !$("remote-settings").shadowRoot.querySelector(".sharing").hidden'),true);
    await shot('normal');
    await run('document.querySelector(".library-home-card[data-tab=library]").click()');
    await until('!!document.querySelector("#library [data-play]")','Lobby movie');
    await run('document.querySelector("#library [data-play]").click()');
    await until('$("room-dialog").open','Room chooser');
    assert.equal(app.watch.rooms.size,0);
    assert.equal(await run('$("room-join").hidden'),true);
    await shot('chooser');
    await run('$("room-dialog").close("cancel")');
    await until('!document.querySelector("#library [data-play]").disabled','Cancel restores play');
    assert.equal(app.watch.rooms.size,0);
    await run('document.querySelector("#library [data-play]").click();$("room-create-private").click()');
    await until('!!state?.mediaId && !$("room-dialog").open','Private room plays selection');
    assert.equal(app.watch.rooms.size,1);
    const privateRoom = [...app.watch.rooms.values()][0];
    assert.equal(privateRoom.s.visibility,'private');assert.equal(privateRoom.s.enabled,false);
    assert.equal(await run('state.mediaId'),'1','Selected catalog movie loads');
    const guest = await browser.page(config.publicUrl + '/watch?demo=guest');
    await browser.viewport(guest,1360,1100);
    await browser.until(guest,'document.querySelectorAll(".library-home-card").length > 0','Guest lobby');
    assert.equal(await browser.evaluate(guest,'$("rooms").querySelectorAll("button").length'),0,'Private room stays hidden');
    await run('$("close-room").click()');
    await until('!selected && document.querySelectorAll(".library-home-card").length > 0','Leave restores library');
    await run('document.querySelector(".library-home-card[data-tab=library]").click()');
    await until('!!document.querySelector("#library [data-play]") && !document.querySelector("#library [data-play]").disabled','Play enabled after leaving');
    await run('$("create").click();$("room-create").click()');
    await until('!!state && !$("room-dialog").open','Public room');
    const publicId = await run('selected');
    await browser.evaluate(guest,'document.querySelector(".library-home-card[data-tab=library]").click()');
    await browser.until(guest,'!!document.querySelector("#library [data-play]")','Guest movie');
    await browser.evaluate(guest,'document.querySelector("#library [data-play]").click()');
    await browser.until(guest,'$("room-choices").children.length === 1','Active room choices');
    await browser.screenshot(guest,path.join(root,'artifacts','lobby-' + name + '-join.png'));
    await browser.evaluate(guest,'document.querySelector("#room-choices button").click()');
    await browser.until(guest,'!!state && !$("room-dialog").open','Join room');
    assert.equal(await browser.evaluate(guest,'selected'),publicId);
    assert.equal(app.watch.rooms.get(publicId).media,null,'Joining does not replace shared playback');
    await browser.evaluate(guest,'$("close-room").click()');
    await run('$("close-room").click()');
    await until('!selected && document.querySelectorAll(".library-home-card").length > 0','Return to lobby');
    await run('$("theater").click();window.scrollTo(0,500)');
    await shot('theater');
    await browser.viewport(host,390,844);
    await run('window.scrollTo(0,0)');await shot('phone');
    await run('$("create").click()');await shot('phone-chooser');
    assert.equal(await run('$("room-dialog").getBoundingClientRect().width <= innerWidth'),true);
    assert.equal(await run('(()=>{const a=$("room-create").getBoundingClientRect(),b=$("room-create-private").getBoundingClientRect();return a.width>b.width && Math.abs(a.top-b.top)<1;})()'),true,'Public button is wider beside Private');
    console.log(name + ': lobby browse, disabled settings, cancel, private/public creation, Play selection, private hiding, join and responsive layouts passed');
  } finally { await browser?.close(); await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
