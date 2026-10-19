/* Queue timeline/layout regression with isolated rooms and disposable browsers. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { accountFixture } = require('./account-fixture');
const { playbackBrowser, pause } = require('./lib/playback-browser');

async function main() {
  const output = path.resolve('artifacts/queue-layout-' + Date.now());
  fs.mkdirSync(output, { recursive: true });
  const browsers = (process.argv.find(arg => arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',');
  for (const name of browsers) {
    const fixture = accountFixture();
    const config = { cert: fs.readFileSync('certs/server-cert.pem'), key: fs.readFileSync('certs/server-key.pem'),
      publicUrl: 'https://localhost', ownerId: fixture.subjects.host, guildId: 'fixture', channels: ['fixture'],
      demo: true, unifiedAccounts: true, demoSubjects: fixture.subjects,
      plexUrl: 'http://plex-fixture.invalid:32400', plexToken: 'fixture-owner' };
    let artworkRequests = 0;
    const plexFetch = async (input, options) => {
      const url = new URL(input);
      if (url.pathname === '/photo/:/transcode') {
        artworkRequests++;
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), { headers: { 'Content-Type': 'image/png' } });
      }
      const response = await fixture.fetch(input, options);
      if (url.pathname === '/library/metadata/1') {
        const data = await response.json(); data.MediaContainer.Metadata[0].thumb = '/library/metadata/1/thumb/1';
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
    const app = createApp(config, { plexFetch, oauthFetch: fixture.discordFetch, plexDemo: fixture });
    app.hub.access = { refresh: async () => true, isMember: () => true, voiceChannel: () => 'fixture', validVoiceChannel: () => true, options: () => ({ available: true }) };
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    let browser, page;
    try {
      browser = await playbackBrowser(name);
      page = await browser.page(config.publicUrl + '/watch?demo=host');
      const run = async expression => {
        await pause(350);
        await browser.until(page, 'typeof pending==="undefined" || !pending', 'Previous control settles');
        return browser.evaluate(page, expression);
      };
      const until = (expression, label) => browser.until(page, expression, label);
      const centerError = '(()=>{const a=document.querySelector(".queue-layout").getBoundingClientRect(),b=document.querySelector(".queue-now-playing").getBoundingClientRect();return Math.abs(a.left+a.width/2-b.left-b.width/2)})()';
      const shot = label => browser.screenshot(page, path.join(output, name + '-' + label + '.png'));
      await browser.viewport(page, 1600, 1100);
      await until('typeof me!=="undefined" && me?.durableRooms && transport?.ready', 'Login');
      await run('$("create").click();$("room-name").value="Queue layout fixture";$("room-create").click()');
      await until('state?.durable', 'Create room');
      await run('execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}})');
      await until('state?.mediaId==="demo"', 'Current media');
      await run('execute({action:"media.pause"})');
      for (let i = 1; i <= 6; i++) await run('queueUI.add({mediaId:"demo",title:"Queue video ' + i + '",duration:60})');
      for (let i = 0; i < 3; i++) {
        await run('execute({action:"media.next"})');
        await until('state.queueSummary.historyCount===' + (i + 1), 'Advance creates history');
        await run('execute({action:"media.pause"})');
      }
      await until('document.querySelectorAll(".queue-history-entry").length===3 && document.querySelectorAll(".queue-entry").length===3', 'Both sides loaded');
      await until(centerError + '<2', 'Current video starts centered');
      assert.equal(await run('document.querySelector(".queue-history-entry:last-child").dataset.entryId===state.queueSummary.current.id'), false);
      const original = await run('document.querySelector(".queue-layout").scrollLeft');
      await run('$("queue-scroll-next").click()');
      await until('document.querySelector(".queue-layout").scrollLeft>' + (original + 100), 'Forward navigation');
      const scrolled = await run('document.querySelector(".queue-layout").scrollLeft');
      await run('queueUI.render(state.queueSummary)');
      assert.ok(Math.abs(await run('document.querySelector(".queue-layout").scrollLeft') - scrolled) < 2, 'Snapshot preserves browsing position');
      await run('$("queue-center").click()');
      await until(centerError + '<2', 'Recenter');
      await run('document.querySelector(".queue-layout").focus();document.querySelector(".queue-layout").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');
      await until('document.querySelector(".queue-layout").scrollLeft<' + (original - 100), 'Keyboard navigation');
      await run('$("queue-center").click();$("queue-panel").scrollIntoView({block:"start"})');
      await until(centerError + '<2', 'Recenter for rendering');
      await shot('cards');
      await run('$("queue-view-list").click()');
      assert.equal(await run('$("queue-view-list").getAttribute("aria-pressed")'), 'true');
      assert.equal(await run('localStorage.getItem("uburoom-queue-view")'), 'list');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-layout")).gridTemplateColumns.split(" ").length'), 2);
      assert.equal(await run('document.querySelector(".queue-history-entry").dataset.entryId'), await run('api("/api/watch/rooms/"+state.id+"/history").then(page=>page.items[0].id)'));
      await shot('list');
      await run('document.querySelector(".queue-current-toggle").focus();queueUI.render(state.queueSummary)');
      assert.equal(await run('document.activeElement.classList.contains("queue-current-toggle")'), true, 'Snapshot preserves focused current control');
      await run('queueUI.add({mediaId:"1",type:"movie",title:"Artwork fixture",duration:60})');
      await until('[...document.querySelectorAll(".queue-art img")].some(img=>img.dataset.item==="1")', 'Artwork row');
      await run('document.querySelector(".queue-art img").scrollIntoView({block:"center"})');
      await until('[...document.querySelectorAll(".queue-art img")].some(img=>img.complete&&img.naturalWidth===1)', 'Authenticated artwork decodes without a stored thumbnail');
      assert.equal(artworkRequests, 1);
      await run('$("queue-view-cards").click();$("queue-view-list").click()');
      assert.equal(artworkRequests, 1, 'View changes reuse cached artwork');
      await run('queueUI.add({mediaId:"2",type:"movie",title:"Missing artwork",duration:60})');
      await until('!![...document.querySelectorAll(".queue-entry")].find(row=>row.textContent.includes("Missing artwork"))', 'Missing-art row');
      await run('[...document.querySelectorAll(".queue-entry")].find(row=>row.textContent.includes("Missing artwork")).scrollIntoView({block:"center"})');
      await until('[...document.querySelectorAll(".queue-art")].some(box=>box.title==="Artwork unavailable")', 'Unavailable artwork keeps the shared fallback');
      await run('$("queue-panel").scrollIntoView({block:"start"})');
      await run('$("theme-toggle").click();$("accent-toggle").click()');
      await pause(150); await shot('list-light-pink');
      for (const mode of ['cards', 'list']) {
        await browser.viewport(page, 390, 844);
        await run('$("queue-view-' + mode + '").click();$("queue-panel").scrollIntoView({block:"start"})');
        await pause(150);
        assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'), true, 'Phone has no page overflow');
        if (mode === 'cards') await until(centerError + '<2', 'Phone centered');
        else assert.equal(await run('getComputedStyle(document.querySelector(".queue-layout")).gridTemplateColumns.split(" ").length'), 1);
        await shot('phone-' + mode);
      }
      await browser.viewport(page, 1600, 1100);
      await run('$("theme-toggle").click();$("accent-toggle").click();setTheater(true);$("queue-view-cards").click();$("queue-panel").scrollIntoView({block:"start"})');
      await until(centerError + '<2', 'Theater centered');
      assert.ok(await run('$("queue-panel").getBoundingClientRect().width>innerWidth*.9'), 'Theater queue spans the page');
      await shot('theater-cards');
      await run('window.scrollTo(0,0)');
      await browser.click(page, 'fullscreen');
      await until('immersive', 'Fullscreen');
      await run('toggleDrawer(true);$("queue-panel").scrollIntoView({block:"start"})');
      await until(centerError + '<2', 'Drawer centered');
      assert.equal(await run('drawer.contains($("queue-panel")) && $("queue-panel").getBoundingClientRect().right<=innerWidth'), true);
      await shot('drawer-cards');
      await run('document.exitFullscreen()');
      await until('!immersive', 'Exit fullscreen');
      assert.equal(await run('$("queue-panel").parentElement.classList.contains("screen-column")'), true, 'Queue shell restored');
      await run('$("queue-view-list").click()');
      const restored = await browser.page(config.publicUrl + '/watch?demo=host');
      await browser.until(restored, 'document.getElementById("queue-view-list")?.getAttribute("aria-pressed")==="true"', 'Saved list preference');
      console.log(name + ' ' + browser.version + ': cards/list, history order, centering/arrows/keyboard, stable scroll/focus, artwork/cache/fallback, saved preference, themes, phone, theater and fullscreen drawer passed');
    } catch (error) {
      if (browser && page) console.error(await browser.evaluate(page, '({selected,state:!!state,pending,error:$("error").textContent,notice:document.querySelector(".queue-notice").textContent})'));
      if (browser && page) await browser.screenshot(page, path.join(output, name + '-failure.png'));
      throw error;
    } finally { await browser?.close(); await app.close(); }
  }
  console.log(output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
