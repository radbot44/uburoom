/* Capture a fixed set of rendered surfaces x two themes x three widths into artifacts/ui-capture/.
 * Fixture accounts and media only; no real Plex/Discord and no private configuration.
 * Usage: node scripts/ui-capture.js [--browsers=chrome,firefox] [--out=<folder>] [--surfaces=lobby,gallery]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { startFixtureServer, openPage, dom } = require('./lib/ui-fixture');

const { shown, hidden, text, hasText, attr, isOpen, count } = dom;
const root = path.resolve(__dirname, '..');
const WIDTHS = [
  ['phone', 390, 844],
  ['tablet', 820, 1180],
  ['desktop', 1360, 900],
];
const THEMES = ['dark', 'light'];
const ROOM_NAME = 'Friday room';

// Capture context only: freeze motion and hide content that differs between runs of the same commit.
// Nothing here is served to real users; it is adopted into the page by this script.
const CAPTURE_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.os-scrollbar { visibility: hidden !important; }
#room-share-url-input { color: transparent !important; -webkit-text-fill-color: transparent !important; }
#room-lifetime-details { visibility: hidden !important; }
`;
const NOISE = [
  'All CSS animations and transitions are disabled; spinners render at rest.',
  'OverlayScrollbars tracks (.os-scrollbar) are hidden; they fade on a timer after each scroll or resize.',
  'The share dialog invite URL text (#room-share-url-input) is transparent; the invite code is random.',
  'Room settings "Created ... Last active" times (#room-lifetime-details) are hidden.',
];

const byId = id => 'document.getElementById(' + JSON.stringify(id) + ')';
const pressId = id => byId(id) + '.click();true';
const choose = (id, value) =>
  '(()=>{const e=' +
  byId(id) +
  ';e.value=' +
  JSON.stringify(value) +
  ';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()';

function option(name, fallback) {
  return process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3) || fallback;
}
function revision() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
    }).trim().length;
    return sha + (dirty ? '-dirty' : '');
  } catch {
    return 'unknown';
  }
}
function stamp() {
  const now = new Date(),
    two = value => String(value).padStart(2, '0');
  return (
    now.getFullYear() +
    two(now.getMonth() + 1) +
    two(now.getDate()) +
    '-' +
    two(now.getHours()) +
    two(now.getMinutes()) +
    two(now.getSeconds())
  );
}

async function captureBrowser(name, out, only) {
  const { app, config } = await startFixtureServer();
  let browser;
  const files = [];
  try {
    browser = await playbackBrowser(name);
    const host = await openPage(browser, config.publicUrl + '/?demo=host');
    const run = async (page, expression) => {
      await pause(100);
      return browser.evaluate(page, expression);
    };
    const until = (page, expression, label) => browser.until(page, expression, label, 30000);
    const freeze = page =>
      run(
        page,
        '(()=>{const s=new CSSStyleSheet();s.replaceSync(' +
          JSON.stringify(CAPTURE_CSS) +
          ');document.adoptedStyleSheets=[...document.adoptedStyleSheets,s];return true;})()',
      );
    // Fonts loaded, finite animations finished, two frames painted, no pointer over anything.
    const settle = async page => {
      await pause(350);
      await run(
        page,
        '(async()=>{await document.fonts.ready;for(const a of document.getAnimations()){try{a.finish();}catch{}}await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()',
      );
      await pause(150);
    };
    const setTheme = async (page, theme) => {
      if ((await run(page, 'document.documentElement.dataset.theme')) !== theme)
        await run(page, pressId('theme-toggle'));
      await until(page, 'document.documentElement.dataset.theme===' + JSON.stringify(theme), theme + ' theme');
      // The wordmark swaps to its themed source through the real toggle.
      await until(
        page,
        '[...document.querySelectorAll("img.brand:not([data-brand-outgoing])")].every(i=>i.complete&&i.naturalWidth>0)',
        'Wordmark ' + theme,
      );
    };
    const shoot = async (page, surface, theme, label, width, height, fullPage = false, each) => {
      await browser.viewport(page, width, height);
      if (each) await each();
      // Player chrome (controls and the centre play overlay) shows for 2.5 s after any player interaction
      // and stays on while player settings is open. Shoot only once that timer has run out, so the
      // chrome is in the same state on every run; the open player-settings dialog holds it on by design.
      await until(
        page,
        '!document.getElementById("stage")?.classList.contains("controls-visible") || !!document.getElementById("tracks-dialog")?.open',
        'Player chrome at rest',
      );
      await settle(page);
      if (fullPage) {
        const full = await run(page, 'Math.ceil(document.documentElement.scrollHeight)');
        if (full > height) {
          await browser.viewport(page, width, full);
          await settle(page);
        }
      }
      const file = path.join(out, name, surface + '-' + theme + '-' + label + '.png');
      await browser.screenshot(page, file);
      files.push(path.relative(out, file).split(path.sep).join('/'));
    };
    const capture = async (page, surface, { open, close, each, widths = WIDTHS, fullPage = false }) => {
      if (only && !only.includes(surface)) return;
      for (const theme of THEMES) {
        await browser.viewport(page, 1360, 900);
        await setTheme(page, theme);
        if (open) await open();
        for (const [label, width, height] of widths)
          await shoot(page, surface, theme, label, width, height, fullPage, each);
        await browser.viewport(page, 1360, 900);
        if (close) await close();
        // A closed dialog returns focus to its trigger; do not carry that focus ring into the next surface.
        await run(page, 'document.activeElement?.blur();true');
      }
      console.log(name + ': ' + surface);
    };

    await freeze(host);
    await browser.viewport(host, 1360, 900);
    await until(
      host,
      '!document.body.classList.contains("auth-pending") && ' +
        hasText('#identity', 'Demo host') +
        ' && ' +
        shown('#create') +
        ' && transport?.ready',
      'Lobby',
    );
    await capture(host, 'lobby', {});
    // Phone lobby: the Player settings gear opens a dialog holding only Notifications.
    await capture(host, 'lobby-player-settings', {
      widths: WIDTHS.filter(([label]) => label === 'phone'),
      open: async () => {
        await browser.viewport(host, 390, 844);
        await until(host, shown('#tracks-open'), 'Lobby Player settings gear');
        await run(host, pressId('tracks-open'));
        await until(host, isOpen('#tracks-dialog'), 'Lobby Player settings');
      },
      close: async () => {
        await run(host, pressId('tracks-close'));
        await until(host, '!' + isOpen('#tracks-dialog'), 'Lobby Player settings closed');
      },
    });
    await capture(host, 'new-room-dialog', {
      open: async () => {
        await run(host, pressId('create'));
        await until(host, isOpen('#room-dialog') + ' && ' + shown('#room-name'), 'New room dialog');
        // A fixed name instead of the random suggested placeholder.
        await run(host, byId('room-name') + '.value=' + JSON.stringify(ROOM_NAME) + ';true');
      },
      close: async () => {
        await run(host, pressId('room-dialog-close'));
        await until(host, '!' + isOpen('#room-dialog'), 'New room dialog closed');
      },
    });

    await run(host, pressId('create'));
    await until(host, isOpen('#room-dialog') + ' && ' + shown('#room-name'), 'New room dialog');
    await run(
      host,
      choose('room-create-preset', 'play-pause') +
        ';' +
        byId('room-name') +
        '.value=' +
        JSON.stringify(ROOM_NAME) +
        ';' +
        pressId('room-create'),
    );
    await until(
      host,
      text('#options-title') + '===' + JSON.stringify(ROOM_NAME) + ' && !' + isOpen('#room-dialog'),
      'Room',
    );
    await capture(host, 'room-empty', {});

    // Synchronization video, paused at a fixed position, with two queued items.
    await until(host, shown('.library-key[data-play=demo]'), 'Synchronization video');
    await run(host, dom.q('.library-key[data-play=demo]') + '.click();true');
    await until(host, attr('#player-play', 'aria-label') + '==="Pause"', 'Media plays');
    await run(host, pressId('player-play'));
    await until(host, attr('#player-play', 'aria-label') + '==="Play"', 'Media paused');
    await run(host, choose('timeline', '17'));
    await until(
      host,
      text('#time') +
        '.startsWith("0:17") && (()=>{const v=document.querySelector("#stage video");return !!v&&v.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-17)<0.25&&v.paused;})()',
      'Paused at 0:17',
    );
    for (const [title, subtitle] of [
      ['First queued item', 'Ep 1'],
      ['Second queued item', 'Ep 2'],
    ])
      await run(host, 'queueUI.add(' + JSON.stringify({ mediaId: 'demo', title, subtitle, duration: 60 }) + ')');
    await until(host, count('#queue-upcoming-list .queue-entry') + '===2', 'Queued items');
    // Leave no feedback popover from the queue additions in view.
    await run(host, 'window.dispatchEvent(new Event("scroll"));true');
    await until(host, count('.watch-popover') + '===0', 'Popovers gone');

    await capture(host, 'room-media-queue', {});
    await capture(host, 'room-scrolled', {
      each: () => run(host, 'window.scrollTo(0,document.documentElement.scrollHeight);true'),
      close: () => run(host, 'window.scrollTo(0,0);true'),
    });
    const settings = section => ({
      open: async () => {
        await run(host, pressId('room-settings-open'));
        await until(host, isOpen('#room-settings-dialog') + ' && ' + shown('#room-settings-content'), 'Room settings');
        await run(host, dom.q('#room-settings-nav [data-section=' + section + ']') + '.click();true');
        await until(
          host,
          attr('#room-settings-nav [data-section=' + section + ']', 'aria-current') + '==="true"',
          section,
        );
      },
      close: async () => {
        await run(host, pressId('room-settings-dismiss'));
        await until(host, '!' + isOpen('#room-settings-dialog'), 'Room settings closed');
      },
    });
    await capture(host, 'room-settings-general', settings('general'));
    await capture(host, 'room-settings-permissions', settings('permissions'));
    await capture(host, 'player-settings', {
      open: async () => {
        // Desktop opens the sliding menu first; More settings opens the full dialog.
        await run(host, pressId('tracks-open'));
        await run(host, 'if(!' + byId('tracks-dialog') + '.open)' + byId('settings-more') + '.click();true');
        await until(host, isOpen('#tracks-dialog'), 'Player settings');
      },
      close: async () => {
        await run(host, pressId('tracks-close'));
        await until(host, '!' + isOpen('#tracks-dialog'), 'Player settings closed');
      },
    });
    await capture(host, 'share-dialog', {
      open: async () => {
        await run(host, pressId('room-share'));
        await until(
          host,
          isOpen('#room-share-dialog') + ' && ' + byId('room-share-url-input') + '.value!==""',
          'Share',
        );
      },
      close: async () => {
        await run(host, pressId('room-share-dismiss'));
        await until(host, '!' + isOpen('#room-share-dialog'), 'Share closed');
      },
    });
    await capture(host, 'account-dialog', {
      open: async () => {
        await run(host, pressId('identity'));
        await until(host, isOpen('#account-dialog') + ' && ' + hidden('#account-loading'), 'Account');
      },
      close: async () => {
        await run(host, pressId('account-close'));
        await until(host, '!' + isOpen('#account-dialog'), 'Account closed');
      },
    });
    const phone = WIDTHS.filter(([label]) => label === 'phone');
    for (const [surface, tab] of [
      ['phone-queue', 'queue'],
      ['phone-media', 'media'],
    ])
      await capture(host, surface, {
        widths: phone,
        open: async () => {
          await browser.viewport(host, 390, 844);
          await until(host, shown('#section-tab-' + tab), 'Phone tabs');
          await run(host, pressId('section-tab-' + tab));
          await until(host, attr('#section-tab-' + tab, 'aria-selected') + '==="true"', 'Phone ' + tab);
        },
      });

    // Last room surface, since it advances the queue: playing the next item moves the first video into history.
    await capture(host, 'room-queue-history', {
      open: async () => {
        await run(host, pressId('next'));
        await until(host, count('#queue-history-list .queue-history-entry') + '>=1', 'History entry');
        await until(host, attr('#player-play', 'aria-label') + '==="Pause"', 'Next item plays');
        await run(host, pressId('player-play'));
        await until(host, attr('#player-play', 'aria-label') + '==="Play"', 'Next item paused');
        await run(host, choose('timeline', '17'));
        await until(host, text('#time') + '.startsWith("0:17")', 'Paused at 0:17');
        await run(host, 'window.dispatchEvent(new Event("scroll"));true');
        await until(host, count('.watch-popover') + '===0', 'Popovers gone');
      },
    });

    // The development gallery, full height, in its own tab after the room surfaces (the theme is shared).
    if (!only || only.includes('gallery')) {
      const gallery = await openPage(browser, config.publicUrl + '/__dev/gallery');
      await freeze(gallery);
      await until(gallery, 'document.body.dataset.galleryReady==="true"', 'Gallery');
      await capture(gallery, 'gallery', { fullPage: true });
    }
    return files;
  } finally {
    await browser?.close();
    await app.close();
  }
}

async function main() {
  const browsers = option('browsers', 'chrome,firefox').split(',');
  const only = option('surfaces', '').split(',').filter(Boolean);
  const out = path.resolve(root, option('out', path.join('artifacts', 'ui-capture', stamp() + '-' + revision())));
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('Capture folder is not empty: ' + out);
  const manifest = {
    revision: revision(),
    created: new Date().toISOString(),
    widths: Object.fromEntries(
      WIDTHS.map(([label, width, height]) => [label, { width, height, deviceScaleFactor: 1 }]),
    ),
    themes: THEMES,
    noise: NOISE,
    browsers: {},
  };
  for (const name of browsers) {
    fs.mkdirSync(path.join(out, name), { recursive: true });
    manifest.browsers[name] = await captureBrowser(name, out, only.length ? only : undefined);
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const total = Object.values(manifest.browsers).reduce((sum, list) => sum + list.length, 0);
  console.log('Captured ' + total + ' images into ' + path.relative(root, out));
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
