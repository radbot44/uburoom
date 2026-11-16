/* Media shared controls and sticky layout in disposable Chrome/Firefox rooms. */
'use strict';
const { EVIDENCE } = require('./lib/evidence');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { accountFixture } = require('./account-fixture');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { openPage, act, dom } = require('./lib/ui-fixture');

// Media tools: browsing down tucks the tool rows up behind the sticky header (its bottom meets the header's)
// and scrolling up a little returns them below it. `top` is where the header sticks; `extra` adds conditions.
const mediaPair = (top, tucked, extra = 'true') =>
  '(()=>{const h=document.getElementById("library-header").getBoundingClientRect(),tools=document.querySelector(".library-tools"),t=tools.getBoundingClientRect();return Math.abs(h.top-(' +
  top +
  '))<2 && tools.classList.contains("library-tools-tucked")===' +
  tucked +
  ' && Math.abs(' +
  (tucked ? 't.bottom' : 't.top') +
  '-h.bottom)<2 && getComputedStyle(document.getElementById("library-panel")).getPropertyValue("--media-header-height").trim()===Math.round(h.height)+"px" && (' +
  extra +
  ')})()';
const TOOLS_SLIDE = 300; // .library-tools transitions transform over 0.2s

async function main() {
  for (const name of ['chrome', 'firefox']) {
    const fixture = accountFixture();
    const config = {
      cert: fs.readFileSync('certs/server-cert.pem'),
      key: fs.readFileSync('certs/server-key.pem'),
      publicUrl: 'https://localhost',
      ownerId: fixture.subjects.host,
      guildId: 'fixture',
      channels: ['fixture'],
      demo: true,
      unifiedAccounts: true,
      demoSubjects: fixture.subjects,
      plexUrl: 'http://plex-fixture.invalid:32400',
      plexToken: 'fixture-owner',
    };
    const plexFetch = async (input, options) => {
      const pathname = new URL(input).pathname;
      if (pathname === '/library/sections')
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Directory: [
                { key: '1', type: 'movie', title: 'Fixture Movies' },
                { key: '2', type: 'movie', title: 'Fixture Extras' },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      if (/^\/library\/sections\/[12]\/(genre|year)$/.test(pathname))
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Directory: [
                {
                  key: pathname.endsWith('/genre') ? '1' : '2026',
                  title: pathname.endsWith('/genre') ? 'Drama' : '2026',
                },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      if (['/library/sections/1/all', '/library/sections/2/all'].includes(pathname))
        return new Response(
          JSON.stringify({
            MediaContainer: {
              totalSize: 48,
              Metadata: Array.from({ length: 48 }, (_, i) => ({
                ratingKey: String(i + 1),
                type: 'movie',
                title: 'Media control ' + (i + 1),
                year: 2026,
                duration: 60000,
              })),
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      return fixture.fetch(input, options);
    };
    const app = createApp(config, { plexFetch, oauthFetch: fixture.discordFetch, plexDemo: fixture });
    app.access.connect({
      refresh: async () => true,
      isMember: () => true,
      voiceChannel: () => 'fixture',
      validVoiceChannel: () => true,
      options: () => ({ available: true }),
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    let browser;
    try {
      browser = await playbackBrowser(name);
      const page = await openPage(browser, config.publicUrl + '/?demo=host');
      const run = expression => browser.evaluate(page, expression);
      const until = (expression, label) => browser.until(page, expression, label);
      const shot = label =>
        browser.screenshot(page, path.resolve(EVIDENCE, 'media-controls-' + name + '-after-' + label + '.png'));
      await browser.viewport(page, 1440, 1000);
      await until('me?.durableRooms && transport?.ready', 'Login');
      await run('document.getElementById("create").click();document.getElementById("room-create").click()');
      await until('document.querySelector(".library-home-card")', 'Media home');
      await pause(300);
      await run('document.querySelector(".library-home-card").click()');
      await until('document.querySelector(".library-tile")', 'Media items');
      await run('document.getElementById("library-panel").scrollIntoView({block:"start"})');
      await pause(180);
      assert.equal(await run('getComputedStyle(document.getElementById("library-heading")).fontSize'), '24px');
      assert.equal(
        await run(
          '(()=>{const a=document.getElementById("media-symbol").getBoundingClientRect(),b=document.getElementById("library-heading").querySelector(".section-toggle>span:last-of-type").getBoundingClientRect();return Math.round(b.left-a.right)})()',
        ),
        8,
      );
      assert.equal(
        await run('document.getElementById("media-symbol").querySelector("svg").getBoundingClientRect().width'),
        24,
      );
      assert.equal(
        await run(
          '(()=>{const ids=["library-back","library-forward","library-home","library-direction","library-filters-toggle"];const elevated=getComputedStyle(document.getElementById("switch-room")).backgroundColor;return ids.every(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.height===40 && s.borderRadius==="10px" && s.borderTopWidth==="0px" && s.backgroundColor===elevated})})()',
        ),
        true,
        'Media actions use the Room control surface even while disabled',
      );
      assert.equal(
        await run(
          '["library-back","library-forward","library-home","library-direction"].every(id=>document.getElementById(id).getBoundingClientRect().width===40)',
        ),
        true,
      );
      assert.equal(
        await run(
          'document.getElementById("search").getBoundingClientRect().height===40 && document.getElementById("library-sort").getBoundingClientRect().height===40 && getComputedStyle(document.getElementById("search")).borderTopWidth==="1px" && getComputedStyle(document.getElementById("library-sort")).borderTopWidth==="1px"',
        ),
        true,
      );
      assert.equal(
        await run(
          'document.getElementById("library-forward").disabled && document.getElementById("library-forward").title.includes("No later")',
        ),
        true,
        'Disabled navigation explains its state',
      );
      assert.equal(
        await run(
          '(()=>{const b=document.querySelector(".library-scope-actions .watch-control"),r=b.getBoundingClientRect(),s=getComputedStyle(b);return r.height===40 && s.borderTopWidth==="0px" && b.querySelector("svg").getBoundingClientRect().width===24})()',
        ),
        true,
        'Header auto-queue uses shared controls',
      );
      await run('document.getElementById("search").focus()');
      assert.equal(
        await run('getComputedStyle(document.getElementById("search")).outlineWidth'),
        '3px',
        'Shared focus ring',
      );
      assert.equal(
        await run(
          'document.querySelector(".library-views").getBoundingClientRect().height===46 && [...document.querySelectorAll(".library-views .group-button")].every(b=>b.getBoundingClientRect().height===40) && document.querySelector(".library-choices").getBoundingClientRect().height===40',
        ),
        true,
        'Shared segmented view switch (40px buttons in a 3px inset) beside 40px library choices',
      );
      assert.equal(
        await run('document.querySelector(".library-views .group-button>svg").getBoundingClientRect().width'),
        24,
      );
      assert.equal(await run('document.querySelector(".library-views [aria-pressed=true]").dataset.view'), 'cards');
      assert.equal(
        await run('[...document.querySelectorAll(".library-views button")].filter(b=>b.tabIndex===0).length'),
        1,
      );
      await run('document.querySelector(".library-views [data-view=cards]").focus()');
      await browser.key(page, 'ArrowRight');
      assert.equal(await run('document.activeElement.dataset.view'), 'list');
      assert.equal(
        await run('document.querySelector(".library-views [aria-pressed=true]").dataset.view'),
        'cards',
        'Arrow focus does not select',
      );
      await browser.key(page, 'Enter');
      assert.equal(await run('document.querySelector(".library-views [aria-pressed=true]").dataset.view'), 'list');
      assert.equal(await run('getComputedStyle(document.activeElement).outlineWidth'), '3px', 'Shared focus ring');
      const libraryChoices = await run(
        '[...document.querySelectorAll(".library-choices .library-choice:not(.library-more)")].map(b=>[b.dataset.section,b.textContent])',
      );
      assert.equal(libraryChoices.length, 2, 'Fixture has two library choices: ' + JSON.stringify(libraryChoices));
      // Library buttons are navigation in the history group, each its own Tab stop (not a segmented selector).
      await run('document.querySelector(".library-choices button:first-child").focus()');
      await browser.key(page, 'Tab');
      assert.equal(await run('document.activeElement.dataset.section'), libraryChoices[1][0]);
      assert.equal(
        await run('document.querySelector(".library-choices [aria-current=page]").dataset.section'),
        libraryChoices[0][0],
        'Moving focus between libraries does not navigate',
      );
      await browser.key(page, 'Enter');
      await until(
        'document.querySelector(".library-choices button:nth-child(2)[aria-current=page]")',
        'Choose second library',
      );
      assert.equal(
        await run('document.activeElement.dataset.section'),
        libraryChoices[1][0],
        'Focused library choice survives rerender',
      );
      await run('document.querySelector(".library-choices button:first-child").click()');
      await until(
        'document.querySelector(".library-choices button:first-child[aria-current=page]")',
        'Return to first library',
      );
      await run(
        'document.querySelector(".library-views [data-view=cards]").click();document.getElementById("library-panel").scrollIntoView({block:"start"})',
      );
      await run('document.getElementById("media-collapse").click()');
      assert.equal(
        await run(
          'document.getElementById("library-panel").classList.contains("section-collapsed") && getComputedStyle(document.getElementById("library-content")).display==="none"',
        ),
        true,
        'Media collapse preserves panel behavior',
      );
      await run('document.getElementById("media-collapse").click()');
      assert.equal(
        await run('!document.getElementById("library-panel").classList.contains("section-collapsed")'),
        true,
      );
      await shot('desktop');
      await run('document.getElementById("theme-toggle").click()');
      assert.equal(
        await run(
          '(()=>{const probe=document.body.appendChild(document.createElement("i"));probe.style.background="var(--primary)";const primary=getComputedStyle(probe).backgroundColor;probe.remove();return getComputedStyle(document.querySelector(".library-views [aria-pressed=true]")).backgroundColor===primary})()',
        ),
        true,
        'Media selected view follows the active theme',
      );
      await shot('light');
      await run('document.getElementById("theme-toggle").click()');
      const pageScroll = 'document.getElementById("library-panel").scrollTop===0';
      await run('document.querySelector(".library-tile:last-child").scrollIntoView({block:"end"})');
      await pause(TOOLS_SLIDE);
      assert.equal(
        await run(mediaPair(0, true, pageScroll)),
        true,
        'Browsing down tucks the tools behind the sticky, measured header with page scrolling',
      );
      await shot('scrolled');
      await run('scrollBy(0,-80)');
      await pause(TOOLS_SLIDE);
      assert.equal(await run(mediaPair(0, false, pageScroll)), true, 'Scrolling up returns the tools below the header');
      await run(
        act.setTheater(true) + ';document.querySelector(".library-tile:last-child").scrollIntoView({block:"end"})',
      );
      await pause(TOOLS_SLIDE);
      assert.equal(await run(mediaPair(0, true, pageScroll)), true, 'Theater tucks the tools with page scroll');
      await run('scrollBy(0,-80)');
      await pause(TOOLS_SLIDE);
      assert.equal(
        await run(mediaPair(0, false, pageScroll)),
        true,
        'Theater retains the sticky Media pair and page scroll',
      );
      assert.equal(
        await run('document.getElementById("library-top").getBoundingClientRect().height===40'),
        true,
        'Back to top uses shared 40px control',
      );
      await shot('theater');
      await run('window.scrollTo(0,0)');
      await browser.click(page, 'fullscreen');
      await until('immersive && document.fullscreenElement', 'Fullscreen');
      await browser.click(page, 'drawer-open');
      await until('!drawer.hidden', 'Fullscreen Menu');
      const drawerTop = 'drawer.getBoundingClientRect().top';
      await run('drawer.scrollTop=1200');
      await pause(TOOLS_SLIDE);
      assert.equal(await run(mediaPair(drawerTop, true)), true, 'Menu tucks the tools behind its sticky header');
      await run('drawer.scrollTop-=80');
      await pause(TOOLS_SLIDE);
      assert.equal(
        await run(mediaPair(drawerTop, false)),
        true,
        'Menu keeps the measured sticky Media header and toolbar',
      );
      await shot('drawer');
      if (name === 'chrome') {
        await browser.viewport(page, 390, 844);
        const wrapped = 'h.height>40 && t.height>0';
        await run(act.selectSection('media') + ';drawer.scrollTop=0');
        await pause(TOOLS_SLIDE);
        await run('drawer.scrollTop=1200');
        await pause(TOOLS_SLIDE);
        assert.equal(await run(mediaPair(drawerTop, true, wrapped)), true, 'Phone Menu tucks the tools');
        await run('drawer.scrollTop-=80');
        await pause(TOOLS_SLIDE);
        assert.equal(
          await run(mediaPair(drawerTop, false, wrapped)),
          true,
          'Phone Menu follows the visible wrapped Media header height',
        );
        await shot('phone-drawer');
      }
      await browser.click(page, 'drawer-close');
      await until('drawer.hidden', 'Close Menu');
      await browser.click(page, 'fullscreen');
      await until('!immersive', 'Exit fullscreen');
      await run(act.setTheater(false));
      await browser.viewport(page, 390, 844);
      await run(
        'document.getElementById("section-tab-media").click();document.getElementById("library-panel").scrollIntoView({block:"start"})',
      );
      await pause(180);
      // Phone Media header: the heading on its own row, then one row of Back, Forward, Home and library
      // buttons that keep their names; Back to top joins the end of that row only once Media has scrolled.
      const headerRow =
        '(()=>{const top=e=>e.getBoundingClientRect().top,h=top(document.getElementById("library-heading")),n=top(document.querySelector(".library-navigation-history")),c=[...document.querySelectorAll(".library-choices .library-choice")].filter(b=>!b.hidden);return c.length>0 && n>h && c.map(top).every(y=>Math.abs(y-n)<2)})()';
      assert.equal(await run(dom.hidden('#library-top')), true, 'Back to top waits until Media has scrolled');
      assert.equal(await run(headerRow), true, 'Navigation and libraries share the row under the phone heading');
      assert.equal(
        await run(
          '[...document.querySelectorAll(".library-choices .library-choice")].filter(b=>!b.hidden).every(b=>getComputedStyle(b.querySelector(".watch-control-label")).display!=="none")',
        ),
        true,
        'Phone library buttons keep their names instead of shrinking to icons',
      );
      assert.equal(
        await run(
          'document.querySelector(".library-choices [aria-current=page]:not([hidden]), .library-choices .library-more[data-current]:not([hidden])")!==null && !document.getElementById("library-home").disabled',
        ),
        true,
        'Phone keeps the current library and Libraries home on the header row',
      );
      await run('scrollBy(0,120)');
      await pause(TOOLS_SLIDE);
      assert.equal(
        await run(
          'document.getElementById("library-panel").classList.contains("library-scrolled") && ' +
            dom.shown('#library-top') +
            ' && (()=>{const n=document.querySelector(".library-navigation-history").getBoundingClientRect(),t=document.getElementById("library-top").getBoundingClientRect();return Math.abs(n.top-t.top)<2 && t.width===40})()',
        ),
        true,
        'Back to top joins the phone navigation row once Media has scrolled',
      );
      assert.equal(
        await run(
          'document.getElementById("library-top").querySelector("svg").getAttribute("data-tabler-icon")==="arrow-bar-to-up" && getComputedStyle(document.getElementById("library-top").querySelector(".watch-control-label")).display==="none" && document.getElementById("library-top").getAttribute("aria-label")==="Back to top"',
        ),
        true,
        'Back to top has the requested icon and accessible compact label',
      );
      await run('document.getElementById("library-panel").scrollIntoView({block:"start"})');
      await pause(TOOLS_SLIDE);
      assert.equal(
        await run('getComputedStyle(document.querySelector(".library-views .group-button span")).display'),
        'none',
      );
      assert.equal(
        await run(
          'getComputedStyle(document.querySelector("#library-filters-toggle .filter-label")).display==="none" && getComputedStyle(document.querySelector(".library-scope-actions .library-auto-queue-label")).display==="none"',
        ),
        true,
        'Narrow toolbar labels hide with accessible button names',
      );
      assert.equal(
        await run(
          'document.querySelector(".library-views .group-button").getBoundingClientRect().width>=40 && document.documentElement.scrollWidth<=innerWidth+1',
        ),
        true,
      );
      assert.equal(
        await run(
          '(()=>{const middle=e=>{const r=e.getBoundingClientRect();return r.top+r.height/2};return Math.abs(middle(document.getElementById("library-sort"))-middle(document.querySelector(".library-views")))<2})()',
        ),
        true,
        'Phone view selector shares the sort row',
      );
      await run('document.getElementById("library-filters-toggle").click()');
      assert.equal(
        await run(
          '(()=>{const s=[...document.querySelectorAll(".library-filters select")],status=document.querySelector(".library-filters>.hint");return s.length===2 && Math.abs(s[0].getBoundingClientRect().top-s[1].getBoundingClientRect().top)<2 && s.every(x=>x.getBoundingClientRect().width>70) && (getComputedStyle(status).display==="none" || status.getBoundingClientRect().top>=s[0].getBoundingClientRect().bottom)})()',
        ),
        true,
        'Usable Genre and Year dropdowns share one row with status below',
      );
      await shot('phone-filters');
      await run('document.getElementById("library-filters-toggle").click()');
      await shot('phone');
      if (name === 'chrome') {
        await browser.mobileViewport(page, 390, 844);
        await pause(180);
        assert.equal(await run('matchMedia("(pointer: coarse)").matches'), true, 'Chrome fixture emulates touch input');
        assert.equal(
          await run(
            '(()=>{const b=document.querySelector("[data-view=cards] .library-tile .library-play"),a=b.closest(".library-art"),r=b.getBoundingClientRect(),ar=a.getBoundingClientRect(),s=getComputedStyle(b);return s.opacity==="0" && s.pointerEvents==="none" && Math.abs(r.left+r.width/2-ar.left-ar.width/2)<2 && Math.abs(r.top+r.height/2-ar.top-ar.height/2)<2})()',
          ),
          true,
          'Touch Cards play affordance stays hidden and centered until revealed',
        );
        await shot('phone-touch');
        await run('document.querySelector(".library-tile .library-open").click()');
        await until(
          '!document.querySelector(".library-overview").hidden && !!document.querySelector(".library-detail-actions .library-play-now")',
          'Cards poster opens Play details',
        );
        await shot('phone-touch-detail');
        await run('document.getElementById("library-back").click()');
        await until(
          '!!document.querySelector(".library-tile") && document.querySelector(".library-overview").hidden',
          'Return to Cards',
        );
      }
      await browser.viewport(page, 320, 844);
      await pause(180);
      assert.equal(await run('document.documentElement.scrollWidth<=innerWidth+1'), true, '320px Media fits');
      await shot('narrow');
      console.log(name + ': Media controls and sticky desktop/phone checks passed');
    } finally {
      await browser?.close();
      await new Promise(resolve => app.server.close(resolve));
    }
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
