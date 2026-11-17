/* Library UX against synthetic Plex data in Chrome and Firefox (--browsers=chrome,firefox); no private media or accounts. */
'use strict';
const { EVIDENCE } = require('./lib/evidence');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createApp } = require('../server/app'),
  { accountFixture } = require('./account-fixture'),
  { act } = require('./lib/ui-fixture'),
  { playbackBrowser } = require('./lib/playback-browser');
const root = path.resolve(__dirname, '..'),
  pause = ms => new Promise(r => setTimeout(r, ms));
const TOOLS_SLIDE = 300; // .library-tools transitions transform over 0.2s
async function main(name) {
  // The isolated account demo: fixture Discord and Plex accounts, never private configuration.
  const fixture = accountFixture();
  const config = {
    cert: fs.readFileSync(path.join(root, 'certs/server-cert.pem')),
    key: fs.readFileSync(path.join(root, 'certs/server-key.pem')),
    publicUrl: 'https://localhost:6768',
    ownerId: fixture.subjects.host,
    guildId: 'demo-guild',
    channels: ['demo-commands'],
    demo: true,
    unifiedAccounts: true,
    demoSubjects: fixture.subjects,
    plexUrl: 'http://127.0.0.1:32400',
    plexToken: 'synthetic-fixture-only',
  };
  let failNext = false;
  let shelfReads = 0;
  let newShelfItem = false;
  const artworkReads = [];
  const movies = Array.from({ length: 250 }, (_, i) => ({
    ratingKey: String(i + 1),
    type: 'movie',
    title:
      i < 2
        ? 'A Sample Movie'
        : i === 2
          ? 'A Movie with a Longer Title to Check Wrapping'
          : i === 249
            ? 'Needle beyond the first two hundred'
            : 'Sample Movie ' + String(i + 1).padStart(3, '0'),
    year: i % 2 ? 2023 : 2020,
    duration: 7200000,
    editionTitle: i === 0 ? 'Theatrical Cut' : i === 1 ? 'The Final Cut' : undefined,
    Genre: [{ id: 5, tag: 'Sci-Fi' }],
    contentRating: 'PG-13',
    summary: 'A synthetic movie synopsis for checking the library design.',
    thumb: `/library/metadata/${i + 1}/thumb/123`,
    Director: [{ tag: 'Sample director' }],
    Role: [{ tag: 'Sample actor' }],
  }));
  const show = {
    ratingKey: '10000',
    type: 'show',
    title: 'A Sample Show',
    year: 2020,
    childCount: 2,
    thumb: '/library/metadata/10000/thumb/123',
    summary: 'A synthetic television show.',
  };
  const seasons = [1, 2].map(i => ({
    ratingKey: String(10000 + i),
    type: 'season',
    title: 'Season ' + i,
    index: i,
    leafCount: 2,
    parentRatingKey: '10000',
    parentTitle: show.title,
    thumb: `/library/metadata/${10000 + i}/thumb/123`,
  }));
  const episodes = [1, 2].map(i => ({
    ratingKey: String(10100 + i),
    type: 'episode',
    title: 'Episode title ' + i,
    index: i,
    parentIndex: 1,
    parentRatingKey: '10001',
    parentTitle: 'Season 1',
    grandparentRatingKey: '10000',
    grandparentTitle: show.title,
    year: 2020,
    duration: 1800000,
    summary: 'Episode description, kept short enough to scan in a compact row.',
    thumb: `/library/metadata/${10100 + i}/thumb/123`,
    grandparentThumb: show.thumb,
  }));
  for (const episode of episodes)
    Object.assign(episode, {
      contentRating: 'TV-14',
      Genre: [
        { id: 5, tag: 'Comedy' },
        { id: 6, tag: 'Drama' },
      ],
      Director: [{ tag: 'Sample director' }],
      Role: [
        'Sample actor one',
        'Sample actor two',
        'Sample actor three',
        'Sample actor four',
        'Sample actor five',
        'Sample actor six',
        'Sample actor seven',
        'Sample actor eight',
      ].map(tag => ({ tag })),
      rating: 7.9,
      ratingImage: 'themoviedb://image',
      Media: [
        {
          videoResolution: '1080',
          videoCodec: 'h264',
          bitrate: 8000,
          audioCodec: 'aac',
          audioChannels: 2,
          container: 'mkv',
        },
      ],
    });
  const collection = {
    ratingKey: '9000',
    type: 'collection',
    title: 'Sample collection',
    childCount: 250,
    thumb: '/library/collections/9000/thumb/123',
    summary: 'A collection with a defined order.',
  };
  const solo = {
    ...show,
    ratingKey: '11000',
    title: 'B Single Season Show',
    childCount: 1,
    thumb: '/library/metadata/11000/thumb/123',
  };
  const soloSeason = {
    ...seasons[0],
    ratingKey: '11001',
    parentRatingKey: '11000',
    parentTitle: solo.title,
    thumb: '/library/metadata/11001/thumb/123',
  };
  const soloEpisodes = episodes.map((x, i) => ({
    ...x,
    ratingKey: String(11101 + i),
    grandparentRatingKey: '11000',
    grandparentTitle: solo.title,
    parentRatingKey: '11001',
    grandparentThumb: solo.thumb,
  }));
  const all = [...movies, show, solo, ...seasons, ...episodes, soloSeason, ...soloEpisodes, collection];
  // The fake Plex server, injected the supported way: the Plex client wraps it like real fetch.
  const plexFetch = async (input, options) => {
    const url = new URL(input),
      p = url.pathname,
      query = url.searchParams;
    // plex.tv sign-in and account checks belong to the account fixture; the library is this server.
    if (url.origin !== new URL(config.plexUrl).origin) return fixture.fetch(input, options);
    // The server root names the machine; the server pins it as this provider's identity.
    if (p === '/') return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'library-fixture' } }));
    if (failNext && p.endsWith('/all')) {
      failNext = false;
      return new Response('fixture failure', { status: 503 });
    }
    if (p === '/photo/:/transcode') {
      artworkReads.push(query.get('url'));
      return new Response(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
        { headers: { 'Content-Type': 'image/png' } },
      );
    }
    let data;
    if (p === '/library/sections')
      data = {
        Directory: [
          { key: '1', type: 'movie', title: 'Movies' },
          { key: '2', type: 'show', title: 'TV Shows' },
        ],
      };
    else if (p === '/library/recentlyAdded') {
      data = { Metadata: movies.slice(0, 20).map((item, index) => ({ ...item, addedAt: 1700000000 - index })) };
    } else if (p === '/library/onDeck')
      data = { Metadata: movies.slice(0, 8).map(item => ({ ...item, viewOffset: 1200000 })) };
    else if (p.endsWith('/genre')) data = { Directory: [{ key: '5', title: 'Sci-Fi' }] };
    else if (p.endsWith('/year'))
      data = {
        Directory: [
          { key: '2020', title: '2020' },
          { key: '2023', title: '2023' },
        ],
      };
    else if (p.endsWith('/collections')) data = { Metadata: [collection], totalSize: 1 };
    else if (p.endsWith('/all') || p.endsWith('/children')) {
      let rows =
        p === '/library/collections/9000/children'
          ? [...movies].reverse()
          : p === '/library/metadata/10000/children'
            ? seasons
            : p === '/library/metadata/10001/children' || p === '/library/metadata/10002/children'
              ? episodes
              : p === '/library/metadata/11000/children'
                ? [soloSeason]
                : p === '/library/metadata/11001/children'
                  ? soloEpisodes
                  : p.includes('/sections/2/')
                    ? [show, solo]
                    : movies;
      if (query.get('title')) rows = rows.filter(x => x.title.toLowerCase().includes(query.get('title').toLowerCase()));
      if (query.get('year')) rows = rows.filter(x => String(x.year) === query.get('year'));
      if (query.get('sort')) {
        const [field, order] = query.get('sort').split(':');
        rows = [...rows].sort((a, b) => {
          const result = field === 'titleSort' ? a.title.localeCompare(b.title) : (a[field] || 0) - (b[field] || 0);
          return order === 'desc' ? -result : result;
        });
      }
      const start = Number(query.get('X-Plex-Container-Start') || 0),
        size = Number(query.get('X-Plex-Container-Size') || 120);
      data = { Metadata: rows.slice(start, start + size), totalSize: rows.length };
    } else {
      const ids = p.split('/').at(-1).split(',');
      data = { Metadata: all.filter(x => ids.includes(x.ratingKey)) };
    }
    return new Response(JSON.stringify({ MediaContainer: data }));
  };
  const app = createApp(config, { plexFetch, oauthFetch: fixture.discordFetch, plexDemo: fixture });
  const readShelves = app.watch.providers.shelves.bind(app.watch.providers);
  app.watch.providers.shelves = async (...args) => {
    shelfReads++;
    const data = await readShelves(...args);
    if (newShelfItem) {
      // Two servers can use the same local item ID; retain both as distinct titles.
      data.recentlyAdded = [
        { ...data.recentlyAdded[0], serverId: 'second-fixture' },
        ...data.recentlyAdded.slice(0, 19),
      ];
    }
    return data;
  };
  app.watch.providers.primary.root.prepare = async id => ({
    ...app.watch.demoMedia,
    id,
    title: all.find(x => x.ratingKey === id)?.title || 'Fixture',
    subtitle: all.find(x => x.ratingKey === id)?.editionTitle || '',
    kind: 'demo',
  });
  app.access.connect({
    refresh: async () => true,
    isMember: () => true,
    voiceChannel: () => 'call',
    validVoiceChannel: () => true,
    options: () => ({ available: true }),
  });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  config.publicUrl = `https://localhost:${app.server.address().port}`;
  let browser;
  try {
    browser = await playbackBrowser(name);
    const evaluate = (page, expression) => browser.evaluate(page, expression);
    const until = (page, expression, label) => browser.until(page, expression, label, 15000);
    const context = await browser.page(config.publicUrl + '/?demo=host');
    await browser.viewport(context, 1360, 1200);
    // Creating a room needs the room connection, not just the sign-in.
    await until(context, '!!me && transport?.ready', 'demo login and room connection');
    await evaluate(context, 'document.getElementById("create").click()');
    await until(context, 'document.getElementById("room-dialog").open', 'room chooser');
    await evaluate(context, 'document.getElementById("room-create").click()');
    await until(context, 'document.querySelectorAll(".library-home-card").length===5', 'Libraries home');
    // Phone layouts show one section at a time (Room first in a saved room); these checks browse Media.
    await evaluate(context, act.selectSection('media'));
    await until(
      context,
      'document.querySelectorAll(".library-shelf-row.poster .library-tile").length===20',
      'Recently added',
    );
    await evaluate(
      context,
      `(()=>{
      const row=document.querySelector('.library-shelf-row.poster');
      row.scrollLeft=300;
      const focus=row.querySelectorAll('.library-title')[3];
      focus.focus({preventScroll:true});
      window.shelfCheck={row,focus,left:row.scrollLeft,tile:row.children[3],identities:0};
      new MutationObserver(()=>window.shelfCheck.identities++).observe(document.getElementById('identity'),{childList:true});
    })()`,
    );
    app.watch.changed(undefined, { lobby: true });
    await until(context, 'window.shelfCheck.identities>0', 'Account refresh');
    const stableShelf = `(()=>{const s=window.shelfCheck;return s.row===document.querySelector('.library-shelf-row.poster') && s.tile===s.row.children[3] && Math.abs(s.row.scrollLeft-s.left)<1 && document.activeElement===s.focus})()`;
    assert.equal(await evaluate(context, stableShelf), true, 'Account refresh preserves shelf nodes, focus and scroll');
    const reads = shelfReads;
    await evaluate(context, 'window.shelfClock=Date.now;Date.now=()=>window.shelfClock()+61000');
    app.watch.changed(undefined, { lobby: true });
    await until(context, 'window.shelfCheck.identities>1', 'Stale shelf refresh');
    for (let i = 0; i < 100 && shelfReads === reads; i++) await pause(20);
    assert.ok(shelfReads > reads, 'Stale shelves fetch fresh data');
    await pause(200);
    await evaluate(context, 'Date.now=window.shelfClock');
    assert.equal(
      await evaluate(context, stableShelf),
      true,
      'Unchanged fetched data preserves tiles, focus and scroll',
    );
    await evaluate(
      context,
      `window.shelfCheck.anchorLeft=window.shelfCheck.tile.getBoundingClientRect().left;Date.now=()=>window.shelfClock()+122000`,
    );
    newShelfItem = true;
    app.watch.changed(undefined, { lobby: true });
    await until(
      context,
      'window.shelfCheck.row.children[0].dataset.item===window.shelfCheck.row.children[1].dataset.item',
      'New title from another server',
    );
    await evaluate(context, 'Date.now=window.shelfClock');
    assert.equal(
      await evaluate(
        context,
        `(()=>{const s=window.shelfCheck;return s.row.children.length===20 && s.row.children[4]===s.tile && document.activeElement===s.focus && Math.abs(s.tile.getBoundingClientRect().left-s.anchorLeft)<1})()`,
      ),
      true,
      'New arrivals preserve the visible title, unchanged focus and separate server identities',
    );
    await evaluate(
      context,
      `(()=>{
      const row=document.querySelector('.library-shelf-row.poster');
      row.scrollLeft=0;
      row.parentNode.querySelector('.next').click();
    })()`,
    );
    await until(context, 'document.querySelector(".library-shelf-row.poster").scrollLeft>300', 'Shelf right arrow');
    await evaluate(context, 'document.querySelector(".library-shelf-row.poster").scrollLeft=100000');
    await until(
      context,
      'document.querySelector(".library-shelf-row.poster").parentNode.dataset.right==="false"',
      'Shelf end',
    );
    await evaluate(
      context,
      'document.querySelector(".library-shelf-row.poster").parentNode.querySelector(".previous").click()',
    );
    await until(
      context,
      'document.querySelector(".library-shelf-row.poster").parentNode.dataset.right==="true"',
      'Shelf left arrow',
    );
    await evaluate(context, 'document.querySelector(".library-shelf-row.poster").focus()');
    await browser.key(context, 'Home');
    await until(context, 'document.querySelector(".library-shelf-row.poster").scrollLeft===0', 'Shelf keyboard Home');
    await browser.key(context, 'ArrowRight');
    await until(context, 'document.querySelector(".library-shelf-row.poster").scrollLeft>100', 'Shelf keyboard Right');
    for (const [theme, width] of [
      ['dark', 1360],
      ['light', 1360],
      ['dark', 390],
      ['light', 390],
      ['dark', 680],
    ]) {
      await browser.viewport(context, width, 1200);
      await evaluate(
        context,
        `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('library-panel').scrollIntoView({block:'start'});document.querySelector('.library-shelf-row.poster').scrollLeft=0`,
      );
      await pause(100);
      await browser.screenshot(context, path.join(EVIDENCE, name + '-home-shelves-' + theme + '-' + width + '.png'));
      assert.equal(
        await evaluate(
          context,
          `(()=>{const row=document.querySelector('.library-shelf-row.poster');return getComputedStyle(row).scrollbarWidth==='none' && document.documentElement.scrollWidth<=innerWidth+1})()`,
        ),
        true,
        'Shelves hide scrollbars and fit the viewport',
      );
    }
    await browser.viewport(context, 1360, 1200);
    await evaluate(context, "document.documentElement.dataset.theme='dark'");
    assert.equal(await evaluate(context, '!!document.getElementById("library-select")'), false);
    await until(context, 'location.pathname.startsWith("/room/")', 'room address');
    const roomPath = await evaluate(context, 'location.pathname');
    await evaluate(context, 'history.back()');
    await pause(200);
    assert.equal(
      await evaluate(
        context,
        'location.pathname===' +
          JSON.stringify(roomPath) +
          ' && !!selected && !document.querySelector(".library-landing").hidden',
      ),
      true,
      'Browser Back at Home stays on the room page',
    );
    await evaluate(context, 'document.querySelector(".library-home-card[data-tab=library]").click()');
    await until(context, 'document.querySelectorAll(".library-tile").length===48', 'first library page');
    assert.equal(
      await evaluate(context, 'document.querySelectorAll(".library-shelf-row .library-tile").length'),
      0,
      'Leaving Home releases its tiles',
    );
    await evaluate(context, 'history.back()');
    await until(context, '!document.querySelector(".library-landing").hidden', 'browser Back to Home');
    await evaluate(context, 'history.forward()');
    await until(
      context,
      '!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile").length===48',
      'browser Forward to library',
    );
    await evaluate(context, 'document.getElementById("library-back").click()');
    await until(context, '!document.querySelector(".library-landing").hidden', 'arrow Back to Home');
    await evaluate(context, 'document.getElementById("library-forward").click()');
    await until(context, '!document.querySelector(".library").hidden', 'arrow Forward to library');
    await evaluate(context, 'document.getElementById("library-panel").scrollIntoView()');
    await until(context, 'document.querySelector(".library-art.loaded")', 'authenticated blob artwork');
    assert.equal(
      await evaluate(
        context,
        'document.querySelector("[data-item=\\\"1\\\"] .library-meta").textContent.includes("Theatrical Cut")',
      ),
      true,
    );
    failNext = true;
    await evaluate(context, 'document.querySelector(".library-sentinel").scrollIntoView({block:"end"})');
    await until(
      context,
      'document.getElementById("library-note").classList.contains("library-error")',
      'next-page error',
    );
    await pause(400);
    assert.equal(
      await evaluate(context, 'document.querySelectorAll(".library-tile").length'),
      48,
      'Failed page keeps existing items and waits for Retry',
    );
    await evaluate(context, 'document.querySelector(".library-footer button").click()');
    await until(
      context,
      'document.querySelectorAll(".library-tile").length>=96',
      'automatically load next page after Retry',
    );
    await evaluate(context, 'search.value="Needle";search.dispatchEvent(new Event("input"))');
    await until(
      context,
      'document.querySelectorAll(".library-tile").length===1 && document.querySelector(".library-title").textContent.includes("Needle")',
      'search beyond 200',
    );
    await evaluate(context, 'document.querySelector(".library-open").click()');
    await until(context, 'document.querySelector(".library-summary")', 'title details');
    await evaluate(context, 'history.back()');
    await until(context, 'document.querySelector(".library").hidden===false', 'back to the search results');
    assert.equal(await evaluate(context, 'search.value'), 'Needle');
    assert.equal(await evaluate(context, 'document.querySelectorAll(".library-tile").length'), 1);
    await evaluate(context, 'search.value="";search.dispatchEvent(new Event("input"))');
    await until(context, 'document.querySelectorAll(".library-tile").length===48', 'restore library');
    for (let i = 0; i < 5 && (await evaluate(context, 'document.querySelectorAll(".library-tile").length<250')); i++) {
      const before = await evaluate(context, 'document.querySelectorAll(".library-tile").length');
      await evaluate(context, 'document.querySelector(".library-sentinel").scrollIntoView({block:"end"})');
      await until(context, `document.querySelectorAll('.library-tile').length>${before}`, 'infinite scroll advances');
    }
    assert.equal(await evaluate(context, 'document.querySelectorAll(".library-tile").length'), 250);
    assert.equal(
      await evaluate(context, 'new Set([...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item)).size'),
      250,
    );
    await evaluate(
      context,
      `globalThis.fixtureAnchor=()=>{const top=document.querySelector('.library-tools').getBoundingClientRect().bottom;const tile=[...document.querySelectorAll('.library-tile')].find(n=>n.getBoundingClientRect().bottom>top);return {id:tile.dataset.item,offset:tile.getBoundingClientRect().top-top,edge:top};};const tile=document.querySelectorAll('.library-tile')[220];document.getElementById('library-panel').scrollBy(0,tile.getBoundingClientRect().top-document.querySelector('.library-tools').getBoundingClientRect().bottom-12);`,
    );
    // The tool rows may tuck behind the header as the view restores its scroll position, so wait for them
    // to settle and keep the item where it was on screen, measured from the edge it was anchored below.
    await pause(TOOLS_SLIDE);
    for (const view of ['list', 'posters', 'cards']) {
      const anchor = JSON.parse(await evaluate(context, 'JSON.stringify(fixtureAnchor())'));
      await evaluate(context, `document.querySelector('.library-views [data-view="${view}"]').click()`);
      await pause(TOOLS_SLIDE);
      const offset = await evaluate(
        context,
        `document.querySelector('[data-item="${anchor.id}"]').getBoundingClientRect().top-${anchor.edge}`,
      );
      const height = await evaluate(
        context,
        `document.querySelector('[data-item="${anchor.id}"]').getBoundingClientRect().height`,
      );
      const expected = Math.max(anchor.offset, -Math.max(0, height - 44));
      assert.ok(
        Math.abs(offset - expected) < 2,
        `Keep ${anchor.id} visible at ${expected} after ${view}, got ${offset}`,
      );
    }
    const anchor = JSON.parse(await evaluate(context, 'JSON.stringify(fixtureAnchor())'));
    await evaluate(context, `document.querySelector('[data-item="${anchor.id}"] .library-open').click()`);
    await until(context, 'document.querySelector(".library-summary")', 'deep item details');
    // Details have no tool rows: they sit directly below the pinned Media header.
    assert.ok(
      await evaluate(
        context,
        '(()=>{const h=document.querySelector("#library-panel>.library-header").getBoundingClientRect(),o=document.querySelector(".library-overview").getBoundingClientRect().top;return document.querySelector(".library-tools").hidden && o>=h.bottom-1 && o-h.bottom<50})()',
      ),
      'Details appear directly below the header',
    );
    assert.ok(
      await evaluate(
        context,
        'Math.abs(document.querySelector("#library-panel>.library-header").getBoundingClientRect().top-Math.max(0,document.getElementById("library-panel").getBoundingClientRect().top))<2',
      ),
      'Details remain below the pinned library heading',
    );
    await evaluate(context, 'history.back()');
    await until(context, '!document.querySelector(".library").hidden', 'Browser Back from deep details');
    await pause(TOOLS_SLIDE);
    assert.ok(
      Math.abs(
        (await evaluate(
          context,
          `document.querySelector('[data-item="${anchor.id}"]').getBoundingClientRect().top-${anchor.edge}`,
        )) - anchor.offset,
      ) < 2,
      'Back restores deep item position',
    );
    await evaluate(context, 'history.forward()');
    await until(context, 'document.querySelector(".library-summary")', 'Browser Forward restores details');
    await evaluate(context, 'history.back()');
    await until(context, '!document.querySelector(".library").hidden', 'Browser Back restores library again');
    for (const view of ['list', 'posters', 'cards']) {
      await evaluate(context, `document.querySelector('.library-views [data-view="${view}"]').click()`);
      assert.equal(await evaluate(context, 'document.getElementById("library-content").dataset.view'), view);
    }
    await evaluate(
      context,
      'document.querySelector(".library-views [data-view=list]").click();document.querySelector(".library-tile").click()',
    );
    await until(
      context,
      'document.querySelector(".library-summary") && document.querySelector(".library").hidden',
      'Whole movie row opens details',
    );
    await evaluate(context, 'history.back()');
    await until(context, '!document.querySelector(".library").hidden', 'Back to list');
    await evaluate(context, 'document.querySelector(".library-tile .library-meta").click()');
    await until(context, 'document.querySelector(".library").hidden', 'Row metadata also opens details');
    await evaluate(context, 'history.back()');
    await until(context, '!document.querySelector(".library").hidden', 'Back to list again');
    for (const [name, width, height, theater] of [
      ['normal', 3840, 2160, false],
      ['theater', 3840, 2160, true],
      ['activity-size', 1920, 1080, true],
      ['phone', 390, 1100, true],
    ]) {
      await browser.viewport(context, width, height);
      await evaluate(
        context,
        `${act.setTheater(theater)};document.querySelector('.library-views [data-view=cards]').click();`,
      );
      await pause(120);
      const posterWidth = await evaluate(
        context,
        'document.querySelector(".library-tile>.library-art").getBoundingClientRect().width',
      );
      await evaluate(context, 'document.querySelector(".library-views [data-view=posters]").click()');
      assert.ok(
        Math.abs(
          (await evaluate(
            context,
            'document.querySelector(".library-tile>.library-art").getBoundingClientRect().width',
          )) - posterWidth,
        ) < 1,
        'Cards and Posters sizes match at ' + name,
      );
      await evaluate(context, 'document.querySelector(".library-title").click()');
      await until(
        context,
        'document.querySelector(".movie-detail") && document.querySelector(".library-summary")',
        'Movie details at ' + name,
      );
      await pause(80);
      assert.ok(
        Math.abs(
          (await evaluate(
            context,
            'document.querySelector(".movie-detail .library-art").getBoundingClientRect().width',
          )) - posterWidth,
        ) < 1,
        'Movie detail poster matches grid at ' + name,
      );
      assert.ok(
        await evaluate(
          context,
          'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1',
        ),
        'Movie details fit ' + name,
      );
      await browser.screenshot(context, path.join(EVIDENCE, name + '-plex-library-movie-details-' + name + '-qa.png'));
      await evaluate(context, 'history.back()');
      await until(context, '!document.querySelector(".library").hidden', 'Back to grid at ' + name);
      await evaluate(context, 'document.querySelector(".library-views [data-view=list]").click()');
      await pause(200);
      const rows = JSON.parse(
        await evaluate(
          context,
          `JSON.stringify([...document.querySelectorAll('.library-tile')].slice(0,3).map(card=>{const a=card.getBoundingClientRect(),b=card.querySelector('.library-play').getBoundingClientRect();return {size:b.width,top:b.top-a.top,bottom:a.bottom-b.bottom,right:a.right-b.right};}))`,
        ),
      );
      for (const row of rows)
        assert.ok(
          row.size === 55 && Math.abs(row.top - row.bottom) < 1 && Math.abs(row.right - rows[0].right) < 1,
          'Play is larger with consistent edge spacing at ' + name + ': ' + JSON.stringify(row),
        );
      await browser.screenshot(context, path.join(EVIDENCE, name + '-plex-library-list-' + name + '-qa.png'));
    }
    await evaluate(
      context,
      act.setTheater(false) + ';document.querySelector(".library-views [data-view=cards]").click()',
    );
    await browser.viewport(context, 1360, 1200);

    await evaluate(
      context,
      'document.querySelector(".library-views [data-view=posters]").click();document.activeElement.blur()',
    );
    assert.equal(await evaluate(context, 'getComputedStyle(document.querySelector(".library-copy")).opacity'), '0');
    await evaluate(context, 'document.querySelector(".library-open").focus()');
    await pause(200);
    assert.equal(await evaluate(context, 'getComputedStyle(document.querySelector(".library-copy")).opacity'), '1');
    await evaluate(
      context,
      'document.getElementById("library-home").click();document.querySelector(".library-home-card[data-tab=collections]").click()',
    );
    await until(context, 'document.querySelector(".library-title")?.textContent==="Sample collection"', 'collections');
    await evaluate(context, 'document.querySelector(".library-open").click()');
    await until(context, 'document.querySelectorAll(".library-tile").length===48', 'collection members');
    assert.equal(
      await evaluate(context, 'document.querySelector(".library-title").textContent'),
      'Needle beyond the first two hundred',
    );
    await evaluate(context, 'search.value="A Sample Movie";search.dispatchEvent(new Event("input"))');
    await until(context, 'document.querySelectorAll(".library-tile").length===2', 'whole collection search');
    await evaluate(
      context,
      'document.getElementById("library-filters-toggle").click();const gs=document.querySelector(".library-filters select");gs.value="5";gs.dispatchEvent(new Event("change"))',
    );
    await until(
      context,
      'document.querySelector(".library-count").textContent==="2 items" && document.querySelector(".library-filter-chip")',
      'collection genre filter',
    );
    await evaluate(
      context,
      'document.getElementById("library-home").click();[...document.querySelectorAll(".library-home-card[data-tab=library]")].find(n=>n.dataset.section==="2").click()',
    );
    await until(context, 'document.querySelector(".library-title")?.textContent==="A Sample Show"', 'show library');
    await evaluate(context, 'document.querySelector(".library-open").click()');
    await until(context, 'document.querySelectorAll(".library-tile").length===2', 'seasons');
    await evaluate(context, 'search.value="Season 1";search.dispatchEvent(new Event("input"))');
    await until(
      context,
      'document.querySelectorAll(".library-tile").length===1 && document.querySelector(".library-title").textContent==="Season 1"',
      'Filtering a multi-season show does not skip the season',
    );
    assert.equal(await evaluate(context, 'document.querySelectorAll(".library-tile.episode").length'), 0);
    await evaluate(context, 'search.value="";search.dispatchEvent(new Event("input"))');
    await until(context, 'document.querySelectorAll(".library-tile").length===2', 'Restore seasons');
    await evaluate(context, 'document.querySelector(".library-open").click()');
    await until(context, 'document.querySelectorAll(".library-tile.episode").length===2', 'episode rows');
    assert.equal(
      await evaluate(
        context,
        'document.querySelector(".library-tile.episode .library-art").classList.contains("landscape")',
      ),
      true,
    );
    await evaluate(context, 'document.querySelector(".library-open").click()');
    await until(context, 'document.querySelector(".library-summary")', 'Episode details');
    assert.equal(
      await evaluate(
        context,
        '[...document.querySelectorAll(".library-detail-parent-link")].map(n=>n.textContent).join("|")',
      ),
      'A Sample Show|Season 1',
    );
    await until(
      context,
      'document.querySelectorAll(".library-detail-art .library-art.loaded").length===1 && document.querySelector(".library-facts")',
      'Episode scene artwork, with full details',
    );
    assert.ok(
      artworkReads.includes('/library/metadata/10101/thumb/123'),
      'Episode details use the scene artwork source',
    );
    assert.equal(
      await evaluate(context, 'document.querySelectorAll(".library-detail-art .library-art").length'),
      1,
      'Episode details have no show poster',
    );
    assert.equal(
      await evaluate(context, 'document.querySelector(".library-detail-art .landscape img").dataset.kind'),
      'landscape',
    );
    assert.equal(
      await evaluate(context, '[...document.querySelectorAll(".library-facts dt")].map(n=>n.textContent).join("|")'),
      'Director|Cast|Ratings',
    );
    for (const text of [
      'TV-14',
      'Comedy',
      'Drama',
      'Sample director',
      'Sample actor eight',
      'TMDB 7.9/10',
      '1080p',
      'h264',
      '8.0 Mbps',
      'aac',
      '2 channels',
      'mkv',
    ])
      assert.equal(
        await evaluate(
          context,
          `document.querySelector('.library-overview').textContent.includes(${JSON.stringify(text)})`,
        ),
        true,
        'Detail retains ' + text,
      );
    await evaluate(context, 'document.querySelector(".library-media-info").open=true');
    for (const [name, width, height, theater] of [
      ['normal', 3840, 2160, false],
      ['theater', 3840, 2160, true],
      ['activity-size', 1920, 1080, true],
      ['phone', 390, 1100, true],
    ]) {
      await browser.viewport(context, width, height);
      await evaluate(
        context,
        `${act.setTheater(theater)};document.getElementById("library-content").scrollIntoView();`,
      );
      await pause(150);
      await evaluate(
        context,
        '[...document.querySelectorAll(".library-detail-parent-link")].find(n=>n.textContent==="Season 1").click()',
      );
      await until(
        context,
        '!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile.episode").length===2',
        'Episode list at ' + name,
      );
      await evaluate(context, 'document.querySelector(".library-open").click()');
      await until(
        context,
        'document.querySelector(".library-facts") && document.querySelectorAll(".library-detail-art .loaded").length===1',
        'Episode details opened at ' + name,
      );
      await evaluate(context, 'document.querySelector(".library-media-info").open=true');
      assert.ok(
        await evaluate(
          context,
          'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1',
        ),
        'Details fit ' + name,
      );
      const geometry = JSON.parse(
        await evaluate(
          context,
          `(()=>{const a=document.querySelector('.library-detail-art>.landscape').getBoundingClientRect(),w=document.getElementById('library-content').getBoundingClientRect().width;return JSON.stringify({width:a.width,expected:Math.min(w,420),height:a.height});})()`,
        ),
      );
      assert.ok(
        Math.abs(geometry.width - geometry.expected) < 1 && Math.abs(geometry.height - (geometry.width * 9) / 16) < 1,
        'Episode scene fills former combined artwork width at ' + name,
      );
      if (width > 700)
        assert.ok(
          await evaluate(
            context,
            '(()=>{const a=document.getElementById("library-back").getBoundingClientRect(),b=document.querySelector(".library-choices").getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2)<2;})()',
          ),
          'Navigation buttons are centered at ' + name,
        );
      await browser.screenshot(
        context,
        path.join(EVIDENCE, name + '-plex-library-episode-details-' + name + '-qa.png'),
      );
    }
    await evaluate(context, act.setTheater(false));
    await browser.viewport(context, 1360, 1200);

    await browser.viewport(context, 390, 1100);
    await evaluate(context, act.setTheater(true) + ';' + act.openDrawer());
    assert.ok(
      await evaluate(
        context,
        'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1',
      ),
      'Phone episode details fit',
    );
    await browser.screenshot(context, path.join(EVIDENCE, name + '-plex-library-episode-parent-phone-qa.png'));
    await evaluate(context, act.setTheater(false));
    await browser.viewport(context, 1360, 1200);
    await evaluate(
      context,
      '[...document.querySelectorAll(".library-detail-parent-link")].find(n=>n.textContent==="A Sample Show").click()',
    );
    await until(
      context,
      'document.querySelectorAll(".library-tile").length===2 && !document.querySelector(".library").hidden',
      'Show link restores seasons',
    );
    await evaluate(context, 'history.back()');
    await until(
      context,
      'document.querySelector(".library-summary")?.textContent==="Episode description, kept short enough to scan in a compact row." && document.querySelector(".library-overview h3").textContent==="Episode title 1"',
      'Back follows show link visit history',
    );
    await evaluate(context, 'document.querySelector(".library-choices .library-choice:nth-child(2)").click()');
    await until(
      context,
      '[...document.querySelectorAll(".library-title")].some(n=>n.textContent==="B Single Season Show")',
      'TV root',
    );
    await evaluate(
      context,
      '[...document.querySelectorAll(".library-title")].find(n=>n.textContent==="B Single Season Show").click()',
    );
    await until(
      context,
      'document.querySelectorAll(".library-tile.episode").length===2 && document.querySelector(".library-overview h3")?.textContent==="B Single Season Show"',
      'Single-season show opens episodes directly',
    );
    assert.equal(
      await evaluate(context, 'document.querySelector(".library-tile .library-title").textContent'),
      'Episode title 1',
    );
    assert.equal(await evaluate(context, 'search.placeholder'), 'Search episodes');
    await evaluate(context, 'search.value="Episode title 2";search.dispatchEvent(new Event("input"))');
    await until(
      context,
      'document.querySelectorAll(".library-tile.episode").length===1 && document.querySelector(".library-title").textContent==="Episode title 2"',
      'Search direct episodes',
    );
    await evaluate(context, 'document.querySelector(".library-open").click()');
    await until(
      context,
      'document.querySelector(".library-overview h3")?.textContent==="Episode title 2"',
      'Single-season episode details',
    );
    assert.equal(
      await evaluate(
        context,
        '[...document.querySelectorAll(".library-detail-parent-link")].map(n=>n.textContent).join("|")',
      ),
      'B Single Season Show|Season 1',
    );
    await evaluate(context, 'history.back()');
    await until(
      context,
      '!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile.episode").length===1',
      'Back restores filtered direct episodes',
    );
    await evaluate(context, 'history.forward()');
    await until(
      context,
      'document.querySelector(".library-overview h3")?.textContent==="Episode title 2"',
      'Forward restores single-season episode',
    );
    await evaluate(
      context,
      '[...document.querySelectorAll(".library-detail-parent-link")].find(n=>n.textContent==="Season 1").click()',
    );
    await until(
      context,
      '!document.querySelector(".library").hidden && document.querySelectorAll(".library-tile.episode").length===1',
      'Season link returns to direct episode list',
    );
    await evaluate(context, 'document.querySelector(".library-choices .library-choice:first-child").click()');
    await until(context, 'document.querySelectorAll(".library-tile").length>=48', 'library restored');
    await evaluate(
      context,
      'document.querySelector(".library-views [data-view=cards]").click();document.getElementById("library-filters-toggle").click()',
    );
    await until(context, 'document.querySelector(".library-filters select").options.length>1', 'facets');
    await evaluate(
      context,
      'const ys=document.querySelectorAll(".library-filters select")[1];ys.value="2023";ys.dispatchEvent(new Event("change"))',
    );
    await until(context, 'document.querySelector(".library-count").textContent.includes("125")', 'year filter');
    await evaluate(context, 'document.querySelector(".library-filter-chip").click()');
    await until(context, 'document.querySelector(".library-count").textContent.includes("250")', 'remove filter');
    await evaluate(
      context,
      'document.getElementById("library-filters-toggle").click();document.getElementById("options-collapse").click()',
    );
    failNext = true;
    await evaluate(context, 'search.value="Temporary failure";search.dispatchEvent(new Event("input"))');
    await until(
      context,
      'document.querySelector(".library-note.library-error") || document.getElementById("library-note").classList.contains("library-error")',
      'local query error',
    );
    await evaluate(context, 'document.querySelector(".library-footer button").click()');
    await until(context, 'document.querySelector(".library-count").textContent==="0 items"', 'explicit retry');
    await evaluate(context, 'search.value="";search.dispatchEvent(new Event("input"))');
    await until(context, 'document.querySelectorAll(".library-tile").length===48', 'library after retry');
    await evaluate(
      context,
      'document.getElementById("library-sort").value="random";document.getElementById("library-sort").dispatchEvent(new Event("change"))',
    );
    await until(
      context,
      'document.querySelectorAll(".library-tile").length===48 && document.getElementById("library-direction").title==="Shuffle again"',
      'Random sort',
    );
    const randomOrder = await evaluate(
      context,
      '[...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item).join(",")',
    );
    await evaluate(context, 'document.querySelector(".library-sentinel").scrollIntoView({block:"end"})');
    await until(context, 'document.querySelectorAll(".library-tile").length>=96', 'Random next page');
    assert.equal(
      await evaluate(
        context,
        '[...document.querySelectorAll(".library-tile")].slice(0,48).map(n=>n.dataset.item).join(",")',
      ),
      randomOrder,
    );
    assert.equal(
      await evaluate(
        context,
        'new Set([...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item)).size===document.querySelectorAll(".library-tile").length',
      ),
      true,
    );
    await evaluate(context, 'document.getElementById("library-direction").click()');
    await until(context, 'document.querySelectorAll(".library-tile").length===48', 'Shuffle again');
    assert.notEqual(
      await evaluate(context, '[...document.querySelectorAll(".library-tile")].map(n=>n.dataset.item).join(",")'),
      randomOrder,
    );
    await evaluate(
      context,
      'document.getElementById("library-sort").value="title";document.getElementById("library-sort").dispatchEvent(new Event("change"))',
    );
    await until(context, 'document.querySelectorAll(".library-tile").length===48', 'Title sort restored');
    await evaluate(context, 'document.getElementById("library-home").click()');
    assert.equal(
      await evaluate(
        context,
        '!!document.getElementById("library-playback-test") || !!document.getElementById("playback-dialog")',
      ),
      false,
    );
    await browser.screenshot(context, path.join(EVIDENCE, name + '-plex-library-home-qa.png'));
    assert.ok(
      await evaluate(
        context,
        'document.getElementById("library-content").getBoundingClientRect().height<innerHeight*2',
      ),
      'Home does not retain the old grid height',
    );
    await evaluate(context, 'document.querySelector(".library-home-card[data-tab=library]").click()');
    await until(context, '!document.querySelector(".library").hidden', 'Return to Movies');
    assert.equal(
      await evaluate(context, 'document.getElementById("library-forward").disabled'),
      true,
      'New navigation discards Forward branch',
    );
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const [name, width, height, theater] of [
      ['normal', 3840, 2160, false],
      ['theater', 3840, 2160, true],
      ['activity-size', 1920, 1080, true],
      ['phone', 390, 1100, true],
    ]) {
      await browser.viewport(context, width, height);
      await evaluate(context, `${act.setTheater(theater)};document.getElementById("library-panel").scrollIntoView();`);
      await pause(200);
      const report = JSON.parse(
        await evaluate(
          context,
          `(()=>{const area=document.getElementById('library-content').getBoundingClientRect();const overflow=[...document.querySelectorAll('#library-content button,#library-content input,#library-content select')].filter(n=>{const b=n.getBoundingClientRect();return b.width&&(b.left<area.left-1||b.right>area.right+1);}).map(n=>n.className);return JSON.stringify({width:innerWidth,overflow});})()`,
        ),
      );
      assert.deepEqual(report.overflow, [], JSON.stringify(report));
      await browser.screenshot(context, path.join(EVIDENCE, name + '-plex-library-' + name + '-qa.png'));
      if (width === 390) {
        await evaluate(context, 'document.getElementById("library-home").click()');
        assert.ok(
          await evaluate(
            context,
            'document.getElementById("library-content").scrollWidth<=document.getElementById("library-content").clientWidth+1',
          ),
          'Phone Home cards fit',
        );
        await browser.screenshot(context, path.join(EVIDENCE, name + '-plex-library-home-phone-qa.png'));
        await evaluate(context, 'document.querySelector(".library-home-card[data-tab=library]").click()');
        await until(context, '!document.querySelector(".library").hidden', 'Phone library restored');
      }
      if (theater && width > 700) {
        // Browsing down tucks the tool rows behind the sticky header; scrolling up a little returns them.
        const pinned = tucked =>
          '(()=>{const header=document.querySelector("#library-panel>.library-header"),h=header.getBoundingClientRect(),tools=document.querySelector(".library-tools"),t=tools.getBoundingClientRect();return document.getElementById("library-panel").scrollTop===0&&getComputedStyle(header).position==="sticky"&&Math.abs(h.top)<2&&tools.classList.contains("library-tools-tucked")===' +
          tucked +
          '&&Math.abs(' +
          (tucked ? 't.bottom' : 't.top') +
          '-h.bottom)<2})()';
        await evaluate(context, 'document.getElementById("library-content").scrollIntoView();window.scrollBy(0,600)');
        await pause(TOOLS_SLIDE);
        assert.equal(
          await evaluate(context, pinned(true)),
          true,
          'Theater library scrolls with page, tucking the tools beneath sticky navigation',
        );
        await evaluate(context, 'window.scrollBy(0,-80)');
        await pause(TOOLS_SLIDE);
        assert.equal(
          await evaluate(context, pinned(false)),
          true,
          'Theater library scrolls with page beneath sticky navigation',
        );
        await browser.screenshot(context, path.join(EVIDENCE, name + '-plex-library-' + name + '-scrolled-qa.png'));
      }
    }
    await evaluate(
      context,
      'document.querySelector(".library-views [data-view=list]").click();document.querySelector("[data-item=\\\"2\\\"] [data-action=play]").click()',
    );
    await until(context, 'state?.mediaId==="2" && drawer.hidden', 'exact edition accepted and drawer closed');
    assert.equal(
      await evaluate(context, 'scrollY===0&&document.activeElement.id==="stage"'),
      true,
      'Accepted library playback returns to the video',
    );
    assert.equal(await evaluate(context, 'state.subtitle'), 'The Final Cut');
    assert.equal(
      await evaluate(context, 'document.querySelector(".library-overview").hidden'),
      true,
      'List Play does not also open details',
    );
    const activity = await browser.page(config.publicUrl + '/?demo=host&frame_id=fixture');
    await browser.viewport(activity, 1920, 1080);
    await until(activity, 'document.querySelector("#rooms button")', 'Activity rooms');
    await evaluate(activity, 'document.querySelector("#rooms button").click()');
    // Joining resets Media to the room's Libraries home, and a press during that is lost: press until it opens.
    await until(activity, '!!selected && document.querySelectorAll(".library-home-card").length===5', 'Activity home');
    await until(
      activity,
      act.pressUntil('.library-home-card[data-tab=library]', 'document.querySelectorAll(".library-tile").length===48'),
      'Activity library',
    );
    await evaluate(activity, act.openDrawer() + ';document.getElementById("options-collapse").click()');
    assert.equal(
      await evaluate(
        activity,
        'immersive && !theater && document.body.classList.contains("activity") && !document.getElementById("playback-test-link")',
      ),
      true,
    );
    await browser.screenshot(activity, path.join(EVIDENCE, name + '-plex-library-activity-qa.png'));
    // Without the Discord SDK, an Activity frame this small is picture-in-picture.
    await browser.viewport(activity, 480, 300);
    await until(activity, 'document.body.classList.contains("activity-pip")', 'Activity PIP');
    assert.equal(await evaluate(activity, 'getComputedStyle(drawer).display'), 'none', 'PIP stays video-only');
    await browser.viewport(activity, 1920, 1080);
    await until(activity, '!document.body.classList.contains("activity-pip")', 'Activity leaves PIP');
    await evaluate(activity, 'document.getElementById("close-room").click()');
    await until(
      activity,
      '!selected && !document.getElementById("library-panel").hidden && document.querySelectorAll(".library-home-card").length===5',
      'Leave restores lobby catalog',
    );
    await evaluate(activity, 'history.back()');
    await pause(150);
    assert.equal(
      await evaluate(
        activity,
        'location.pathname==="/" && document.querySelectorAll(".library > .library-tile").length===0 && !document.querySelector(".library-landing").hidden',
      ),
      true,
      'Browser history cannot restore the previous room catalog',
    );
    console.log(
      '[Plex library ' +
        name +
        '] PASS: Home cards, navigation arrows/browser history, separate library switcher, episode show and season links, single-season episodes/search/history, centered navigation, scene-only episode art, grid-sized movie posters, whole-row details and larger/evenly spaced Play controls, all detail fields at four viewport sizes, diagnostic navigation absence, room history isolation; authenticated artwork, complete search, infinite scroll, stable Random pages/shuffle, deep view/detail/back scroll anchors, theater toolbar coverage, editions, collections/order, seasons/episodes, filters and responsive layouts.',
    );
  } finally {
    await browser?.close();
    await app.close();
  }
}
(async () => {
  const browsers = (process.argv.find(arg => arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',');
  for (const name of browsers) await main(name);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
