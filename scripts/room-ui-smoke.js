/* Durable room controls in disposable browsers/accounts. No .env or real providers.
 * Checks what is on screen (elements, text, ARIA state) and confirms shared state on the
 * fixture server. Page globals still used, for want of an on-screen signal:
 *   transport.ready  - socket readiness before the first command (lobby looks ready earlier)
 *   refreshState()   - re-read room state after the runner changes server-side presence
 *   queueUI.add()    - queue an item without a library entry for the synchronization video
 *   execute()        - send a seek the viewer's disabled timeline cannot, to prove the server refuses it
 */
'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { startFixtureServer, openPage, dom } = require('./lib/ui-fixture');

const { shown, hidden, text, hasText, enabled, attr, isOpen, count } = dom;
const byId = id => 'document.getElementById(' + JSON.stringify(id) + ')';
const press = selector => dom.q(selector) + '.click();true';
const pressId = id => byId(id) + '.click();true';
const choose = (id, value) =>
  '(()=>{const e=' +
  byId(id) +
  ';e.value=' +
  JSON.stringify(value) +
  ';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()';
const settingsSection = key => press('#room-settings-nav [data-section=' + key + ']');
// The room's player shows paused at a position (in the time readout) once the server has applied it.
const pausedAt = clock =>
  attr('#player-play', 'aria-label') + '==="Play" && ' + text('#time') + '.startsWith(' + JSON.stringify(clock) + ')';
const seekTo = seconds => choose('timeline', String(seconds));

