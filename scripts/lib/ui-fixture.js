/* Isolated fixture server and on-screen page helpers for rendered UI checks. No .env or real providers. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../../server/app');
const { accountFixture } = require('../account-fixture');

const root = path.resolve(__dirname, '../..');

// A small fake Plex library: two sections, a show with Specials, two movies and a collection.
function fixtureLibrary() {
  const show = { ratingKey: '100', type: 'show', title: 'Queue fixture show', childCount: 2, leafCount: 3 };
  const seasons = [0, 1].map(index => ({
    ratingKey: String(110 + index),
    type: 'season',
    title: index ? 'Season 1' : 'Specials',
    index,
    parentRatingKey: '100',
    leafCount: index ? 2 : 1,
  }));
  const episodes = [0, 1, 2].map(index => ({
    ratingKey: String(120 + index),
    type: 'episode',
    title: index ? 'Episode ' + index : 'Special episode',
    index: index || 1,
    parentIndex: index ? 1 : 0,
    parentRatingKey: index ? '111' : '110',
    grandparentRatingKey: '100',
    grandparentTitle: show.title,
    duration: 60000,
  }));
  const movies = [1, 2].map(index => ({
    ratingKey: String(index),
    type: 'movie',
    title: 'Queue fixture movie ' + index,
    duration: 60000,
  }));
  const collection = { ratingKey: '200', type: 'collection', title: 'Queue fixture collection', childCount: 2 };
  return { show, seasons, episodes, movies, collection };
}

/**
 * Start an isolated demo server on 127.0.0.1 with fixture accounts and library.
 * Uses the worktree's development certificate; never reads private configuration.
 */
async function startFixtureServer() {
  const fixture = accountFixture();
  const subjects = { host: '100000000000000001', guest: '100000000000000002', guest2: '100000000000000003' };
  const config = {
    cert: fs.readFileSync(path.join(root, 'certs/server-cert.pem')),
    key: fs.readFileSync(path.join(root, 'certs/server-key.pem')),
    publicUrl: 'https://localhost',
    ownerId: subjects.host,
    guildId: 'fixture',
    channels: ['fixture'],
    demo: true,
    unifiedAccounts: true,
    demoSubjects: subjects,
    plexUrl: 'http://plex-fixture.invalid:32400',
    plexToken: 'fixture-owner',
    roomAdministrators: { discord: [subjects.guest2], plex: [], discordRoles: [] },
    roomLimits: { maxQueue: 120 },
  };
  const { show, seasons, episodes, movies, collection } = fixtureLibrary();
  const plexFetch = async (input, options) => {
    const url = new URL(input),
      p = url.pathname;
    let rows;
    if (p === '/library/sections')
      return new Response(
        JSON.stringify({
          MediaContainer: {
            Directory: [
              { key: '1', type: 'movie', title: 'Movies' },
              { key: '2', type: 'show', title: 'TV Shows' },
            ],
          },
        }),
      );
    if (p === '/library/sections/1/all') rows = movies;
    else if (p === '/library/sections/2/all') rows = [show];
    else if (p.endsWith('/collections')) rows = [collection];
    else if (p === '/library/collections/200/children') rows = movies;
    else if (p === '/library/metadata/100/children') rows = seasons;
    else if (p === '/library/metadata/100/allLeaves') rows = episodes;
    else if (p === '/library/metadata/110/children') rows = episodes.slice(0, 1);
    else if (p === '/library/metadata/111/children') rows = episodes.slice(1);
    else if (/^\/library\/metadata\/\d+(?:,\d+)*$/.test(p)) {
      const ids = new Set(p.split('/').pop().split(','));
      rows = [show, ...seasons, ...episodes, ...movies, collection].filter(item => ids.has(item.ratingKey));
      if (!rows.length) return fixture.fetch(input, options);
    } else return fixture.fetch(input, options);
    const start = Number(url.searchParams.get('X-Plex-Container-Start') || 0),
      size = Number(url.searchParams.get('X-Plex-Container-Size') || 120);
    return new Response(
      JSON.stringify({ MediaContainer: { Metadata: rows.slice(start, start + size), totalSize: rows.length } }),
    );
  };
  const app = createApp(config, { plexFetch, oauthFetch: fixture.discordFetch, plexDemo: fixture });
  app.access.connect({
    isMember: () => true,
    refresh: async () => true,
    voiceChannel: () => 'fixture',
    validVoiceChannel: () => true,
    options: () => ({ available: true }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.publicUrl = 'https://localhost:' + app.server.address().port;
  return { app, config, subjects, fixture };
}

/**
 * Open a page and navigate it with location.href, which follows server redirects
 * (/watch now redirects to /). Waits for a loaded document on the fixture origin.
 */
async function openPage(browser, url) {
  const page = await browser.page('about:blank');
  await navigatePage(browser, page, url);
  return page;
}
async function navigatePage(browser, page, url) {
  const origin = new URL(url).origin;
  await browser.evaluate(page, 'location.href=' + JSON.stringify(url) + ';true');
  await browser.until(
    page,
    'location.origin===' + JSON.stringify(origin) + ' && document.readyState==="complete"',
    'Page navigation to ' + new URL(url).pathname,
    30000,
  );
}

// Page-side expressions about what is on screen. Each returns a boolean.
const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const shown = selector =>
  '(()=>{const e=' +
  q(selector) +
  ';return !!e&&!e.closest("[hidden]")&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=="hidden";})()';
const hiddenEl = selector => '!' + shown(selector);
const text = selector => '(' + q(selector) + '?.textContent||"")';
const hasText = (selector, value) => text(selector) + '.includes(' + JSON.stringify(value) + ')';
const enabled = selector => '(()=>{const e=' + q(selector) + ';return !!e&&!e.disabled;})()';
const attr = (selector, name) => '(' + q(selector) + '?.getAttribute(' + JSON.stringify(name) + ')??null)';
const isOpen = selector => '!!' + q(selector) + '?.open';
const count = selector => 'document.querySelectorAll(' + JSON.stringify(selector) + ').length';

module.exports = {
  fixtureLibrary,
  startFixtureServer,
  openPage,
  navigatePage,
  dom: { q, shown, hidden: hiddenEl, text, hasText, enabled, attr, isOpen, count },
};
