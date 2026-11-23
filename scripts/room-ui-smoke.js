/* Durable room controls in disposable browsers/accounts. No .env or real providers.
 * Checks what is on screen (elements, text, ARIA state) and confirms shared state on the
 * fixture server. Page globals still used, for want of an on-screen signal:
 *   transport.ready  - socket readiness before the first command (lobby looks ready earlier)
 *   refreshState()   - re-read room state after the runner changes server-side presence
 *   queueUI.add()    - queue an item without a library entry for the synchronization video
 *   execute()        - send a seek the viewer's disabled timeline cannot, to prove the server refuses it
 *   decodedFrames()  - verify the player has actually decoded video on startup and after reconnect
 */
'use strict';
const { EVIDENCE } = require('./lib/evidence');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { recordRoomSyncTimeline, sampleRoomSync } = require('../server/room/sync-history');
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
  const playbackOnly = process.argv.includes('--playback-only');
  for (const name of browsers) {
    const { app, config, subjects } = await startFixtureServer();
    let browser, host, guest;
    const roomByName = roomName => [...app.watch.rooms.values()].find(room => room.name === roomName);
    const roomIdByName = roomName => [...app.watch.rooms.entries()].find(([, room]) => room.name === roomName)?.[0];
    const queueOf = id => app.watch.roomState.queue.summary(app.watch.rooms.get(id).roomId);
    const enginePosition = id => require('../shared/engine.mjs').snapshot(app.watch.rooms.get(id).state);
    try {
      browser = await playbackBrowser(name);
      host = await openPage(browser, config.publicUrl + '/?demo=host');
      // Stay within the unchanged 40 messages/second production request budget.
      const run = async expression => {
        await pause(100);
        await browser.activate(host);
        return browser.evaluate(host, expression);
      };
      const until = (expression, label, timeout) => browser.until(host, expression, label, timeout);
      const closeSettings = async () => {
        await until(
          '!(' +
            shown('#queue-auto-save') +
            ' && ' +
            byId('queue-auto-save') +
            '.disabled) && ' +
            byId('room-settings-panels') +
            '.getAttribute("aria-busy")!=="true"',
          'Settings idle before closing',
        );
        await run(pressId('room-settings-dismiss'));
        await until('!' + isOpen('#room-settings-dialog'), 'Settings closed');
      };
      require('node:fs').mkdirSync(EVIDENCE, { recursive: true });
      const shot = label => browser.screenshot(host, path.resolve(EVIDENCE, 'room-ui-' + name + '-' + label + '.png'));
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
      if (!playbackOnly) await shot('chooser');
      await run(
        choose('room-create-preset', 'play-pause') +
          ';' +
          byId('room-name') +
          '.value="Friday room";' +
          pressId('room-create'),
      );
      await until(text('#options-title') + '==="Friday room" && !' + isOpen('#room-dialog'), 'Named room');
      const id = roomIdByName('Friday room');
      if (playbackOnly) {
        await checkPlaybackReconnect(app.watch, id, run, until);
        console.log(name + ': first decoded playback and same-tab reconnect passed');
        continue;
      }
      assert.equal(await run(text('#room-participants-heading')), 'Viewers (1/20)');
      assert.equal(await run(hidden('#room-participants-expand')), true, 'expand chevron hidden when roster fits');
      assert.equal(
        await run(
          '(()=>{const v=document.querySelector(".room-participant-column")?.getBoundingClientRect(),t=document.getElementById("room-tools-column")?.getBoundingClientRect();const ids=[...document.querySelectorAll("#room-tools-column .room-tools-list > button")].map(b=>b.id);return !!v&&!!t&&t.left>=v.right-1&&ids.join(",")==="room-schedule,room-human-check-ask,room-sync-spread";})()',
        ),
        true,
        'Tools column sits right of Viewers with Schedule, Readiness check, Room sync order',
      );
      await run(pressId('room-people-open'));
      await until(
        isOpen('#room-settings-dialog') +
          ' && ' +
          shown('#room-settings-content') +
          ' && ' +
          attr('#room-settings-nav [data-section=people]', 'aria-current') +
          '==="true"',
        'Viewers heading opens Room settings -> Viewers',
      );
      await closeSettings();
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
      assert.equal(await run(hidden('#room-member-limit-save')), true);
      await run(choose('room-member-limit', '12'));
      await run(byId('room-member-limit') + '.focus(); refreshState()');
      await until(
        shown('#room-member-limit-save') +
          ' && document.activeElement.id==="room-member-limit" && ' +
          byId('room-member-limit') +
          '.value==="12"',
        'Room refresh preserves the focused capacity draft',
      );
      await run(pressId('room-member-limit-save'));
      await until(
        hidden('#room-member-limit-save') + ' && ' + hasText('#room-settings-status', 'Saved'),
        'Room capacity saved',
      );
      await run(pressId('room-settings-refresh'));
      await until(
        shown('#room-settings-content') + ' && ' + byId('room-member-limit') + '.value==="12"',
        'Saved capacity survives refresh',
      );
      await run(settingsSection('manage') + ';' + pressId('room-transfer-add-host'));
      await until('document.activeElement.id==="room-person-search"', 'Assign host shortcut opens roster search');
      await until(
        shown('#room-settings-share') + ' && ' + shown('#room-invite-reroll'),
        'Roster shows invite controls',
      );
      await run(press('#room-host-disclosure summary'));
      await shot('viewers');
      await run(pressId('room-settings-share'));
      await until(
        shown('#room-share-url-input') + ' && ' + byId('room-share-url-input') + '.value.includes("/join/")',
        'Share opens the current invite link',
      );
      await run(pressId('room-share-dismiss'));
      await run(settingsSection('permissions'));
      await run(
        'window.__permBtn=document.querySelector("#room-permissions button[data-role=viewer][data-permission=seek]");window.__permBtn.focus();' +
          pressId('room-settings-refresh'),
      );
      await until(
        text('#room-settings-status') +
          '==="" && ' +
          shown('#room-settings-content') +
          ' && window.__permBtn?.isConnected && document.activeElement===window.__permBtn',
        'Permissions control preserves DOM identity and focus across refresh',
      );
      await shot('permissions');
      await run(settingsSection('general'));
      await shot('lifecycle-desktop');
      await browser.viewport(host, 390, 844);
      await shot('lifecycle-phone');
      await browser.viewport(host, 1360, 1000);
      await closeSettings();

      await checkPlaybackReconnect(app.watch, id, run, until);
      await run(pressId('admin-mode'));
      await until(
        attr('#admin-mode', 'aria-checked') + '==="false" && !' + shown('.library-home-card[data-play=demo]'),
        'Admin mode off hides the sync test video',
      );
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
      quality(1, { confidence: 'provisional', reason: 'awaiting-measurements' });
      await run('refreshState()');
      await until(
        attr(icon, 'aria-label') + '==="Sync details for Demo host: Sync quality: Calibrating"',
        'Unmeasured calibrating badge',
      );
      await run(press(icon));
      await until(
        text('.viewer-telemetry-card .telemetry-score-badge') + '==="Calibrating"',
        'Unmeasured calibrating card',
      );
      await run(
        'window.__telemetryClose=document.querySelector(".telemetry-card-close");window.__telemetryClose.focus()',
      );
      quality(1, { confidence: 'provisional', reason: 'awaiting-measurements', updatedAt: Date.now() - 20000 });
      await run('refreshState()');
      await until(
        attr(icon, 'aria-label') + '==="Sync details for Demo host: Sync quality: No recent sync data"',
        'Unmeasured no-recent-data badge',
      );
      await until(
        text('.viewer-telemetry-card .telemetry-score-badge') +
          '==="No recent sync data" && window.__telemetryClose?.isConnected && document.activeElement===window.__telemetryClose',
        'Unmeasured no-recent-data card preserves DOM identity and focus',
      );
      await run(press('.telemetry-card-close'));
      await until('!document.querySelector(".viewer-telemetry-card")', 'Telemetry card closed');
      await run(pressId('theme-toggle'));
      await until('document.documentElement.dataset.theme==="dark"', 'Dark theme restored');
      quality(0.94);
      await run('refreshState()');
      await until(attr(icon, 'data-quality') + '==="excellent"', 'Excellent restored');
      await shot('sync-quality');
      await run(pressId('tracks-open') + ';' + pressId('settings-more'));
      await until(isOpen('#tracks-dialog') + ' && document.activeElement.id==="tracks-close"', 'Full Player settings');
      await run(press('[data-player-section=subtitles]'));
      await run(byId('subtitle-brightness') + '.focus();refreshState()');
      await until(
        shown('#player-page-subtitles') + ' && document.activeElement.id==="subtitle-brightness"',
        'Player refresh preserves the subtitle section and focus',
      );
      await run(press('[data-player-section=media]'));
      await until(shown('#media-information') + ' && ' + hidden('#player-page-subtitles'), 'Media information section');
      await run(pressId('tracks-close'));

      await run(pressId('room-settings-open'));
      await until(isOpen('#room-settings-dialog') + ' && ' + shown('#room-settings-content'), 'Room settings');
      await run(settingsSection('playback'));
      await until(shown('#room-buffering-policy'), 'Room buffering setting');
      assert.equal(await run(hidden('#queue-auto-save')), true);
      await run(press('#queue-auto-mode-group [data-value=continue]'));
      await until(shown('#queue-auto-save'), 'Auto-queue draft shows Save');
      await run(press('#queue-auto-mode-group [data-value=off]'));
      await until(
        hidden('#queue-auto-save') + ' && ' + shown('#queue-auto-progress-reset'),
        'Reverting auto-queue hides only the draft actions',
      );
      await shot('buffering-settings');
      await browser.viewport(host, 390, 844);
      assert.equal(
        await run(byId('room-buffering-policy') + '.scrollWidth <= ' + byId('room-buffering-policy') + '.clientWidth'),
        true,
        'the buffering choices fit at phone width',
      );
      await shot('buffering-settings-phone');
      await browser.viewport(host, 1360, 1000);
      assert.equal(await run(count('#room-buffering-policy button')), 2);
      assert.equal(await run(attr('#room-buffering-continue', 'aria-pressed')), 'true');
      await run(byId('room-buffering-continue') + '.focus()');
      await browser.key(host, 'End');
      assert.equal(await run('document.activeElement.id'), 'room-buffering-pause');
      assert.equal(await run(attr('#room-buffering-continue', 'aria-pressed')), 'true');
      await browser.key(host, 'Enter');
      await until(text('#room-settings-status') + '==="Saved"', 'Shared buffering setting saved');
      await run('refreshState()');
      await until(
        attr('#room-buffering-pause', 'aria-pressed') + '==="true"',
        'Shared buffering selection survives refresh',
      );
      await run(pressId('room-buffering-continue'));
      await until(text('#room-settings-status') + '==="Saved"', 'Keep playing restored');
      await closeSettings();
      await run(pressId('theme-toggle'));
      await until('document.documentElement.dataset.theme==="light"', 'Light theme for buffering settings');
      await run(pressId('room-settings-open'));
      await until(shown('#room-settings-content'), 'Light room settings');
      await run(settingsSection('playback'));
      await until(shown('#room-buffering-policy'), 'Light buffering settings');
      await shot('buffering-settings-light');
      await closeSettings();
      await run(pressId('theme-toggle'));
      await until('document.documentElement.dataset.theme==="dark"', 'Dark theme restored after buffering settings');
      await run(pressId('room-settings-open'));
      await until(shown('#room-settings-content'), 'Room settings reopened');
      await run(settingsSection('people'));
      await until(shown('#room-current-people'), 'Room people settings');
      assert.equal(
        await run(count('#room-current-people .room-roster-sync-quality')),
        0,
        'quality stays out of Room Settings participant lists',
      );
      await closeSettings();
      delete hostPresence.syncQuality;
      hostPresence.syncQuality = undefined;
      await run('refreshState()');
      if (process.argv.includes('--sync-quality-only')) {
        seedRoomSyncHistory(app.watch, room);
        await run(pressId('room-sync-spread'));
        await until(shown('#room-sync-chart') + ' && ' + count('#room-sync-viewers li') + '===4', 'Room sync history');
        await shot('room-sync-spread');
        await browser.viewport(host, 390, 844);
        await run(
          choose('room-sync-view', 'all') +
            ';' +
            byId('room-sync-window') +
            '.focus({preventScroll:true});' +
            byId('room-sync-dialog') +
            '.scrollTop=60',
        );
        const scrollTop = await run(byId('room-sync-dialog') + '.scrollTop');
        assert.ok(scrollTop > 0, 'phone dialog can be scrolled while inspecting the graph');
        const readout = await run(text('#room-sync-caption'));
        await until(text('#room-sync-caption') + '!==' + JSON.stringify(readout), 'Live room sync refresh');
        assert.equal(await run('document.activeElement.id'), 'room-sync-window');
        assert.equal(await run(byId('room-sync-view') + '.value'), 'all');
        assert.equal(await run(byId('room-sync-dialog') + '.scrollTop'), scrollTop);
        await run(pressId('room-sync-freeze'));
        await run(choose('room-sync-window', '1') + ';' + choose('room-sync-time', '25'));
        await until(
          shown('#room-sync-chart') + ' && ' + hasText('#room-sync-coverage', '35s ago · 4 of 4 reporting'),
          'Viewer offsets',
        );
        await run(byId('room-sync-dialog') + '.scrollTop=0');
        assert.equal(
          await run(byId('room-sync-dialog') + '.scrollWidth <= ' + byId('room-sync-dialog') + '.clientWidth'),
          true,
          'room sync fits at phone width',
        );
        await shot('room-sync-phone');
        await run(pressId('room-sync-close'));
        await until('!' + isOpen('#room-sync-dialog'), 'Room sync closed');
        console.log(
          name +
            ': Room sync-quality levels, history, live refresh, phone layout, themes and settings exclusion passed',
        );
        continue;
      }

      await until(shown('#queue-panel'), 'Queue panel visible');
      await until(count('#queue-upcoming-list .queue-entry') + '===0', 'Nothing queued');
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
      await until('!document.querySelector("#queue-history-view .queue-history-entry")', 'History cleared');
      await run(pressId('queue-scroll-next'));
      await until(byId('queue-autoplay') + '.checked', 'Autoplay default on');
      const autoplay = () => app.watch.roomState.store.get(app.watch.rooms.get(id).roomId).autoplay;
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
        '[...document.querySelectorAll(".library-detail-parent-link")].find(item=>item.textContent==="Queue fixture show").click()',
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
      await closeSettings();
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
      await closeSettings();
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
          press('.library-home-collections[data-section="1"]'),
      );
      await until(text('.library-title') + '==="Queue fixture collection"', 'Collection catalog');
      await run(press('.library-open'));
      await until(shown('.library-detail-actions [data-auto-queue]'), 'Collection random source');
      await run(press('.library-detail-actions [data-auto-queue]'));
      await until(
        isOpen('#room-settings-dialog') + ' && ' + hasText('#queue-auto-source', 'Queue fixture collection'),
        'Collection random source selected',
      );
      await closeSettings();
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
        .history(app.watch.rooms.get(id).roomId)
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
          byId('room-schedule') +
            '.hidden && ' +
            byId('room-sync-spread') +
            '.hidden && !' +
            byId('room-human-check-ask') +
            '.hidden && !' +
            byId('room-tools-column') +
            '.hidden',
        ),
        true,
        'a viewer with play-pause sees only Readiness check in Tools, not Schedule or Room sync',
      );
      assert.equal(
        await browser.evaluate(
          guest,
          byId('queue-autoplay') + '.disabled && !' + byId('queue-auto-open') + '.disabled',
        ),
        true,
      );
      const viewerPermissions = app.watch.rooms.get(id).permissions.viewer;
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
      await until(shown('#room-settings-content'), 'Room settings for shared buffering');
      await run(settingsSection('playback') + ';' + pressId('room-buffering-pause'));
      await until(text('#room-settings-status') + '==="Saved"', 'Pause for everyone enabled');
      await closeSettings();
      await run(pressId('player-play'));
      await waitFor(
        () => [...room.viewers.values()].every(viewer => viewer.tracking?.previous?.state === 'playing'),
        'Both players reporting playback',
      );
      // Inject a waiting event and keep the guest below the decoder-ready threshold until recovery.
      const video = byId('video');
      await browser.evaluate(
        guest,
        'Object.defineProperty(' +
          video +
          ',"readyState",{configurable:true,get:()=>2});' +
          video +
          '.dispatchEvent(new Event("waiting"));true',
      );
      await until(
        video + '.paused && ' + hasText('#ready-status', 'Demo guest is preparing video'),
        'Host sees which viewer is preparing video',
      );
      await browser.until(guest, video + '.paused', 'Buffering viewer holds at the shared position');
      room.readinessDeadline = performance.now() - 1;
      await app.watch.review(room);
      await until(
        shown('#readiness-choice') + ' && ' + hasText('#readiness-message', 'Demo guest is preparing video'),
        'Preparation reason stays visible in the host choice',
      );
      await shot('readiness-preparing');
      // Simulate a warm player whose local position has not caught up to the room yet.
      await browser.evaluate(
        guest,
        '(()=>{const v=' +
          video +
          ';const behind=Math.max(0,v.currentTime-3);' +
          'Object.defineProperty(v,"readyState",{configurable:true,get:()=>4});' +
          'Object.defineProperty(v,"currentTime",{configurable:true,get:()=>behind,set:()=>{}});return true;})()',
      );
      await run(byId('ready-wait') + '.focus()');
      await until(
        hasText('#readiness-message', 'Demo guest is lining up playback'),
        'Host sees the updated timing reason',
      );
      assert.equal(await run('document.activeElement.id'), 'ready-wait');
      assert.equal(await browser.evaluate(guest, hidden('#readiness-choice')), true);
      await shot('readiness-timing');
      await browser.viewport(host, 390, 844);
      await shot('readiness-timing-phone');
      await browser.viewport(host, 1360, 1000);
      await run(pressId('ready-wait'));
      await until(hidden('#readiness-choice'), 'Host extends the wait');
      await browser.evaluate(
        guest,
        'delete ' +
          video +
          '.readyState;delete ' +
          video +
          '.currentTime;' +
          video +
          '.dispatchEvent(new Event("canplay"))',
      );
      await until('!' + video + '.paused', 'Host resumes after the guest buffers');
      await browser.until(guest, '!' + video + '.paused', 'Guest resumes together with host');
      await run(pressId('player-play'));
      await until(attr('#player-play', 'aria-label') + '==="Play"', 'Two-viewer fixture paused');
      await run(seekTo(17));
      await until(pausedAt('0:17'), 'Two-viewer fixture restored to 0:17');
      await run(pressId('room-settings-open'));
      await until(isOpen('#room-settings-dialog') + ' && ' + shown('#room-settings-content'), 'Room settings');
      await run(settingsSection('playback') + ';' + pressId('room-buffering-continue'));
      await until(text('#room-settings-status') + '==="Saved"', 'Shared buffering fixture restored');
      await run(settingsSection('manage'));
      await shot('settings');
      await run(
        settingsSection('permissions') +
          ';' +
          byId('room-permission-custom') +
          '.open=true;' +
          press('#room-permissions button[data-role=viewer][data-permission=seek]'),
      );
      await until(text('#room-settings-status') + '==="Saved"', 'Settings save completes');
      await browser.until(guest, '!' + byId('timeline') + '.disabled', 'Viewer seek grant');
      await run(settingsSection('people') + ';' + press('#room-current-people button'));
      await browser.until(
        guest,
        hasText('#room-participants', 'Demo guest') + ' && ' + shown('#room-settings-open'),
        'Assigned host',
      );
      assert.equal(
        await browser.evaluate(
          guest,
          '!document.querySelector("#options-panel .watch-permission-button") && state.capabilities.managePermissions===false',
        ),
        true,
        'the Room panel has no permission controls and a host cannot edit management permissions',
      );
      await until(hasText('#room-current-people', 'Demo guest') + ' && ' + enabled('#room-transfer'), 'Host controls');
      await run(settingsSection('general') + ';' + press('#room-settings-visibility-group [data-value=private]'));
      await until(
        attr('#room-settings-panels', 'aria-busy') + '==="false" && ' + text('#room-settings-status') + '==="Saved"',
        'Private visibility saved',
      );
      await waitFor(() => app.watch.rooms.get(id).visibility === 'private', 'Private cohost room');
      const assertPrivateSelected = async label => {
        assert.equal(
          await run(attr('#room-settings-visibility-group [data-value=private]', 'aria-pressed')),
          'true',
          label + ': private pressed',
        );
        assert.equal(
          await run(attr('#room-settings-visibility-group [data-value=public]', 'aria-pressed')),
          'false',
          label + ': public unpressed',
        );
        assert.equal(
          await run(text('#room-visibility-details')),
          'The leader, assigned hosts, and invited viewers can join.',
          label + ': private helper text',
        );
      };
      await assertPrivateSelected('desktop after save');
      await until(enabled('#room-transfer'), 'Transfer still available');
      await browser.viewport(host, 390, 844);
      await closeSettings();
      await run(pressId('room-settings-open'));
      await until(shown('#room-settings-content'), 'Mobile settings reopened');
      await assertPrivateSelected('mobile after reopen');
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
      await closeSettings();
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
      // Reopening loads the saved video before it seeks; under load that takes longer than a page step.
      await until(pausedAt('0:17'), 'Restored paused at 17s', 45000);
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
      assert.equal(largeRoom.permissions.viewer.editQueue, true);
      assert.equal(largeRoom.permissions.viewer.deleteRoom, false);
      await app.watch.roomState.queue.addBulk(
        largeRoom.roomId,
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
      const suggestedRoom = roomByName(suggestion);
      assert.ok(suggestedRoom, 'room saved under the suggested name');
      // Direct /room/<slug> entry with active media must clear bootstrap state on Leave and return to the lobby.
      await run('queueUI.add({id:"demo",title:"uburoom synchronization test",type:"movie"},{play:true})');
      await until(text('#title') + '==="uburoom synchronization test"', 'Direct-entry room loads media');
      const directRoom = await openPage(
        browser,
        config.publicUrl + '/room/' + encodeURIComponent(suggestedRoom.slug || suggestedRoom.roomId),
      );
      try {
        await browser.viewport(directRoom, 1360, 1000);
        await browser.activate(directRoom);
        await browser.until(
          directRoom,
          '!document.body.classList.contains("auth-pending") && ' +
            '!document.body.classList.contains("outside-room") && ' +
            '!document.body.classList.contains("idle-player") && ' +
            text('#options-title') +
            '===' +
            JSON.stringify(suggestion) +
            ' && ' +
            shown('#current-room') +
            ' && ' +
            hidden('#room-lobby') +
            ' && ' +
            shown('#close-room'),
          'Direct /room/<slug> entry hydrates into the active room',
        );
        await browser.evaluate(directRoom, pressId('close-room'));
        await browser.until(
          directRoom,
          'location.pathname==="/" && ' +
            'document.body.classList.contains("outside-room") && ' +
            'document.body.classList.contains("idle-player") && ' +
            shown('#room-lobby') +
            ' && ' +
            hidden('#current-room') +
            ' && ' +
            text('#options-title') +
            '==="Room" && ' +
            hidden('#room-share') +
            ' && ' +
            hidden('#room-schedule') +
            ' && ' +
            hidden('#close-room') +
            ' && !' +
            shown('.timeline-row') +
            ' && !' +
            shown('.playback-buttons'),
          'Leaving a directly entered room clears room UI, video controls, and returns to the lobby',
        );
        await browser.evaluate(directRoom, 'transport.interrupt(100);true');
        await browser.until(directRoom, '!transport.ready', 'Direct-entry lobby socket disconnects');
        await browser.until(
          directRoom,
          'transport.ready && !selected && location.pathname==="/" && ' +
            shown('#room-lobby') +
            ' && ' +
            hidden('#current-room'),
          'Reconnecting in the lobby after leaving does not re-enter the left room',
        );
      } finally {
        await browser.closePage?.(directRoom).catch(() => {});
      }
      console.log(
        name +
          ': named create, queue add/reorder/remove/next/history/clear, bulk show/Specials, shuffle, random configuration, autoplay toggle, real natural end/countdown/cancel/advance, viewer policy, host/creator transfer, private cohosts, Admin mode, close/reopen paused at 17s, delete, queue preset without deletion and rendered desktop/phone/theater passed',
      );
    } catch (error) {
      console.error(
        [...app.watch.rooms.values()].map(room => ({
          name: room.name,
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
            path.resolve(EVIDENCE, 'room-ui-' + name + '-' + (label === 'host' ? '' : 'guest-') + 'failure.png'),
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

function seedRoomSyncHistory(watch, room) {
  // Illustrative telemetry on the real modal and wire path, without waiting five minutes to fill its history.
  const { media, viewers, state, feedback, startAt, pauseAt } = room;
  const now = watch.clock.now();
  const alex = randomUUID();
  const tabs = [
    { name: 'Demo host', userId: randomUUID() },
    { name: 'Demo guest', userId: randomUUID() },
    { name: 'Alex', userId: alex },
    { name: 'Alex', userId: alex },
  ].map(tab => ({ ...tab, id: randomUUID(), streamVersion: randomUUID(), watchSocket: { readyState: 1 } }));
  try {
    room.media = null;
    recordRoomSyncTimeline(room, now);
    room.media = media;
    room.startAt = room.pauseAt = undefined;
    room.viewers = new Map(tabs.map(tab => [tab.id, tab]));
    for (let index = 0; index <= 56; index++) {
      const at = now - (56 - index) * 5000;
      room.state = { ...state, paused: index >= 16 && index <= 18 };
      if (index === 36) room.feedback = { action: 'media.seek.absolute' };
      if (index === 48) tabs[3].watchSocket = { readyState: 1 };
      if (index === 47) tabs[3].watchSocket.readyState = 3;
      for (const [number, tab] of tabs.entries()) {
        const stalled = number === 1 && index >= 25 && index <= 28;
        const recovery = number === 1 ? 255 * Math.exp(-((index - 30) ** 2) / 9) : 0;
        tab.syncQuality = {
          mediaVersion: room.mediaVersion,
          streamVersion: tab.streamVersion,
          updatedAt: at,
          measuredAt: at,
          status: room.state.paused ? 'paused' : stalled ? 'buffering' : 'playing',
          confidence: 'confident',
          health: { offsetMs: Math.round((number - 1.5) * 24 + Math.sin(index * 0.51 + number) * 32 + recovery) },
        };
      }
      sampleRoomSync(room, at);
    }
  } finally {
    Object.assign(room, { media, viewers, state, feedback, startAt, pauseAt });
  }
}

async function checkPlaybackReconnect(watch, id, run, until) {
  // The sync test video is on Libraries home only in Admin mode.
  await run(pressId('admin-mode'));
  await until(
    attr('#admin-mode', 'aria-checked') + '==="true" && ' + shown('.library-home-card[data-play=demo]'),
    'Sync test video in Admin mode',
  );
  await run(press('.library-home-card[data-play=demo]'));
  await until(text('#title') + '==="uburoom synchronization test"', 'Media load');
  const playingVideo = '!' + byId('video') + '.paused && decodedFrames()>0 && ' + byId('video') + '.currentTime>';
  await until(playingVideo + '0.25', 'First video frames play');
  const lastPosition = await run(byId('video') + '.currentTime');
  const [viewerId, viewer] = [...watch.rooms.get(id).viewers.entries()][0];
  const originalSocket = viewer.watchSocket;
  assert.ok(originalSocket, 'the playing tab is attached to a control socket');
  originalSocket.terminate();
  await waitFor(() => {
    const socket = watch.rooms.get(id)?.viewers.get(viewerId)?.watchSocket;
    return socket && socket !== originalSocket && socket.readyState === 1;
  }, 'The same tab rejoins on a new socket');
  await until('!reconnecting && ' + playingVideo + (lastPosition + 0.25), 'Video advances after reconnect');
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
