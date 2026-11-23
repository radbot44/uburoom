/* Queue shared-control contract in disposable Chrome/Firefox rooms.
 * Page globals still used, for want of an on-screen signal:
 *   me / state / pending - login, room durability, and idle command checks
 *   transport            - socket readiness and delayed autoplay write probe
 *   queueUI.add()        - queue items for the synchronization video
 */
'use strict';
const { EVIDENCE } = require('./lib/evidence');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { startFixtureServer, openPage, navigatePage, dom } = require('./lib/ui-fixture');

const { shown, isOpen } = dom;
const byId = id => 'document.getElementById(' + JSON.stringify(id) + ')';

async function main() {
  const browsers = (process.argv.find(arg => arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',');
  for (const name of browsers) {
    const { app, config } = await startFixtureServer();
    let browser, page;
    try {
      browser = await playbackBrowser(name);
      page = await openPage(browser, config.publicUrl + '/?demo=host');
      const run = expression => browser.evaluate(page, expression);
      const until = (expression, label) => browser.until(page, expression, label);
      fs.mkdirSync(EVIDENCE, { recursive: true });
      const shot = label =>
        browser.screenshot(page, path.resolve(EVIDENCE, 'queue-controls-' + name + '-after-' + label + '.png'));
      await browser.viewport(page, 1600, 1050);
      await browser.activate(page);
      await until('!document.body.classList.contains("auth-pending") && me?.durableRooms && transport?.ready', 'Login');
      assert.equal(
        await run(
          '!!window.OverlayScrollbarsGlobal?.OverlayScrollbars(document.body) && !window.OverlayScrollbarsGlobal.OverlayScrollbars(document.body).state().destroyed && document.querySelectorAll(".os-scrollbar").length >= 2',
        ),
        true,
        'OverlayScrollbars initializes on the page',
      );
      assert.equal(
        await run(
          byId('queue-auto-open') + '.disabled && ' + byId('queue-auto-open') + '.title.includes("Join a room")',
        ),
        true,
      );
      await shot('outside-room');
      await run(byId('create') + '.click();true');
      await until(isOpen('#room-dialog'), 'Create chooser');
      await run(byId('room-name') + '.value="Queue controls fixture";' + byId('room-create') + '.click();true');
      await until('state?.durable && !pending && !' + isOpen('#room-dialog'), 'Create room');
      await run('queueUI.add({mediaId:"demo",title:"Current video",duration:60})');
      await until('state?.mediaId==="demo"', 'Current item');
      await run('queueUI.add({mediaId:"demo",title:"Next video",duration:60})');
      await until('document.querySelector(".queue-entry")', 'Queued item');
      assert.deepEqual(
        await run(
          `(()=>{const ids=['queue-center','queue-auto-open'];return ids.map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return [r.height,s.borderTopWidth,s.borderRadius]})})()`,
        ),
        [
          [40, '0px', '10px'],
          [40, '0px', '10px'],
        ],
      );
      assert.deepEqual(
        await run(
          '(()=>{const r=document.getElementById("queue-auto-open").getBoundingClientRect();return [r.width,r.height]})()',
        ),
        [40, 40],
      );
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-heading")).fontSize'), '24px');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-heading")).gap'), '8px');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-quick-controls")).gap'), '8px');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-header")).rowGap'), '16px');
      assert.equal(await run('!document.querySelector(".queue-view-switch")'), true, 'Queue has one layout');
      const footerGeometry = await run(
        `(()=>{const room=getComputedStyle(document.getElementById("room-activity-btn"));return ["queue-clear-history","queue-shuffle","queue-clear-queue"].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return [id,e.className,r.height,s.borderRadius,s.backgroundColor,s.borderTopWidth,room.borderRadius,room.backgroundColor]})})()`,
      );
      assert.equal(
        footerGeometry.every(
          ([, classes, height, radius, background, border, roomRadius, roomBackground]) =>
            classes.includes('watch-control') &&
            height === 40 &&
            radius === roomRadius &&
            background === roomBackground &&
            border === '0px',
        ),
        true,
        'Queue footer shares Room button appearance and height, including disabled actions: ' +
          JSON.stringify(footerGeometry),
      );
      assert.equal(
        await run(
          'document.getElementById("queue-clear-history").disabled && document.getElementById("queue-shuffle").disabled && getComputedStyle(document.getElementById("queue-clear-history")).opacity==="1" && getComputedStyle(document.getElementById("queue-shuffle")).opacity==="1"',
        ),
        true,
        'Disabled footer buttons keep a visible background',
      );
      assert.equal(
        await run(
          'document.getElementById("queue-clear-history").title.includes("no playback history") && document.getElementById("queue-shuffle").title.includes("at least two")',
        ),
        true,
        'Disabled footer actions explain their prerequisites',
      );
      assert.deepEqual(
        await run(
          '(()=>{const r=document.getElementById("queue-shuffle").getBoundingClientRect();return [r.width,r.height]})()',
        ),
        [40, 40],
      );
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-footer-actions")).gap'), '8px');
      assert.equal(
        await run(
          'document.getElementById("room-settings-open").getBoundingClientRect().height===40 && getComputedStyle(document.getElementById("room-settings-open")).borderTopWidth==="0px"',
        ),
        true,
        'Room header remains unchanged',
      );
      assert.equal(
        await run(
          '["queue-autoplay","queue-auto-toggle"].every(id=>{const input=document.getElementById(id),pill=input.closest(".watch-switch-pill"),label=pill.querySelector(".watch-switch-pill-label");return input.getAttribute("role")==="switch" && Math.round(pill.getBoundingClientRect().height)===40 && label.getBoundingClientRect().width>0 && input.getBoundingClientRect().width===28})',
        ),
        true,
      );
      const autoplay = await run(byId('queue-autoplay') + '.checked');
      await run(`globalThis.originalQueueRequest=transport.request.bind(transport);globalThis.queueWrites=0;
        transport.request=async(message,options)=>{if(message?.type==='command'&&message?.command?.action==='media.autoplay.set'){queueWrites++;await new Promise(resolve=>setTimeout(resolve,700));}return originalQueueRequest(message,options)};
        document.getElementById("queue-autoplay").closest("label").click()`);
      assert.equal(
        await run(
          'document.getElementById("queue-autoplay").disabled && !document.getElementById("queue-auto-open").disabled && document.getElementById("queue-autoplay").closest(".watch-switch-pill").title==="Saving Auto-play…"',
        ),
        true,
      );
      await shot('processing');
      await run(byId('queue-autoplay') + '.click();true');
      await until(byId('queue-autoplay') + '.checked===' + String(!autoplay), 'Label switches Auto-play');
      await until('!' + byId('queue-autoplay') + '.disabled', 'Auto-play save');
      assert.equal(await run('queueWrites'), 1, 'Pending toggle ignores duplicate click');
      assert.equal(await run('state.autoplay.enabled'), !autoplay);
      await run('transport.request=originalQueueRequest');
      await run(byId('queue-auto-open') + '.click();true');
      await until(isOpen('#room-settings-dialog') + ' && ' + shown('#queue-auto-mode-group'), 'Queue settings');
      assert.equal(await run(byId('queue-auto-mode-group') + '.getBoundingClientRect().height'), 46);
      assert.equal(
        await run(byId('queue-auto-mode-group') + '.querySelector(".group-button").getBoundingClientRect().height'),
        40,
      );
      assert.equal(
        await run(
          '[...document.getElementById("queue-auto-mode-group").querySelectorAll("button")].filter(e=>e.tabIndex===0).length',
        ),
        1,
      );
      await run(byId('queue-auto-mode-group') + '.querySelector("button").focus()');
      await browser.key(page, 'ArrowRight');
      assert.equal(await run('document.activeElement.dataset.value'), 'continue');
      await browser.key(page, 'ArrowRight');
      assert.equal(await run('document.activeElement.dataset.value'), 'following');
      assert.equal(
        await run(byId('queue-auto-mode-group') + '.querySelector("[aria-pressed=true]").dataset.value'),
        'off',
      );
      await browser.key(page, ' ');
      assert.equal(
        await run(byId('queue-auto-mode-group') + '.querySelector("[aria-pressed=true]").dataset.value'),
        'following',
      );
      assert.equal(await run(byId('queue-auto-mode') + '.value'), 'following');
      assert.equal(
        await run(
          '[document.getElementById("room-autoplay"),document.getElementById("queue-auto-specials")].every(e=>e.getAttribute("role")==="switch")',
        ),
        true,
      );
      assert.equal(await run(byId('room-autoplay') + '.closest("label").getBoundingClientRect().height'), 44);
      await shot('desktop-settings');
      await run(byId('room-settings-dialog') + '.close()');
      await run(byId('queue-panel') + '.scrollIntoView({block:"start"})');
      await pause(1500);
      assert.equal(
        await run(
          'getComputedStyle(document.getElementById("room-column")).overflowY==="visible" && [...document.querySelectorAll(".os-scrollbar")].every(e=>e.classList.contains("os-scrollbar-auto-hide-hidden") && getComputedStyle(e).opacity==="0")',
        ),
        true,
        'Page overlay hides after scrolling settles; Room/Queue do not gain a nested scroller',
      );
      await shot('desktop');
      const hoverPoint = await run(
        '(()=>{const r=document.getElementById("queue-center").getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()',
      );
      const normalBackground = await run('getComputedStyle(document.getElementById("queue-center")).backgroundColor');
      await browser.move(page, ...hoverPoint);
      assert.notEqual(
        await run('getComputedStyle(document.getElementById("queue-center")).backgroundColor'),
        normalBackground,
      );
      await shot('hover');
      await browser.move(page, 0, 0);
      await browser.viewport(page, 390, 844);
      await run(byId('section-tab-queue') + '.click();true');
      await pause(1500);
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-heading")).fontSize'), '24px');
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'No phone overflow');
      await shot('narrow');
      await run('document.querySelector(".queue-footer").scrollIntoView({block:"end"})');
      await pause(1200);
      await shot('narrow-footer');
      await browser.viewport(page, 320, 844);
      await pause(1500);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'No 320px overflow');
      assert.equal(
        await run(
          '(()=>{const f=document.querySelector(".queue-footer").getBoundingClientRect();return ["queue-clear-history","queue-shuffle","queue-clear-queue"].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.height===40 && r.left>=f.left-1 && r.right<=f.right+1})})()',
        ),
        true,
        'Standard footer buttons fit inside the 320px Queue',
      );
      assert.equal(
        await run(
          'document.getElementById("queue-center").getBoundingClientRect().width===40 && getComputedStyle(document.getElementById("queue-center").querySelector(".watch-control-label")).display==="none"',
        ),
        true,
      );
      await shot('narrow-320');
      await run('document.querySelector(".queue-footer").scrollIntoView({block:"end"})');
      await pause(1200);
      await shot('narrow-320-footer');
      console.log(name + ': Queue controls and desktop/narrow captures passed');
    } finally {
      await browser?.close();
      await app.close();
    }
    await queueAcrossProviders(name);
  }
}

