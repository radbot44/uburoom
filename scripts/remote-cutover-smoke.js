/* Isolated web entry point and remote-drawer checks in Chrome and Firefox. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { playbackBrowser, pause } = require('./lib/playback-browser');
async function main() {
  const root = path.resolve(__dirname, '..');
  const name = process.argv.find(arg => arg.startsWith('--browser='))?.slice(10) || 'firefox';
  const output = path.join(root, 'artifacts', 'remote-cutover-' + name);
  fs.mkdirSync(output, { recursive: true });
  const config = { cert: fs.readFileSync(path.join(root, 'certs/server-cert.pem')), key: fs.readFileSync(path.join(root, 'certs/server-key.pem')),
    publicUrl: 'https://localhost', ownerId: 'demo-host', guildId: 'fixture', channels: ['channel'], demo: true };
  const app = createApp(config, { oauthFetch: async () => { throw new Error('Live OAuth disabled'); }, plexFetch: async () => { throw new Error('Live Plex disabled'); } });
  app.hub.access = { refresh: async () => true, isMember: () => true, options: () => ({ available: false }) };
  let browser;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    browser = await playbackBrowser(name);
    const page = await browser.page(config.publicUrl + '/watch?demo=host');
    await browser.viewport(page, 1200, 850);
    await browser.until(page, 'typeof transport!=="undefined" && transport?.ready', 'Watch authentication');
    await browser.evaluate(page, 'createRoom().then(()=>true)');
    await browser.evaluate(page, 'execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}}).then(()=>true)');
    await browser.until(page, 'video.videoWidth>0 && !video.paused', 'Decoded playback');
    await browser.evaluate(page, 'toggleRemote(true);true');
    await browser.until(page, '!document.getElementById("remote").hidden && !document.getElementById("remote").shadowRoot.querySelector(".play").disabled', 'Authenticated remote drawer');
    assert.equal(await browser.evaluate(page, 'getComputedStyle(document.getElementById("remote").shadowRoot.querySelector(".remote")).backgroundColor'), 'rgb(27, 30, 38)');
    await browser.screenshot(page, path.join(output, 'watch-remote.png'));
    await browser.evaluate(page, 'document.getElementById("remote").shadowRoot.querySelector(".play").click();true');
    await browser.until(page, 'video.paused && state.state.paused', 'Remote-drawer pause acknowledgement');
    await browser.evaluate(page, 'location.assign("/?demo=host&entry=1");true');
    await pause(200);
    await browser.until(page, 'location.pathname==="/watch" && location.search.includes("entry=1") && document.readyState==="complete"', 'Root entry with query preserved');
    await browser.screenshot(page, path.join(output, 'root-entry.png'));
    assert.equal(await browser.evaluate(page, 'document.title'), 'uburoom watch');
    for (const route of ['/setup.js', '/style.css', '/index.html']) {
      assert.equal(await browser.evaluate(page, 'fetch(' + JSON.stringify(route) + ').then(r=>r.status)'), 404);
    }
    console.log(JSON.stringify({ passed: true, browser: name, version: browser.version, checks: ['decoded watch playback', 'authenticated remote drawer', 'pause command', 'root entry', 'query preservation'], limitations: 'Disposable synthetic media and accounts; not real YouTube TV or Discord Activity.' }));
  } finally { await browser?.close(); await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
