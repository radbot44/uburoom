/* Toast wiring in isolated Chrome/Firefox profiles with disposable accounts. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { accountFixture } = require('./account-fixture');
const { playbackBrowser, pause } = require('./lib/playback-browser');

async function main() {
  const output = path.resolve('artifacts/toast-ui-' + Date.now());
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['chrome', 'firefox']) {
    const fixture = accountFixture();
    const config = { cert: fs.readFileSync('certs/server-cert.pem'), key: fs.readFileSync('certs/server-key.pem'),
      publicUrl: 'https://localhost', ownerId: fixture.subjects.host, guildId: 'fixture', channels: ['fixture'],
      demo: true, unifiedAccounts: true, demoSubjects: fixture.subjects,
      plexUrl: 'http://plex-fixture.invalid:32400', plexToken: 'fixture-owner' };
    const app = createApp(config, { plexFetch: fixture.fetch, oauthFetch: fixture.discordFetch, plexDemo: fixture });
    app.hub.access = { isMember: () => true, refresh: async () => true, voiceChannel: () => 'fixture', validVoiceChannel: () => true, options: () => ({ available: true }) };
    let browser;
    try {
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      config.publicUrl += ':' + app.server.address().port;
      browser = await playbackBrowser(name);
      const page = await browser.page(config.publicUrl + '/watch?demo=host');
      const run = expression => browser.evaluate(page, expression);
      const until = (expression, label) => browser.until(page, expression, label);
      await until('typeof me!=="undefined" && !!me && !!transport?.ready', 'Signed-in Watch');
      await run('$("create").click();$("room-name").value="Toast fixture";$("room-create").click()');
      await until('!!state?.id', 'Created room');
      await run('transport.onMessage=()=>{}');
      // Use the real state application path, including revision/age filtering.
      await run('globalThis.toastState=state;applyState({...state,transportSequence:stateTransportSequence+1,feedback:{revision:"toast-1",at:Date.now()+offset,action:"media.pause",sender:"Alice <fixture>"}})');
      assert.equal(await run('(document.querySelector("[data-toast=participant]")?.textContent||"")'), 'PauseAlice <fixture>');
      await run('showDisconnectToast();showDisconnectToast()');
      assert.equal(await run('Number(!!document.querySelector("[data-toast=reconnect]"))'), 1, 'Reconnect updates in place');
      assert.equal(await run('document.querySelector("[data-toast=reconnect]").textContent'), 'Disconnected from roomReconnecting…');
      assert.equal(await run('document.querySelector("[data-toast=participant]").dataset.loading==="true"'), false, 'Participant icon stays still');
      assert.equal(await run('document.querySelector("[data-toast=reconnect]").dataset.loading==="true"'), true, 'Reconnect icon spins');
      for (const width of [1280, 390]) {
        await browser.viewport(page, width, 900);
        for (const theme of ['dark', 'light']) {
          await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};toasts.show('participant',{title:'PauseAlice <fixture>',symbol:'pause',duration:2500})`);
          assert.equal(await run('[...document.querySelectorAll(".watch-toast")].every(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true, 'Toasts fit viewport');
          await browser.screenshot(page, path.join(output, `${name}-${width}-${theme}.png`));
        }
      }
      await pause(2700);
      assert.equal(await run('Number(!!document.querySelector("[data-toast=participant]"))'), 0, 'Participant expires');
      assert.equal(await run('Number(!!document.querySelector("[data-toast=reconnect]"))'), 1, 'Reconnect remains until cleared');
      await run('hideDisconnectToast();applyState({...toastState,transportSequence:stateTransportSequence+1,feedback:{revision:"toast-old",at:Date.now()+offset-4000,action:"media.pause",sender:"Old"}})');
      await until('document.querySelectorAll(".watch-toast").length===0', 'Stale feedback stays silent');
      // Superseded notification timers must not dismiss their replacement.
      await run('toasts.show("participant",{title:"First",duration:100});toasts.show("participant",{title:"Second",duration:600})');
      await pause(200);
      assert.equal(await run('(document.querySelector("[data-toast=participant]")?.textContent||"")'), 'Second');
      await run('toasts.clear()');
      await until('!document.querySelector("[data-toast=participant]")', 'Participant cleared');
      console.log(name + ': PASS toast wiring, replacement, expiry, stale filtering and desktop/mobile theme captures');
    } finally {
      await browser?.close();
      await app.close();
    }
  }
  console.log('Screenshots: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