/**
 * A queued video opens in Media from its own server, whatever library is on screen: a local file playing
 * (Now Playing) opened over TV Shows, and a Plex episode opened over the local library. Each page takes its
 * own library as current and goes straight from empty to its details, with no title-only placeholder.
 */
async function queueAcrossProviders(name) {
  const { app, config } = await startFixtureServer({ localLibrary: true });
  let browser;
  try {
    browser = await playbackBrowser(name);
    const page = await openPage(browser, config.publicUrl + '/?demo=host');
    const run = async expression => {
      await pause(150);
      return browser.evaluate(page, expression);
    };
    const until = (expression, label, timeout) => browser.until(page, expression, label, timeout);
    const library = title =>
      '[...document.querySelectorAll(".library-choice")].find(b=>b.textContent.includes(' +
      JSON.stringify(title) +
      ')).click();true';
    const poster = title =>
      '[...document.querySelectorAll(".queue-art-link")].find(n=>n.title.includes(' + JSON.stringify(title) + '))';
    // Every frame from the click until the page settles: hidden, or the heading with its details line.
    const open = async title => {
      await run(
        '{window.__frames=[];const end=performance.now()+1500;(function f(){const o=document.querySelector(".library-overview");' +
          'window.__frames.push(o.hidden?"hidden":(o.querySelector("h3")?.textContent||"")+"|"+(o.querySelector(".library-meta")?.textContent||""));' +
          'if(performance.now()<end)requestAnimationFrame(f)})();' +
          poster(title) +
          '.click()};true',
      );
      await pause(1700);
      return {
        frames: [...new Set(JSON.parse(await run('JSON.stringify(window.__frames)')))],
        heading: await run('document.querySelector(".library-overview:not([hidden]) h3")?.textContent'),
        current: await run('document.querySelector(".library-choice[aria-current=page]")?.textContent'),
        error: await run('document.querySelector(".library-error")?.textContent || ""'),
      };
    };
    await browser.viewport(page, 1360, 1000);
    await until('!document.body.classList.contains("auth-pending") && transport?.ready', 'Login', 30000);
    // Signed in, a reload puts the libraries in the page's first paint, and the library renders Libraries home
    // while it is still starting: its cards (Plex and local) must survive that and stay once the page takes over.
    await navigatePage(browser, page, config.publicUrl + '/');
    // Right after the reload the page script may not have defined `transport` yet.
    await until(
      'typeof transport!=="undefined" && !document.body.classList.contains("auth-pending") && transport?.ready',
      'Login after reload',
      30000,
    );
    await until(
      'JSON.parse(document.getElementById("watch-bootstrap")?.textContent||"null")?.library?.status===200 && ' +
        'document.querySelectorAll(".library-home-card").length===3',
      'Library cards after a signed-in reload',
      30000,
    );
    await pause(1500);
    assert.equal(
      await run('document.querySelectorAll(".library-home-card").length'),
      3,
      'library cards stay once the page has started',
    );
    await run(byId('create') + '.click();true');
    await until(isOpen('#room-dialog'), 'Room chooser');
    await run(byId('room-name') + '.value="Across providers";' + byId('room-create') + '.click();true');
    // Selecting the new room resets Media to its Libraries home; browse only once that is done.
    await until(dom.text('#options-title') + '==="Across providers"', 'Room created', 30000);
    await until(shown('.library-home-card[data-section="film"]'), 'Local library card on Libraries home', 30000);
    await run(dom.q('.library-home-card[data-section="film"]') + '.click();true');
    await until(dom.q('.library-landing') + '.hidden', 'Local library opened from Libraries home', 30000);
    // The local file first, so it becomes Now Playing; then a Plex season.
    await until(shown('.library-tile .library-title'), 'Local library list', 45000);
    await run(dom.q('.library-tile .library-title') + '.click();true');
    await until(shown('.library-detail-actions .library-queue-add'), 'Local file details', 30000);
    await run(dom.q('.library-detail-actions .library-queue-add') + '.click();true');
    await until(poster('Local Film') + '!==undefined', 'Local file queued');
    await run(library('TV Shows'));
    await until(shown('.library-tile[data-item="100"] .library-title'), 'TV Shows');
    await run(dom.q('.library-tile[data-item="100"] .library-title') + '.click();true');
    await until(shown('.library-tile[data-item="111"] .library-title'), 'Seasons');
    await run(dom.q('.library-tile[data-item="111"] .library-title') + '.click();true');
    await until(shown('.library-detail-actions [data-queue]'), 'Season details');
    await run(dom.q('.library-detail-actions [data-queue]') + '.click();true');
    await until(isOpen('#queue-bulk-dialog'), 'Add season dialog');
    await run(byId('queue-bulk-submit') + '.click();true');
    await until(poster('Episode 1') + '!==undefined', 'Season queued');
    await run(
      'window.__queueEntry=document.querySelector("#queue-upcoming-list .queue-entry");window.__queueEntry?.focus();refreshState()',
    );
    assert.equal(
      await run('!!window.__queueEntry?.isConnected'),
      true,
      'queue entry keeps DOM identity across refresh',
    );
    assert.ok(
      await run(poster('Local Film') + '.closest("[class*=now-playing]")!==null'),
      'the local file is Now Playing',
    );

    await run(library('TV Shows'));
    await until(shown('.library-tile[data-item="100"]'), 'TV Shows on screen');
    const local = await open('Local Film');
    assert.equal(local.error, '', 'a local Now Playing opens over a Plex library');
    assert.equal(local.heading, 'Local Film');
    assert.equal(local.current, 'Film', 'its own library becomes current');
    assert.ok(
      local.frames.every(frame => frame === 'hidden' || !frame.endsWith('|')),
      'no placeholder frame',
    );

    await run(library('Film'));
    await until(shown('.library-tile .library-title'), 'Film on screen');
    const plex = await open('Episode 1');
    assert.equal(plex.error, '', 'a Plex episode opens over a local library');
    assert.equal(plex.heading, 'Episode 1');
    assert.equal(plex.current, 'TV Shows');
    assert.ok(
      plex.frames.every(frame => frame === 'hidden' || !frame.endsWith('|')),
      'no placeholder frame',
    );
    await run(byId('library-back') + '.click();true');
    await until(
      shown('.library-tile .library-title') +
        ' && ' +
        dom.text('.library-choice[aria-current=page]') +
        '.includes("Film")',
      'Back to Film',
    );
    console.log(name + ': queued videos open in Media across Plex and a local library');
  } finally {
    await browser?.close();
    await app.close();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