async function main() {
  const browsers = (process.argv.find(arg => arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',');
  for (const name of browsers) {
    const { app, config, subjects } = await startFixtureServer();
    let browser, host, guest;
    const roomByName = roomName => [...app.watch.rooms.values()].find(room => room.s.name === roomName);
    const roomIdByName = roomName => [...app.watch.rooms.entries()].find(([, room]) => room.s.name === roomName)?.[0];
    const queueOf = id => app.watch.roomState.queue.summary(app.watch.rooms.get(id).s.roomId);
    const enginePosition = id => require('../shared/engine').snapshot(app.watch.rooms.get(id).s.state);
    try {
      browser = await playbackBrowser(name);
      host = await openPage(browser, config.publicUrl + '/?demo=host');
      // Stay within the unchanged 40 messages/second production request budget.
      const run = async expression => {
        await pause(100);
        await browser.activate(host);
        return browser.evaluate(host, expression);
      };
      const until = (expression, label) => browser.until(host, expression, label);
      require('node:fs').mkdirSync(path.resolve('artifacts'), { recursive: true });
      const shot = label => browser.screenshot(host, path.resolve('artifacts/room-ui-' + name + '-' + label + '.png'));
      await browser.viewport(host, 1360, 1000);
      await browser.activate(host);
      await until(
        '!document.body.classList.contains("auth-pending") && ' +
          hasText('#identity', 'Demo host') +
          ' && ' +
          shown('#create') +
          ' && transport?.ready',
        'Durable room login',
      );
      await run(pressId('create'));
      await until(isOpen('#room-dialog'), 'Create chooser');
      await shot('chooser');
      await run(
        choose('room-create-preset', 'play-pause') +
          ';' +
          byId('room-name') +
          '.value="Friday room";' +
          pressId('room-create'),
      );
      await until(text('#options-title') + '==="Friday room" && !' + isOpen('#room-dialog'), 'Named room');
      const id = roomIdByName('Friday room');
      await run(pressId('room-settings-open'));
      await until(isOpen('#room-settings-dialog') + ' && ' + shown('#room-settings-content'), 'Lifecycle settings');
      assert.equal(await run(attr('#room-settings-nav [data-section=general]', 'aria-current')), 'true');
      assert.match(await run(text('#room-lifetime-details')), /Created.*Last active/);
      assert.equal(await run(byId('room-keep-empty') + '.checked'), false);
      await run(pressId('room-keep-empty'));
      await until(text('#room-settings-status') + '==="Saved"', 'Keep room saved');
      await run(pressId('room-keep-empty'));
      await until(isOpen('#room-confirm-dialog'), 'Disposable room warning');
      await run(press('#room-confirm-dialog button[value=cancel]'));
      await until(
        byId('room-keep-empty') + '.checked && !' + isOpen('#room-confirm-dialog'),
        'Keep room warning cancelled',
      );
      await run(byId('room-member-limit') + '.value="12";' + pressId('room-member-limit-save'));
      await until(hasText('#room-capacity-details', '/ 12 people'), 'Room capacity saved');
      await shot('lifecycle-desktop');
      await browser.viewport(host, 390, 844);
      await shot('lifecycle-phone');
      await browser.viewport(host, 1360, 1000);
      await run(pressId('room-settings-dismiss'));
      await until('!' + isOpen('#room-settings-dialog'), 'Settings closed');

      await until(shown('.library-key[data-play=demo]'), 'Synchronization video in Media');
      await run(press('.library-key[data-play=demo]'));
      await until(text('#title') + '==="uburoom synchronization test"', 'Media load');
      await until(attr('#player-play', 'aria-label') + '==="Pause"', 'Media plays');
      await run(pressId('player-play'));
      await until(attr('#player-play', 'aria-label') + '==="Play"', 'Paused');
      await run(seekTo(17));
      await until(pausedAt('0:17'), 'Saved paused position');
      assert.ok(enginePosition(id).paused && Math.abs(enginePosition(id).position - 17) < 0.1, 'server holds 0:17');
      const room = app.watch.rooms.get(id),
        hostPresence = [...room.viewers.values()].find(viewer => viewer.userId === room.saved.creatorId);
      // The host's own player keeps reporting its real sync quality; hold the fixture value instead.
      let pinnedQuality;
      Object.defineProperty(hostPresence, 'syncQuality', {
        configurable: true,
        get: () => pinnedQuality,
        set: () => {},
      });
      const quality = (score, extra = {}) => {
        pinnedQuality = {
          status: 'playing',
          score,
          lastKnownScore: score,
          confidence: 'confident',
          measuredAt: Date.now(),
          lastKnownAt: Date.now(),
          updatedAt: Date.now(),
          mediaVersion: room.mediaVersion,
          streamVersion: hostPresence.streamVersion,
          ...extra,
        };
      };
      const icon = '#room-participants .room-roster-sync-quality';
      quality(0.94);
      await run('refreshState()');
      await until(shown('#room-participants [data-quality=excellent]'), 'Room sync indicator');
      assert.equal(
        await run(attr('#room-participants [data-quality=excellent]', 'aria-label')),
        'Sync details for Demo host: Sync quality: 94% (Excellent)',
      );
      assert.equal(
        await run(
          '(()=>{const row=document.querySelector("#room-participants .room-person"),r=s=>row.querySelector(s)?.getBoundingClientRect();const role=r(".room-roster-role"),name=r(".room-roster-name"),sync=r(".room-roster-sync-quality");if(!role||!name||!sync)return false;const mid=b=>b.top+b.height/2;return role.right<=name.left+1&&name.right<=sync.left+1&&Math.abs(mid(role)-mid(name))<4&&Math.abs(mid(name)-mid(sync))<4;})()',
        ),
        true,
        'role, name and sync quality sit left to right on one roster line',
      );
      // Each level shows its semantic color in both themes, switched through the real appearance toggle.
      const colorIs = token =>
        '(()=>{const e=' +
        dom.q(icon) +
        ',p=document.createElement("span");p.style.color="var(' +
        token +
        ')";document.body.append(p);const same=getComputedStyle(e).color===getComputedStyle(p).color;p.remove();return same;})()';
      for (const theme of ['dark', 'light']) {
        if ((await run('document.documentElement.dataset.theme')) !== theme) await run(pressId('theme-toggle'));
        await until('document.documentElement.dataset.theme===' + JSON.stringify(theme), theme + ' theme');
        for (const [score, level, token, percent] of [
          [1, 'excellent', '--success', '100% (Excellent)'],
          [0.75, 'good', '--good', '75% (Good)'],
          [0.5, 'fair', '--warning', '50% (Fair)'],
          [0.49, 'poor', '--danger', '49% (Poor)'],
        ]) {
          quality(score);
          await run('refreshState()');
          await until(attr(icon, 'data-quality') + '===' + JSON.stringify(level), theme + ' ' + level + ' level');
          assert.equal(await run(attr(icon, 'aria-label')), 'Sync details for Demo host: Sync quality: ' + percent);
          assert.equal(await run(colorIs(token)), true, theme + ' ' + level + ' uses ' + token);
        }
        // A measurement from another stream is kept but shown grey with reduced confidence.
        quality(0.72, { streamVersion: -1 });
        await run('refreshState()');
        await until(attr(icon, 'data-confidence') + '==="reduced"', theme + ' retained level');
        assert.equal(await run(attr(icon, 'data-quality')), 'fair');
        assert.equal(await run(colorIs('--muted')), true, theme + ' retained level is muted');
      }
      await run(pressId('theme-toggle'));
      await until('document.documentElement.dataset.theme==="dark"', 'Dark theme restored');
      quality(0.94);
      await run('refreshState()');
      await until(attr(icon, 'data-quality') + '==="excellent"', 'Excellent restored');
      await shot('sync-quality');
      await run(pressId('room-settings-open'));
      await until(isOpen('#room-settings-dialog') + ' && ' + shown('#room-settings-content'), 'Room settings');
      await run(settingsSection('people'));
      await until(shown('#room-current-people'), 'Room people settings');
      assert.equal(
        await run(count('#room-current-people .room-roster-sync-quality')),
        0,
        'quality stays out of Room Settings participant lists',
      );
      await run(pressId('room-settings-dismiss'));
      delete hostPresence.syncQuality;
      hostPresence.syncQuality = undefined;
      await run('refreshState()');
      if (process.argv.includes('--sync-quality-only')) {
        console.log(
          name + ': Room sync-quality levels, retained grey state, alignment, themes and settings exclusion passed',
        );
        continue;
      }

      await until(shown('#queue-panel'), 'Queue panel visible');
      await until(hasText('#queue-upcoming-view', 'The queue is empty'), 'Empty queue hint');
      assert.equal(await run(text('#queue-scroll-next .queue-navigation-count')), '');
      await run('queueUI.add({mediaId:"demo",title:"First queued item",subtitle:"Ep 1",duration:60})');
      await until(
        count('#queue-upcoming-list .queue-entry') + '===1 && ' + hasText('#queue-scroll-next', '1 queued'),
        'First queue item added',
      );
      assert.equal(queueOf(id).pendingCount, 1);
      assert.equal(await run(enabled('#next')), true);
      await run('queueUI.add({mediaId:"demo",title:"Second queued item",subtitle:"Ep 2",duration:60})');
      await until(
        count('#queue-upcoming-list .queue-entry') + '===2 && ' + hasText('#queue-scroll-next', '2 queued'),
        'Second queue item added',
      );
      await shot('queue');
      await run('document.querySelectorAll(".queue-action-down")[0].click()');
      await until(
        'document.querySelectorAll("#queue-upcoming-list .queue-entry-title")[0]?.textContent.includes("Second queued item")',
        'Queue reordered',
      );
      await run('document.querySelectorAll(".queue-action-remove")[1].click()');
      await until(
        count('#queue-upcoming-list .queue-entry') + '===1 && ' + hasText('#queue-scroll-next', '1 queued'),
        'Queue item removed',
      );
      await run(pressId('next'));
      await until(text('#queue-scroll-next .queue-navigation-count') + '===""', 'Transport next plays queued item');
      assert.equal(queueOf(id).pendingCount, 0);
      assert.ok(queueOf(id).historyCount >= 1);
      await run(pressId('queue-scroll-previous'));
      await until(count('#queue-history-list .queue-history-entry') + '>=1', 'History tab visible');
      await shot('history');
      await run(press('#queue-history-list .queue-item-restart'));
      await until(text('#title') + '==="uburoom synchronization test"', 'History restart loaded demo');
      await until(attr('#player-play', 'aria-label') + '==="Pause"', 'History restart playing');
      await run(pressId('player-play'));
      await run(seekTo(17));
      await until(pausedAt('0:17'), 'Saved position restored to 17');
      await run(pressId('queue-scroll-previous'));
      await until(enabled('#queue-clear-history'), 'Clear history button enabled');
      await run(pressId('queue-clear-history'));
      await until(isOpen('#room-confirm-dialog'), 'Clear history confirmation');
      await run(pressId('room-confirm-yes'));
      await until(hasText('#queue-history-view', 'No playback history yet'), 'History cleared');
      await run(pressId('queue-scroll-next'));
      await until(byId('queue-autoplay') + '.checked', 'Autoplay default on');
      // Switching the queue tab smooth-scrolls #queue-layout; Firefox ends it with sub-pixel steps for
      // ~60 ms. Popovers close on any scroll, so a press inside that tail loses its confirmation.
      await settledScroll(browser, host, 'queue-layout');
      const autoplay = () => app.watch.roomState.store.get(app.watch.rooms.get(id).s.roomId).autoplay;
      await until(enabled('#queue-autoplay'), 'Autoplay toggle ready');
      await run(pressId('queue-autoplay'));
      await until(
        hasText('.watch-popover', 'Auto-play saved.') + ' && !' + byId('queue-autoplay') + '.checked',
        'Autoplay off',
      );
      await waitFor(() => autoplay() === false, 'Autoplay off saved');
      await until(enabled('#queue-autoplay'), 'Autoplay toggle ready again');
      await run(pressId('queue-autoplay'));
      await until(byId('queue-autoplay') + '.checked', 'Autoplay on');
      await waitFor(() => autoplay() === true, 'Autoplay on saved');
      await run(press('.library-home-card[data-section="2"][data-tab=library]'));
      await until(text('.library-title') + '==="Queue fixture show"', 'Show library');
      await run(press('.library-open'));
      await until(hasText('.library-detail-actions [data-queue]', 'Add show'), 'Bulk show action');
      assert.equal(
        await run(byId('library-content') + '.scrollWidth <= ' + byId('library-content') + '.clientWidth + 1'),
        true,
        'Show details fit the library',
      );
      await shot('bulk-source');
      await run(press('.library-detail-actions [data-queue]'));
      await until(isOpen('#queue-bulk-dialog'), 'Bulk options');
      assert.equal(await run(byId('queue-bulk-filter') + '.options[1].textContent'), 'Unfinished by this room');
      await shot('bulk');
      await run(pressId('queue-bulk-submit'));
      await until(
        '!' + isOpen('#queue-bulk-dialog') + ' && ' + count('#queue-upcoming-list .queue-entry') + '===2',
        'Bulk excludes Specials',
      );
      await run(press('.library-tile[data-item="110"] .library-open'));
      await until(hasText('.library-detail-actions [data-queue]', 'Add season'), 'Bulk season action');
      await run(press('.library-detail-actions [data-queue]'));
      await until(isOpen('#queue-bulk-dialog'), 'Season options');
      await run(
        choose('queue-bulk-filter', 'unfinished') +
          ';' +
          byId('queue-bulk-specials') +
          '.checked=true;' +
          pressId('queue-bulk-submit'),
      );
      await until(
        '!' + isOpen('#queue-bulk-dialog') + ' && ' + count('#queue-upcoming-list .queue-entry') + '===3',
        'Unfinished season includes Specials',
      );
      await run(
        '[...document.querySelectorAll(".library-crumb")].find(item=>item.textContent==="Queue fixture show").click()',
      );
      await until(shown('.library-detail-actions [data-auto-queue]'), 'Show random source restored');
      const upcomingIds =
        '[...document.querySelectorAll("#queue-upcoming-list .queue-entry")].map(item=>item.dataset.entryId).sort().join()';
      const bulkIds = await run(upcomingIds);
      const currentBeforeShuffle = queueOf(id).current.id;
      await run(pressId('queue-shuffle'));
      await until(enabled('#queue-shuffle'), 'Shuffle completes');
      assert.equal(await run(upcomingIds), bulkIds);
      assert.equal(queueOf(id).current.id, currentBeforeShuffle);
      await run(press('.library-detail-actions [data-auto-queue]'));
      await until(
        isOpen('#room-settings-dialog') + ' && ' + byId('queue-auto-mode') + '.value==="random"',
        'Random show source',
      );
      await run(pressId('queue-auto-save'));
      await waitFor(() => queueOf(id).autoQueue?.mode === 'random', 'Random configuration saved');
      assert.equal(queueOf(id).autoQueue.scope.type, 'show');
      await run(pressId('room-settings-dismiss'));
      await until('!' + isOpen('#room-settings-dialog'), 'Settings closed');
      await until(
        enabled('#queue-auto-toggle') + ' && ' + byId('queue-auto-toggle') + '.checked',
        'Auto-queue toggle ready',
      );
      await run(pressId('queue-auto-toggle'));
      await until(
        hasText('.watch-popover', 'Auto-queue saved.') + ' && !' + byId('queue-auto-toggle') + '.checked',
        'Quick Auto-queue off',
      );
      await waitFor(() => queueOf(id).autoQueue.mode === 'off', 'Quick Auto-queue off saved');
      await until(
        enabled('#queue-auto-toggle') + ' && !' + byId('queue-auto-toggle') + '.checked',
        'Auto-queue toggle ready again',
      );
      await run(pressId('queue-auto-toggle'));
      await until(
        hasText('.watch-popover', 'Auto-queue saved.') + ' && ' + byId('queue-auto-toggle') + '.checked',
        'Quick Auto-queue on',
      );
      await waitFor(() => queueOf(id).autoQueue.mode === 'random', 'Quick Auto-queue restores source');
      await browser.viewport(host, 390, 844);
      await until(shown('#section-tab-queue'), 'Phone section tabs');
      await run(pressId('section-tab-queue'));
      await until(
        attr('#section-tab-queue', 'aria-selected') + '==="true" && ' + shown('#queue-auto-open'),
        'Phone queue tab',
      );
      await run(pressId('queue-auto-open'));
      await until(isOpen('#room-settings-dialog'), 'Phone auto-queue dialog');
      await shot('phone-auto');
      assert.equal(
        await run(byId('queue-auto-dialog') + '.scrollWidth <= ' + byId('queue-auto-dialog') + '.clientWidth'),
        true,
      );
      await run(choose('queue-auto-mode', 'off') + ';' + pressId('queue-auto-save'));
      await waitFor(() => queueOf(id).autoQueue?.mode === 'off', 'Auto-queue disabled');
      await run(pressId('room-settings-dismiss'));
      await browser.viewport(host, 1360, 1000);
      await run(pressId('library-home') + ';' + press('.library-home-card[data-section="1"][data-tab=library]'));
      await until(shown('.library-scope-actions [data-auto-queue]'), 'Movie library random source');
      await run(press('.library-scope-actions [data-auto-queue]'));
      await until(
        isOpen('#room-settings-dialog') + ' && ' + hasText('#queue-auto-source', 'Movies'),
        'Movie random source selected',
      );
      await run(
        pressId('room-settings-dismiss') +
          ';' +
          pressId('library-home') +
          ';' +
          press('.library-home-card[data-section="1"][data-tab=collections]'),
      );
      await until(text('.library-title') + '==="Queue fixture collection"', 'Collection catalog');
      await run(press('.library-open'));
      await until(shown('.library-detail-actions [data-auto-queue]'), 'Collection random source');
      await run(press('.library-detail-actions [data-auto-queue]'));
      await until(
        isOpen('#room-settings-dialog') + ' && ' + hasText('#queue-auto-source', 'Queue fixture collection'),
        'Collection random source selected',
      );
      await run(pressId('room-settings-dismiss'));
      await run(pressId('queue-clear-queue'));
      await until(isOpen('#room-confirm-dialog'), 'Bulk cleanup confirmation');
      await run(pressId('room-confirm-yes'));
      await until(count('#queue-upcoming-list .queue-entry') + '===0', 'Bulk queue cleared');
      await run('queueUI.add({mediaId:"demo",title:"Autoplay successor",duration:60})');
      await until(count('#queue-upcoming-list .queue-entry') + '===1', 'Successor queued');
      const endingEntry = queueOf(id).current.id;
      await run(seekTo(54));
      await until(text('#time') + '.startsWith("0:54")', 'Seek near end');
      await run(pressId('player-play'));
      await until(attr('#player-play', 'aria-label') + '==="Pause"', 'Final seconds play normally');
      await until(
        shown('#ending-stage') + ' && /^Up next in \\d+s$/.test(' + text('#ending-kicker') + ')',
        'Natural end starts countdown',
      );
      assert.equal(queueOf(id).current, null);
      assert.equal(!!app.watch.rooms.get(id).media, false);
      await run('window.scrollTo(0,0)');
      await shot('countdown');
      await browser.viewport(host, 390, 844);
      await run('window.scrollTo(0,0)');
      await shot('phone-countdown');
      assert.equal(
        await run(
          '(()=>{const a=' +
            byId('ending-stage') +
            '.getBoundingClientRect(),b=' +
            byId('stage') +
            '.getBoundingClientRect();return a.left>=b.left && a.right<=b.right && a.top>=b.top && a.bottom<=b.bottom;})()',
        ),
        true,
      );
      await browser.viewport(host, 1360, 1000);
      await run(pressId('ending-cancel'));
      await until(hidden('#ending-cancel') + ' && ' + enabled('#ending-play'), 'Countdown cancelled');
      assert.equal(app.watch.rooms.get(id).autoplayCountdown, undefined);
      assert.equal(queueOf(id).current, null);
      assert.equal(queueOf(id).pendingCount, 1);
      await run(pressId('ending-play'));
      await until(
        hidden('#ending-stage') + ' && ' + attr('#player-play', 'aria-label') + '==="Pause"',
        'Next video started',
      );
      assert.notEqual(queueOf(id).current?.id, endingEntry);
      await run('queueUI.add({mediaId:"demo",title:"Final item",duration:60})');
      await until(count('#queue-upcoming-list .queue-entry') + '===1', 'Final item queued');
      await run(seekTo(54));
      await until('/^Up next in \\d+s$/.test(' + text('#ending-kicker') + ')', 'Second verified ending');
      await run(pressId('theater') + ';window.scrollTo(0,0)');
      await until(attr('#theater', 'aria-pressed') + '==="true"', 'Theater on');
      await shot('theater-countdown');
      await waitFor(() => queueOf(id).pendingCount === 0, 'Countdown advances once', 30000);
      assert.equal(queueOf(id).historyCount, 2);
      const completed = app.watch.roomState.queue
        .history(app.watch.rooms.get(id).s.roomId)
        .items.find(item => item.id === endingEntry);
      assert.equal(completed.outcome, 'completed');
      assert.equal(completed.position, 60);
      await until(attr('#player-play', 'aria-label') + '==="Pause"', 'Autoplayed item playing');
      await run(pressId('theater') + ';' + pressId('player-play'));
      await run(seekTo(17));
      await until(pausedAt('0:17'), 'Autoplay fixture restored paused');

      guest = await openPage(browser, config.publicUrl + '/?demo=guest');
      await browser.until(guest, hasText('#identity', 'Demo guest') + ' && transport?.ready', 'Guest login');
      await browser.until(guest, shown('#lobby-rooms .room-actions :is(a,button)'), 'Guest sees the room');
      await browser.evaluate(guest, press('#lobby-rooms .room-actions :is(a,button)'));
      await browser.until(
        guest,
        text('#options-title') + '==="Friday room" && ' + shown('#player-play'),
        'Viewer joins',
      );
      assert.equal(
        await browser.evaluate(guest, byId('timeline') + '.disabled && !' + byId('player-play') + '.disabled'),
        true,
      );
      assert.equal(await browser.evaluate(guest, byId('next') + '.disabled'), true);
      assert.equal(
        await browser.evaluate(
          guest,
          byId('queue-autoplay') + '.disabled && !' + byId('queue-auto-open') + '.disabled',
        ),
        true,
      );
      const viewerPermissions = app.watch.rooms.get(id).s.permissions.viewer;
      assert.equal(viewerPermissions.addQueue || viewerPermissions.editQueue, false);
      // A viewer without seek permission is refused by the server's command engine, not only by a disabled
      // control. execute() is the page's command path; no on-screen control can send a refused seek.
      assert.match(
        await browser.evaluate(
          guest,
          'execute({action:"media.seek.absolute",args:{seconds:2}}).then(()=>"unexpected success",error=>error.message)',
        ),
        /permissions/,
      );
      await waitFor(() => app.watch.rooms.get(id).viewers.size === 2, 'Both viewers');
      await run(pressId('room-settings-open'));
      await until(isOpen('#room-settings-dialog') + ' && ' + shown('#room-settings-content'), 'Room settings');
      await run(settingsSection('manage'));
      await shot('settings');
      await run(
        settingsSection('permissions') +
          ';' +
          byId('room-permission-custom') +
          '.open=true;' +
          press('#room-permissions button[data-role=viewer][data-permission=seek]'),
      );
      await browser.until(guest, '!' + byId('timeline') + '.disabled', 'Viewer seek grant');
      await until(text('#room-settings-status') + '==="Saved"', 'Settings save completes');
      await run(settingsSection('people') + ';' + press('#room-current-people button'));
      await browser.until(
        guest,
        hasText('#room-participants', 'Demo guest') + ' && ' + shown('#room-settings-open'),
        'Assigned host',
      );
      assert.equal(
        await browser.evaluate(
          guest,
          '[...document.querySelectorAll("[data-quick-permission]")].every(input=>input.disabled)',
        ),
        true,
        'a host cannot edit management permissions',
      );
      await until(hasText('#room-current-people', 'Demo guest') + ' && ' + enabled('#room-transfer'), 'Host controls');
      await run(settingsSection('general') + ';' + choose('room-settings-visibility', 'private'));
      await waitFor(() => app.watch.rooms.get(id).s.visibility === 'private', 'Private cohost room');
      await until(enabled('#room-transfer'), 'Transfer still available');
      await browser.viewport(host, 390, 844);
      await shot('phone-settings');
      assert.equal(
        await run(byId('room-settings-dialog') + '.scrollWidth <= ' + byId('room-settings-dialog') + '.clientWidth'),
        true,
      );
      await browser.viewport(host, 1360, 1000);
      await run(settingsSection('people') + ';' + pressId('room-transfer'));
      await until(isOpen('#room-confirm-dialog'), 'Transfer confirmation');
      await run(pressId('room-confirm-yes'));
      await until(shown('#room-current-people [aria-label=Host]'), 'Creator transferred');
      await waitFor(
        () => app.watch.rooms.get(id).saved.creatorId === app.registry.identity('discord', subjects.guest).userId,
        'New creator',
      );

      const admin = await openPage(browser, config.publicUrl + '/?demo=guest2');
      await browser.until(admin, shown('#admin-mode') + ' && transport?.ready', 'Configured administrator');
      assert.equal(await browser.evaluate(admin, attr('#admin-mode', 'aria-checked')), 'false');
      assert.equal(await browser.evaluate(admin, count('#lobby-rooms .saved-room')), 0);
      await browser.evaluate(admin, pressId('admin-mode'));
      await browser.until(
        admin,
        attr('#admin-mode', 'aria-checked') + '==="true" && ' + count('#lobby-rooms .saved-room') + '===1',
        'Admin mode private visibility',
      );
      await browser.evaluate(admin, press('#lobby-rooms .room-actions :is(a,button)'));
      await browser.until(admin, text('#options-title') + '==="Friday room"', 'Admin joins private room');
      await browser.evaluate(admin, pressId('admin-mode'));
      await browser.until(
        admin,
        attr('#admin-mode', 'aria-checked') + '==="false" && ' + text('#options-title') + '!=="Friday room"',
        'Admin mode off removes private access',
      );
      await run(pressId('room-settings-dismiss'));
      await run(pressId('room-settings-open'));
      await until(shown('#room-settings-content'), 'Settings reopened');
      await run(settingsSection('manage'));
      await until(enabled('#room-settings-close-live'), 'Host close rights');
      await run(pressId('room-settings-close-live'));
      await until(isOpen('#room-confirm-dialog'), 'Close confirmation');
      await run(pressId('room-confirm-yes'));
      await until('!' + isOpen('#room-settings-dialog') + ' && ' + shown('#lobby-reopen'), 'Room closes for everyone');
      assert.equal(app.watch.rooms.size, 0);
      await run(pressId('reopen'));
      await until(count('#saved-rooms .saved-room') + '===1', 'Saved room picker');
      await shot('saved');
      await run(press('#saved-rooms .room-actions button'));
      await until(text('#title') + '==="uburoom synchronization test" && !' + isOpen('#room-dialog'), 'Restored media');
      assert.ok(app.watch.rooms.get(id), 'the same room reopened');
      await until(pausedAt('0:17'), 'Restored paused at 17s');
      assert.ok(enginePosition(id).paused && Math.abs(enginePosition(id).position - 17) < 0.1);
      await shot('restored');
      await run(pressId('theater'));
      await run(pressId('room-settings-open'));
      await until(isOpen('#room-settings-dialog') + ' && ' + shown('#room-settings-content'), 'Theater settings');
      await run(settingsSection('manage'));
      await shot('theater');
      await run(pressId('room-settings-close-live'));
      await until(isOpen('#room-confirm-dialog'), 'Second close confirmation');
      await run(pressId('room-confirm-yes'));
      await until(shown('#lobby-reopen'), 'Second close');
      await browser.activate(guest);
      await browser.evaluate(guest, pressId('reopen'));
      await browser.until(guest, count('#saved-rooms .room-actions button') + '===2', 'Creator saved room');
      await browser.evaluate(guest, 'document.querySelectorAll("#saved-rooms .room-actions button")[1].click()');
      await browser.until(
        guest,
        isOpen('#room-settings-dialog') + ' && ' + enabled('#room-settings-delete'),
        'Creator delete',
      );
      await browser.evaluate(guest, pressId('room-settings-delete'));
      await browser.until(guest, isOpen('#room-confirm-dialog'), 'Delete confirmation');
      await browser.evaluate(guest, pressId('room-confirm-yes'));
      await browser.until(guest, '!' + isOpen('#room-settings-dialog'), 'Room deleted');
      assert.equal(app.watch.roomState.store.list(app.registry.identity('discord', subjects.guest).userId).total, 0);
      await run(
        pressId('create') +
          ';' +
          choose('room-create-preset', 'queue') +
          ';' +
          byId('room-name') +
          '.value="Full permissions";' +
          pressId('room-create'),
      );
      await until(text('#options-title') + '==="Full permissions"', 'Full-permission creation');
      const largeRoom = roomByName('Full permissions');
      assert.equal(largeRoom.s.permissions.viewer.editQueue, true);
      assert.equal(largeRoom.s.permissions.viewer.deleteRoom, false);
      await app.watch.roomState.queue.addBulk(
        largeRoom.s.roomId,
        largeRoom.saved.creatorId,
        Array.from({ length: 110 }, (_, i) => ({
          serverId: 'fixture-machine',
          mediaId: String(1000 + i),
          type: 'episode',
          title: 'Paged episode ' + i,
          duration: 60,
        })),
      );
      await run('refreshState()');
      await until(count('#queue-upcoming-list .queue-entry') + '===100', 'First upcoming page');
      await run(
        '[...document.querySelectorAll("#queue-panel button")].find(button=>button.textContent==="Load more upcoming").click()',
      );
      await until(count('#queue-upcoming-list .queue-entry') + '===110', 'Additional upcoming page');
      await run(pressId('create'));
      await until(isOpen('#room-dialog'), 'Suggested room chooser');
      const suggestion = await run(byId('room-name') + '.placeholder');
      assert.match(suggestion, /^Room [A-Z][a-z]{5}$/);
      assert.equal(await run(byId('room-name') + '.value'), '');
      await shot('suggested-name');
      await run(byId('room-name') + '.value="   ";' + pressId('room-create'));
      await until(text('#options-title') + '===' + JSON.stringify(suggestion), 'Suggested name saved');
      assert.ok(roomByName(suggestion), 'room saved under the suggested name');
      console.log(
        name +
          ': named create, queue add/reorder/remove/next/history/clear, bulk show/Specials, shuffle, random configuration, autoplay toggle, real natural end/countdown/cancel/advance, viewer policy, host/creator transfer, private cohosts, Admin mode, close/reopen paused at 17s, delete, queue preset without deletion and rendered desktop/phone/theater passed',
      );
    } catch (error) {
      console.error(
        [...app.watch.rooms.values()].map(room => ({
          name: room.s.name,
          creator: room.saved?.creatorId,
          hosts: room.saved?.hosts,
          revision: room.saved?.revision,
          viewers: room.viewers.size,
        })),
      );
      for (const [label, page] of [
        ['host', host],
        ['guest', guest],
      ]) {
        if (!browser || !page) continue;
        console.error(
          label + ':',
          await browser
            .evaluate(
              page,
              '({url:location.pathname,body:document.body.className,identity:' +
                text('#identity') +
                ',room:' +
                text('#options-title') +
                ',title:' +
                text('#title') +
                ',time:' +
                text('#time') +
                ',play:' +
                attr('#player-play', 'aria-label') +
                ',error:' +
                text('#error') +
                ',settingsStatus:' +
                text('#room-settings-status') +
                ',openDialogs:[...document.querySelectorAll("dialog[open]")].map(d=>d.id),queueTitles:[...document.querySelectorAll("#queue-upcoming-list .queue-entry-title")].map(e=>e.textContent)})',
            )
            .catch(problem => problem.message),
        );
        await browser
          .screenshot(
            page,
            path.resolve('artifacts/room-ui-' + name + '-' + (label === 'host' ? '' : 'guest-') + 'failure.png'),
          )
          .catch(() => {});
      }
      throw error;
    } finally {
      await browser?.close();
      await app.close();
    }
  }
}
// Wait until an element's horizontal scroll position reads the same three times, 100 ms apart. Sampled from
// the runner: Firefox throttles animation frames in this background tab, so a frame count never completes.
async function settledScroll(browser, page, id, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last,
    same = 0;
  while (Date.now() < deadline) {
    const left = await browser.evaluate(
      page,
      'document.getElementById(' + JSON.stringify(id) + ')?.scrollLeft ?? null',
    );
    same = left === last ? same + 1 : 0;
    if (same >= 2) return;
    last = left;
    await pause(100);
  }
  throw new Error(id + ' scroll did not settle');
}
async function waitFor(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(100);
  }
  throw new Error(label + ' timed out');
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
