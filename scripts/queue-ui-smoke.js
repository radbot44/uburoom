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
      assert.equal(await run('$("queue-content").dataset.view'), 'empty');
      assert.equal(await run('document.querySelector(".queue-empty-title").textContent'), 'Join a room to use the queue');
      await shot('outside-room');
      await run('$("create").click();$("room-name").value="Queue layout fixture";$("room-create").click()');
      await until('state?.durable', 'Create room');
      assert.equal(await run('$("queue-content").dataset.view'), 'empty');
      assert.equal(await run('document.querySelector(".queue-empty-title").textContent'), 'The queue is empty');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-timeline")).display'), 'none');
      await shot('empty-room');
      await run('document.querySelector(".queue-empty-screen button").click()');
      assert.equal(await run('$("library-panel").classList.contains("media-glow")'), true, 'Empty Queue Browse media highlights Media');
      await until('!$("library-panel").classList.contains("media-glow")', 'Browse highlight clears');
      await run('$("empty-browse").click()');
      assert.equal(await run('!!$("empty-browse").querySelector("svg") && $("library-panel").classList.contains("media-glow")'), true, 'Player Browse media uses the icon and highlight');
      await run('execute({action:"media.autoplay.set",args:{enabled:false}})');
      await run('queueUI.add({mediaId:"demo",type:"movie",title:"First queued video",duration:60})');
      await until('state?.mediaId==="demo" && state.queueSummary.pendingCount===0', 'First addition is Now Playing');
      assert.equal(await run('state.state.paused'), true, 'First addition respects Auto-play off');
      await run('execute({action:"media.autoplay.set",args:{enabled:true}})');
      await until('state?.mediaId==="demo"', 'Current media');
      await run('execute({action:"media.pause"})');
      for (let i = 1; i <= 6; i++) await run('queueUI.add({mediaId:"demo",title:"Queue video ' + i + '",duration:60})');
      for (const mode of ['cards','list']) {
        await run('$("queue-view-' + mode + '").click()');
        await until('queueUI.selectedEntryId===state.queueSummary.current.id','Initial '+mode+' center');
        await run('$("queue-scroll-next").click()');
        await until('queueUI.selectedEntryId===document.querySelector(".queue-entry").dataset.entryId','First queued '+mode+' entry');
        await run('$("queue-scroll-previous").click()');
        await until('queueUI.selectedEntryId===state.queueSummary.current.id','Return to current without history in '+mode);
      }
      if (process.argv.includes('--navigation-only')) { console.log(name+': Cards/List arrows return to current when history is empty'); continue; }
      await run('$("queue-view-cards").click()');
      for (let i = 0; i < 3; i++) {
        await run('execute({action:"media.next"})');
        await until('state.queueSummary.historyCount===' + (i + 1), 'Advance creates history');
        await run('execute({action:"media.pause"})');
      }
      await until('document.querySelectorAll(".queue-history-entry").length===3 && document.querySelectorAll(".queue-entry").length===3', 'Both sides loaded');
      await until(centerError + '<2', 'Current video starts centered');
      await until('queueUI.selectedEntryId===state.queueSummary.current.id && document.querySelectorAll(".queue-selected").length===1','Current item selected initially');
      assert.equal(await run('document.querySelector(".queue-current-earlier").disabled && document.querySelector(".queue-current-remove").parentElement.lastElementChild.classList.contains("queue-current-remove")'), true);
      assert.equal(await run('document.querySelector(".queue-playback-state").parentElement.classList.contains("queue-entry-actions")'), true);
      assert.equal(await run('document.querySelector(".queue-notice").parentElement.classList.contains("queue-footer")'), true);
      assert.equal(await run('!document.querySelector(".queue-directions") && document.querySelector(".queue-view-switch").parentElement===$("queue-center").parentElement'), true);
      await run('$("queue-scroll-next").click()');
      await until('queueUI.selectedEntryId===document.querySelector(".queue-entry").dataset.entryId','Upcoming selects its first item');
      await run('$("queue-scroll-previous").click()');
      await until('queueUI.selectedEntryId===document.querySelector(".queue-history-entry:last-child").dataset.entryId','History jumps across Upcoming to most recent history');
      await run('$("queue-scroll-previous").click()');
      await until('queueUI.selectedEntryId===document.querySelectorAll(".queue-history-entry")[1].dataset.entryId','History steps toward older entries');
      await run('$("queue-scroll-next").click()');
      await until('queueUI.selectedEntryId===document.querySelector(".queue-entry").dataset.entryId','Upcoming jumps across History to next item');
      await run('$("queue-center").click()');
      await until(centerError + '<2','Center after section navigation');
      assert.equal(await run('!!document.querySelector(".queue-more")'), false, 'Queued actions have no dropdown');
      assert.equal(await run('document.querySelector(".queue-now-playing").textContent.includes("Current video")'), false);
      assert.equal(await run('[...document.querySelectorAll(".queue-entry-actions .queue-action-play,.queue-entry-actions .queue-action-skip")].length'), 6, 'Both playback choices are directly visible');
      await run('execute({action:"media.seek.absolute",args:{seconds:17}})');
      await until('Math.abs(state.state.position-17)<.01', 'Stable remaining duration');
      await until('document.querySelector(".queue-entry .queue-card-caption").textContent==="Up in 0:43"', 'First start estimate');
      assert.equal(await run('[...document.querySelectorAll(".queue-entry .queue-card-caption")].map(el=>el.textContent).join("|")'), 'Up in 0:43|Up in 1:43|Up in 2:43');
      assert.equal(await run('document.querySelector(".queue-entry .queue-rank").textContent'),'NEXT');
      assert.equal(await run('$("queue-scroll-previous").querySelector(".queue-navigation-count").textContent'),'3 past');
      assert.equal(await run('$("queue-scroll-next").querySelector(".queue-navigation-count").textContent'),'3 queued');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-layout")).scrollbarWidth'),'none');
      const wheelStart = await run('document.querySelector(".queue-layout").scrollLeft');
      assert.equal(await run('document.querySelector(".queue-layout").dispatchEvent(new WheelEvent("wheel",{deltaY:120,bubbles:true,cancelable:true}))'), true);
      assert.equal(await run('document.querySelector(".queue-layout").scrollLeft'), wheelStart, 'Vertical wheel input no longer scrolls cards horizontally');
      await run('document.querySelector(".queue-layout").dispatchEvent(new WheelEvent("wheel",{deltaY:-120,bubbles:true,cancelable:true}));$("queue-center").click()');
      await until(centerError + '<2', 'Recenter after wheel');
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
      assert.ok(Math.abs(await run('(()=>{const r=document.querySelector(".queue-now-playing").getBoundingClientRect();return r.width/r.height})()') - 2/3) < .01, 'Cards use portrait poster ratio');
      assert.equal(await run('document.querySelector(".queue-entry .queue-move-actions").lastElementChild.classList.contains("queue-action-remove")'), true, 'Remove is the rightmost upcoming action');
      await run('document.querySelector(".queue-notice").textContent="Queue updated"');
      assert.ok(await run('(()=>{const a=document.querySelector(".queue-notice").getBoundingClientRect(),b=document.querySelector(".queue-footer-actions").getBoundingClientRect();return a.left<b.left && Math.abs(a.top+a.height/2-b.top-b.height/2)<2})()'),'Footer notice aligns left on the action row');
      await shot('cards');
      await run('document.querySelector(".queue-notice").textContent=""');
      await run('globalThis.queueMovingId=document.querySelectorAll(".queue-entry")[2].dataset.entryId;document.querySelectorAll(".queue-entry")[2].scrollIntoView({block:"nearest",inline:"center",behavior:"instant"})');
      const movingLeft = await run('[...document.querySelectorAll(".queue-entry")].find(row=>row.dataset.entryId===queueMovingId).getBoundingClientRect().left');
      for (let rank = 1; rank >= 0; rank--) {
        await run('[...document.querySelectorAll(".queue-entry")].find(row=>row.dataset.entryId===queueMovingId).querySelector(".queue-action-up").focus();document.activeElement.click()');
        await until('document.querySelectorAll(".queue-entry")[' + rank + ']?.dataset.entryId===queueMovingId', 'Move earlier applied');
        await until('Math.abs([...document.querySelectorAll(".queue-entry")].find(row=>row.dataset.entryId===queueMovingId).getBoundingClientRect().left-' + movingLeft + ')<2', 'Scroll follows the moved card');
        if (rank > 0) assert.equal(await run('document.activeElement.getAttribute("aria-label")'), 'Move earlier', 'Repeated moves retain the active control');
      }
      await run('$("queue-center").click()');
      await until(centerError + '<2', 'Center after moving');
      await run('$("queue-view-list").click()');
      assert.equal(await run('$("queue-view-list").getAttribute("aria-pressed")'), 'true');
      assert.equal(await run('localStorage.getItem("uburoom-queue-view")'), 'list');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-layout")).flexDirection'), 'column');
      assert.equal(await run('document.querySelector(".queue-entry").getBoundingClientRect().height===document.querySelector(".queue-history-entry").getBoundingClientRect().height'), true, 'List rows have matching heights');
      assert.equal(await run('document.querySelector(".queue-layout").dispatchEvent(new WheelEvent("wheel",{deltaY:120,bubbles:true,cancelable:true}))'), true, 'List retains vertical wheel behavior');
      assert.equal(await run('document.querySelector(".queue-history-entry").dataset.entryId'), await run('api("/api/watch/rooms/"+state.id+"/history").then(page=>page.items.at(-1).id)'));
      assert.ok(await run('(()=>{const a=document.querySelector(".queue-layout").getBoundingClientRect(),b=document.querySelector(".queue-now-playing").getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2)<2})()'), 'List opens centered on Now Playing');
      assert.equal(await run('document.querySelector(".queue-layout").clientHeight'), 592, 'List viewport fits about five rows');
      await run('$("queue-scroll-next").click()');
      await until('queueUI.selectedEntryId===document.querySelector(".queue-entry").dataset.entryId','List navigates down to Upcoming');
      await run('$("queue-scroll-previous").click()');
      await until('queueUI.selectedEntryId===document.querySelector(".queue-history-entry:last-child").dataset.entryId','List jumps up to most recent history');
      await run('$("queue-center").click()');
      await until('queueUI.selectedEntryId===state.queueSummary.current.id','List recentered selection');
      await shot('list');
      await run('globalThis.removedHistory=document.querySelector(".queue-history-entry").dataset.entryId;document.querySelector(".queue-history-entry .queue-action-remove").click()');
      await until('state.queueSummary.historyCount===2 && ![...document.querySelectorAll(".queue-history-entry")].some(row=>row.dataset.entryId===removedHistory)', 'Individual history removal');
      await run('document.querySelector(".queue-current-toggle").focus();queueUI.render(state.queueSummary)');
      assert.equal(await run('document.activeElement.classList.contains("queue-current-toggle")'), true, 'Snapshot preserves focused current control');
      await run('globalThis.queueDuplicates=[];globalThis.queueObserver=new MutationObserver(()=>{const id=document.querySelector(".queue-now-playing").dataset.entryId;if([...document.querySelectorAll(".queue-entry,.queue-history-entry")].some(row=>row.dataset.entryId===id))queueDuplicates.push(id)});queueObserver.observe($("queue-content"),{childList:true,subtree:true});globalThis.queueSelection=document.querySelectorAll(".queue-entry")[1].dataset.entryId;document.querySelectorAll(".queue-entry")[1].querySelector(".queue-action-play").click()');
      await until('state.queueSummary.current.id===queueSelection&&document.querySelector(".queue-now-playing").dataset.entryId===queueSelection', 'Play now selects the pending occurrence');
      await until('document.querySelectorAll(".queue-entry").length===2', 'Play now preserves earlier items');
      await run('globalThis.queueSelection=document.querySelectorAll(".queue-entry")[1].dataset.entryId;globalThis.queueSkipped=document.querySelector(".queue-entry").dataset.entryId;document.querySelectorAll(".queue-entry")[1].querySelector(".queue-action-skip").click()');
      await until('state.queueSummary.current.id===queueSelection&&document.querySelectorAll(".queue-entry").length===0', 'Skip to selects and archives earlier entries');
      assert.equal(await run('[...document.querySelectorAll(".queue-history-entry")].find(row=>row.dataset.entryId===queueSkipped).querySelector(".queue-outcome-label").textContent'), 'SKIPPED');
      for (const mode of ['resume', 'restart']) {
        await run('execute({action:"media.pause"})');
        await run('globalThis.queueReplayRow=[...document.querySelectorAll(".queue-history-entry")].find(row=>row.querySelector(".queue-item-' + mode + '"));globalThis.queueReplayId=queueReplayRow.dataset.entryId;queueReplayRow.querySelector(".queue-item-' + mode + '").click()');
        await until('![...document.querySelectorAll(".queue-history-entry")].some(row=>row.dataset.entryId===queueReplayId)', 'Replay consumes selected history');
      }
      assert.deepEqual(await run('queueDuplicates'), [], 'Current item never temporarily duplicates in the lists');
      await run('queueObserver.disconnect();execute({action:"media.pause"})');
      await run('queueUI.add({mediaId:"demo",type:"movie",title:"Skip fixture",duration:60})');
      await until('!document.querySelector(".queue-current-skip").disabled', 'Current skip enabled');
      assert.equal(await run('document.querySelector(".queue-current-toggle").nextElementSibling.classList.contains("queue-current-skip")'), true);
      await run('document.querySelector(".queue-current-skip").click()');
      await until('state.queueSummary.current.title==="Skip fixture" && !document.querySelector(".queue-entry")', 'Current skip advances');
      await run('execute({action:"media.pause"})');
      const restoredCount = await run('state.queueSummary.historyCount');
      await run('globalThis.queueReturnRow=[...document.querySelectorAll(".queue-history-entry")][0];globalThis.queueReturnTitle=queueReturnRow.querySelector(".queue-entry-title").textContent;queueReturnRow.querySelector(".queue-item-go-back").click()');
      await until('state.queueSummary.current.title===queueReturnTitle && state.queueSummary.historyCount===0 && state.queueSummary.pendingCount===' + restoredCount, 'Go back restores the timeline into Upcoming');
      await run('execute({action:"media.pause"})');
      await run('queueUI.add({mediaId:"1",type:"movie",title:"Artwork fixture",duration:60})');
      await until('[...document.querySelectorAll(".queue-art img")].some(img=>img.dataset.item==="1")', 'Artwork row');
      await run('document.querySelector(".queue-art img").scrollIntoView({block:"center"})');
      await until('[...document.querySelectorAll(".queue-art img")].some(img=>img.complete&&img.naturalWidth===1)', 'Authenticated artwork decodes without a stored thumbnail');
      assert.equal(artworkRequests, 1);
      assert.equal(await run('[...document.querySelectorAll(".queue-entry")].some(row=>getComputedStyle(row.querySelector(".queue-row-backdrop")).backgroundImage.startsWith("url("))'),true,'List rows share the fetched poster backdrop');
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
        await run('$("section-tab-queue").click()');
        await run('$("queue-view-' + mode + '").click();$("queue-panel").scrollIntoView({block:"start"})');
        await pause(150);
        assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'), true, 'Phone has no page overflow');
        if (mode === 'cards') await until(centerError + '<2', 'Phone centered');
        else assert.equal(await run('getComputedStyle(document.querySelector(".queue-layout")).flexDirection'), 'column');
        await shot('phone-' + mode);
        await run('$("queue-scroll-next").click()');
        await pause(600);
        const savedScroll = await run('({left:document.querySelector(".queue-layout").scrollLeft,top:document.querySelector(".queue-layout").scrollTop})');
        await run('$("section-tab-media").click()');
        await pause(300);
        await run('$("section-tab-queue").click()');
        await pause(300);
        const restoredScroll = await run('({left:document.querySelector(".queue-layout").scrollLeft,top:document.querySelector(".queue-layout").scrollTop})');
        assert.ok(Math.abs(savedScroll.left-restoredScroll.left)<2 && Math.abs(savedScroll.top-restoredScroll.top)<2,'Mobile '+mode+' preserves queue position');
      }
      await run('[...document.querySelectorAll("button.queue-title-link")].find(button=>button.textContent==="Artwork fixture").click()');
      await until('$("section-tab-media").getAttribute("aria-selected")==="true" && getComputedStyle($("library-panel")).display!=="none"','Queue title activates Media tab');
      let panelWidth;
      for (const [key, panel] of [['room','options-panel'],['queue','queue-panel'],['media','library-panel']]) {
        await run('$("section-tab-' + key + '").click();$("' + panel + '").scrollIntoView({block:"start"})');
        await until('getComputedStyle($("' + panel + '")).display!=="none"', 'Mobile ' + key + ' tab');
        assert.equal(await run('["options-panel","queue-panel","library-panel"].filter(id=>getComputedStyle($(id)).display!=="none").length'), 1);
        const width = await run('$("' + panel + '").getBoundingClientRect().width');
        if (panelWidth === undefined) panelWidth = width; else assert.ok(Math.abs(panelWidth - width) < 1, 'Mobile panels share the same width: ' + key + ' ' + width + ' vs Room ' + panelWidth);
        await shot('phone-tab-' + key);
      }
      assert.equal(await run('$("options-collapse").textContent.trim()'), 'Queue layout fixture');
      assert.equal(await run('$("library-heading").textContent'), 'Media');
      assert.equal(await run('document.querySelector(".queue-heading").textContent'), 'Queue');
      assert.equal(await run('$("drawer-open").getAttribute("aria-label")'), 'Menu');
      assert.equal(await run('getComputedStyle($("room-symbol")).maskImage.includes("oomark-mono.svg")'), true);
      assert.equal(await run('fetch("/assets/branding/uburoom-oomark-mono.svg").then(response=>response.ok)'), true);
      assert.equal(await run('$("media-symbol").querySelector("svg").isEqualNode(uburoomUI.icon(document,"media"))'), true);
      await run('$("section-tab-room").focus();$("section-tabs").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
      assert.equal(await run('document.activeElement.id'), 'section-tab-queue');
      await run('window.scrollTo(0,0)');
      await browser.click(page, 'fullscreen');
      await until('immersive', 'Phone fullscreen');
      await run('toggleDrawer(true);$("section-tab-media").click()');
      assert.equal(await run('drawer.contains($("section-tabs")) && getComputedStyle($("library-panel")).display!=="none"'), true);
      await shot('phone-menu-media');
      await run('document.exitFullscreen()');
      await until('!immersive', 'Phone fullscreen exit');
      assert.equal(await run('!drawer.contains($("section-tabs")) && $("section-tab-media").getAttribute("aria-selected")==="true"'), true);
      for (const width of [720,900,1100]) {
        await browser.viewport(page,width,1100);
        await pause(200);
        assert.ok(await run('Math.abs($("library-panel").getBoundingClientRect().width-$("queue-panel").getBoundingClientRect().width)<2'),'Panels match at '+width+'px');
      }
      await browser.viewport(page, 1600, 1100);
      await run('$("theme-toggle").click();$("accent-toggle").click();setTheater(true);$("queue-view-cards").click();$("queue-panel").scrollIntoView({block:"start"})');
      await until(centerError + '<2', 'Theater centered');
      assert.ok(await run('$("queue-panel").getBoundingClientRect().width>innerWidth*.25&&$("queue-panel").getBoundingClientRect().width<innerWidth*.32'), 'Theater queue uses the right column');
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
      assert.equal(await run('$("queue-panel").parentElement.id==="room-column"'), true, 'Queue shell restored');
      await run('toggleDrawer(true);toggleDrawer(false)');
      assert.equal(await run('$("library-panel").classList.contains("media-glow")'), false, 'Menu toggles do not highlight Media');
      const historyCount = await run('state.queueSummary.historyCount');
      await run('document.querySelector(".queue-history-entry .queue-action-remove")?.click()');
      if (historyCount) await until('state.queueSummary.historyCount===' + (historyCount - 1), 'Individual history removal');
      await run('$("switch-room").click()');
      await until('$("room-dialog").open && [...$("room-choices").querySelectorAll("button")].some(button=>button.dataset.joinRoom===selected && button.textContent==="Cancel")','Current room offers Cancel');
      const roomBeforeCancel = await run('selected');
      await run('[...$("room-choices").querySelectorAll("button")].find(button=>button.dataset.joinRoom===selected).click()');
      await until('!$("room-dialog").open','Current room Cancel closes Switch room');
      assert.equal(await run('selected'),roomBeforeCancel);
      await run('$("switch-room").click();$("room-show-saved").click()');
      await until('$("room-dialog").open && [...$("saved-rooms").querySelectorAll("button")].some(button=>button.textContent==="Cancel")','Saved current room also offers Cancel');
      await run('[...$("saved-rooms").querySelectorAll("button")].find(button=>button.textContent==="Cancel").click()');
      await until('!$("room-dialog").open','Saved current room Cancel closes Switch room');
      assert.equal(await run('selected'),roomBeforeCancel);
      await run('globalThis.discardedCurrent=state.queueSummary.current.id;globalThis.historyBeforeDiscard=state.queueSummary.historyCount;document.querySelector(".queue-current-later").click()');
      await until('state.queueSummary.current.id!==discardedCurrent && ![...document.querySelectorAll(".queue-history-entry")].some(row=>row.dataset.entryId===discardedCurrent)','Current forward arrow discards instead of archiving');
      assert.equal(await run('state.queueSummary.historyCount'),await run('historyBeforeDiscard'));
      await run('document.querySelector(".queue-current-remove").click()');
      await until('!state.mediaId && !state.queueSummary.current','Current X clears playback');
      await run('$("queue-view-list").click()');
      const restored = await browser.page(config.publicUrl + '/watch?demo=host');
      await browser.until(restored, 'document.getElementById("queue-view-list")?.getAttribute("aria-pressed")==="true"', 'Saved list preference');
      assert.equal(await browser.evaluate(restored,'$("queue-content").dataset.view'),'empty','Saved List preference still renders a neutral outside-room screen');
      console.log(name + ' ' + browser.version + ': current skip, Go back timeline restoration, Room/Queue/Media mobile tabs and equal widths, section icons/Menu, native wheel behavior, queue actions/replay/moves, start estimates, artwork/cache, themes, phone/theater/fullscreen passed');
    } catch (error) {
      if (browser && page) console.error(await browser.evaluate(page, '({selected,state:!!state,pending,error:$("error").textContent,notice:document.querySelector(".queue-notice").textContent,ranks:[...document.querySelectorAll(".queue-entry .queue-rank")].map(el=>el.textContent),position:state?.state?.position,duration:state?.state?.duration,summary:state?.queueSummary})'));
      if (browser && page) await browser.screenshot(page, path.join(output, name + '-failure.png'));
      throw error;
    } finally { await browser?.close(); await app.close(); }
  }
  console.log(output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
