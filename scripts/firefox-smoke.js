/* Optional Windows Firefox smoke test: isolated profile + localhost video, never the user's browser/account. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createApp } = require('../server/app');
const { FIREFOX_REDIRECT } = require('../server/login');
const project = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-firefox-'));
  const extensionPath = path.join(temp, 'extension'); fs.cpSync(path.join(project, 'extension'), extensionPath, { recursive: true });
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile);
  const extensionUuid = randomUUID(), deviceId = randomUUID();
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches = ['https://localhost/*'];
  if (manifest.manifest_version === 3) manifest.web_accessible_resources[0].matches = ['https://localhost/*'];
  const mv3 = !process.argv.includes('--mv2');
  if (mv3 && manifest.manifest_version !== 3) {
    manifest.manifest_version = 3;
    manifest.host_permissions = manifest.permissions.filter(p => p.startsWith('https://'));
    manifest.permissions = manifest.permissions.filter(p => !p.startsWith('https://'));
    manifest.action = manifest.browser_action; delete manifest.browser_action;
    delete manifest.background.persistent;
    manifest.content_security_policy = { extension_pages: manifest.content_security_policy };
  } else if (!mv3 && manifest.manifest_version !== 2) {
    manifest.manifest_version = 2;
    manifest.permissions.push(...manifest.host_permissions); delete manifest.host_permissions;
    manifest.browser_action = manifest.action; delete manifest.action;
    manifest.background.persistent = true;
    manifest.content_security_policy = manifest.content_security_policy.extension_pages;
    manifest.web_accessible_resources = ['assets/uburoom-wordmark-brand.svg'];
  }
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
  const background = fs.readFileSync(path.join(extensionPath, 'background.js'), 'utf8')
    .replace('saved.deviceId || crypto.randomUUID()', `'${deviceId}'`)
    .replaceAll("sender.url?.startsWith('https://tv.youtube.com/')", "sender.url?.startsWith('https://localhost:9443/')");
  fs.writeFileSync(path.join(extensionPath, 'background.js'), background);
  const content = fs.readFileSync(path.join(extensionPath, 'content.js'), 'utf8').replace("  'use strict';", "  'use strict';\n  if (location.origin !== 'https://localhost:9443') return;");
  fs.writeFileSync(path.join(extensionPath, 'content.js'), content);
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'uburoom@uburoom.com': extensionUuid }))});`,
    'user_pref("remote.experimental.enabled", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);'
  ].join('\n'));
  const cert = fs.readFileSync(path.join(project, 'certs/server-cert.pem'));
  const key = fs.readFileSync(path.join(project, 'certs/server-key.pem'));
  const config = { publicUrl: 'https://localhost:6767', cert, key, ownerId: 'test-owner', guildId: 'test-guild', channels: ['test-channel'], clientId: 'fixture-client', clientSecret: 'fixture-secret' };
  // Real Firefox identity flow and local TLS; only Discord's external service is simulated.
  const app = createApp(config, { authorizeUrl: 'https://localhost:9443/mock-discord', oauthFetch: async url => {
    assert.ok(['https://discord.com/api/oauth2/token', 'https://discord.com/api/users/@me'].includes(url));
    return new Response(JSON.stringify(url.endsWith('/token') ? { access_token: 'fixture-token' } : { id: config.ownerId, username: 'alice' }));
  } });
  const fixtureVoice = '111111111111111111', otherVoice = '222222222222222222', friend = 'fixture-friend';
  let friendVoice = fixtureVoice, hostVoice = fixtureVoice;
  const fixtureClosures=[];const fixtureAuthenticate=app.hub.authenticate.bind(app.hub);app.hub.authenticate=(socket,...args)=>{socket.on('close',(code,reason)=>fixtureClosures.push({code,reason:String(reason)}));return fixtureAuthenticate(socket,...args);};
  app.hub.access = { refresh: async id => id === friend || id === config.ownerId, isMember: id => id === friend || id === config.ownerId,
    validVoiceChannel: id => [fixtureVoice, otherVoice].includes(id), voiceChannel: id => id === config.ownerId ? hostVoice : friendVoice,
    options: () => ({ available: true, guildName: 'Fixture guild' }) };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(6767, '127.0.0.1', resolve); });
  const fixture = https.createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url, 'https://localhost:9443');
    if (url.pathname === '/mock-discord') {
      const redirect = url.searchParams.get('redirect_uri');
      assert.equal(redirect, config.publicUrl + '/auth/callback');
      if (url.searchParams.has('approve')) {
        res.writeHead(302, { Location: redirect + '?' + new URLSearchParams({ code: 'fixture-code', state: url.searchParams.get('state') }) }); return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-fixture'" });
      return res.end('<!doctype html><title>Simulated Discord approval</title><button id="approve">Authorize fixture</button><script nonce="fixture">document.getElementById("approve").onclick=()=>{location.href=location.href+"&approve=1"}</script>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; media-src 'self' blob:; script-src 'nonce-fixture'; style-src 'unsafe-inline'; require-trusted-types-for 'script'" });
    res.end(`<!doctype html><html><head><title>Fixture TV</title></head><body><canvas width="640" height="360"></canvas><video muted autoplay width="640" height="360"></video><script nonce="fixture">const c=document.querySelector('canvas');const ctx=c.getContext('2d');setInterval(()=>{ctx.fillStyle='#276bb0';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.fillText('uburoom local fixture',30,50)},100);const v=document.querySelector('video');v.srcObject=c.captureStream(10);v.play();</script></body></html>`);
  });
  await new Promise(resolve => fixture.listen(9443, '127.0.0.1', resolve));
  let driver, firefox;
  try {
    firefox = spawn(process.env.FIREFOX_BINARY || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', '--remote-allow-system-access'],
      { windowsHide: true, env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Firefox BiDi startup timed out')), 20000);
      const inspect = chunk => { const m = /WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString()); if (m) { clearTimeout(timer); resolve(m[1] + '/session'); } };
      firefox.stderr.on('data', inspect); firefox.stdout.on('data', inspect); firefox.on('error', reject);
    });
    driver = new WebSocket(address); await once(driver, 'open');
    let sequence = 0; const pending = new Map();
    driver.on('message', raw => { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.type === 'error' ? p.reject(new Error(m.error + ': ' + m.message)) : p.resolve(m.result); } });
    function command(method, params = {}) {
      return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
        pending.set(id, { resolve, reject, timer }); driver.send(JSON.stringify({ id, method, params })); });
    }
    async function evaluate(context, expression) {
      const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
      if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function until(context, expression, message) {
      for (let n = 0; n < 25; n++) { if (await evaluate(context, expression)) return; await pause(100); }
      assert.fail(message);
    }
    async function clickPanel(selector) {
      const coordinates = JSON.parse(await evaluate(player, `(() => { const r = document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
      await command('input.performActions', { context: player, actions: [{ type: 'pointer', id: 'panel-pointer', parameters: { pointerType: 'mouse' }, actions: [
        { type: 'pointerMove', x: coordinates.x, y: coordinates.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }
      ] }] });
    }
    const session = await command('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    console.log('[Firefox] Browser:', session.capabilities.browserVersion);
    console.log('[Firefox] Install:', await command('webExtension.install', { extensionData: { type: 'path', path: extensionPath } }));
    const { context: player } = await command('browsingContext.create', { type: 'tab' });
    await command('browsingContext.navigate', { context: player, url: 'https://localhost:9443/', wait: 'complete' });
    await pause(3000);
    assert.equal(await evaluate(player, "!!document.getElementById('uburoom-root')"), true, 'content UI must load');
    await until(player, "(() => { const i=document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector('.brand'); return i.complete && i.naturalWidth>0; })()", 'player panel logo loads through narrowly scoped extension resources under fixture CSP');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-gear') === null && !document.getElementById('uburoom-root').shadowRoot.querySelector('#panel button')"), true, 'no permanent page launcher');
    await evaluate(player, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'Equal',altKey:true,shiftKey:true,bubbles:true}))");
    assert.equal(await evaluate(player, 'document.title'), '🔵 Fixture TV');
    assert.equal(await evaluate(player, "getComputedStyle(document.querySelector('video')).scale"), '1.005');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .badge-name').textContent"), 'You', 'unpaired local commands use an honest local sender label');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .badge-value').textContent"), '100.5%');
    assert.equal(await evaluate(player, "getComputedStyle(document.getElementById('uburoom-root').shadowRoot.querySelector('#osd svg')).width"), '112px', 'badge uses the approved larger icon');
    assert.equal(await evaluate(player, "(() => { const s=document.getElementById('uburoom-root').shadowRoot; const paths=n=>[...n.querySelectorAll('path')].map(p=>p.getAttribute('d')).join('|'); return paths(s.querySelector('#osd svg'))===paths(s.getElementById('panel').shadowRoot.querySelector('.size-control[data-field=zoom] .size-label svg')); })()"), true, 'badge reuses the exact remote symbol');
    await pause(2600);
    assert.equal(await evaluate(player, "getComputedStyle(document.getElementById('uburoom-root').shadowRoot.getElementById('osd')).opacity"), '0', 'badge has fully faded after 2.5 seconds');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.getElementById('osd').getAttribute('aria-hidden')"), 'true');
    await evaluate(player, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',altKey:true,shiftKey:true,ctrlKey:true,bubbles:true}))");
    await pause(100);
    await evaluate(player, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyR',altKey:true,shiftKey:true,bubbles:true}))");
    assert.equal(await evaluate(player, 'document.title'), 'Fixture TV');
    await evaluate(player, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',altKey:true,shiftKey:true,bubbles:true}))");
    assert.equal(await evaluate(player, 'document.title'), '🔵 Fixture TV');
    const { context: popup } = await command('browsingContext.create', { type: 'tab' });
    const popupUrl = `moz-extension://${extensionUuid}/popup.html`;
    await command('browsingContext.navigate', { context: popup, url: popupUrl, wait: 'complete' });
    if (process.argv.includes('--startup-only')) {
      assert.equal(await evaluate(popup, 'document.title'), 'uburoom');
      assert.equal(await evaluate(popup, "[...document.querySelectorAll('[data-server]')].map(b=>b.dataset.server).join(',')"), 'https://localhost:6767');
      assert.equal(await evaluate(popup, "browser.runtime.sendMessage({type:'popup-state'}).then(s=>!!s.session?.enabled)"), false);
      console.log('[Firefox] PASS: extension startup, configured server picker, local controls/CSP and remote off. Full extension fixture remains deferred.');
      return;
    }
    console.log('[Firefox] Popup:', await evaluate(popup, "document.getElementById('status').textContent"));
    await until(popup, "document.querySelector('header .brand').complete && document.querySelector('header .brand').naturalWidth>0", 'popup logo loads');
    assert.equal(await evaluate(popup, 'browser.identity.getRedirectURL()'), FIREFOX_REDIRECT, 'server return URL must match Firefox');
    assert.equal(await evaluate(popup, "document.querySelector('details') === null && !!document.getElementById('signin')"), true, 'sign-in is visible without an accordion');
    assert.ok(await evaluate(popup, "document.getElementById('signin').getBoundingClientRect().top < 100 && document.body.scrollHeight < 550"), 'sign-in and player controls must fit a Firefox popup without scrolling');
    await evaluate(popup, "document.getElementById('signin').click(); true");
    let auth;
    for (let n = 0; n < 40; n++) {
      const tree = await command('browsingContext.getTree');
      auth = tree.contexts.find(c => c.url.startsWith('https://localhost:9443/mock-discord'));
      if (auth) break;
      await pause(250);
    }
    assert.ok(auth, 'Firefox must open the simulated Discord sign-in window');
    await evaluate(auth.context, "document.getElementById('approve').click(); true").catch(() => {});
    let signedIn;
    for (let n = 0; n < 40; n++) {
      signedIn = JSON.parse(await evaluate(popup, "browser.runtime.sendMessage({type:'popup-state'}).then(s=>JSON.stringify(s))"));
      if (signedIn.paired && signedIn.status.startsWith('Connected')) break;
      await pause(250);
    }
    assert.equal(signedIn.paired, true, `automatic pairing failed: ${signedIn.status}`);
    assert.equal(app.store.devices.length, 1);
    assert.equal(app.store.devices[0].id, deviceId);
    assert.equal(await evaluate(popup, "document.getElementById('signin-area').hidden"), true);
    console.log('[Firefox] PASS: one-click sign-in through the real Firefox auth window; automatic pairing, remote still off.');
    // The popup must be evaluated while the actual player tab is active.
    await command('browsingContext.activate', { context: player });
    let stateText = await evaluate(popup, "browser.runtime.sendMessage({type:'popup-state'}).then(s=>JSON.stringify(s))");
    let state = JSON.parse(stateText); assert.ok(state.session?.reachable, 'background routes the real content port');
    const actor = { userId: config.ownerId, guildId: config.guildId, channelId: config.channels[0] };
    await evaluate(popup, 'refresh()');
    // The real toolbar controls use the existing validated engine with remote off.
    for (const field of ['zoom','stretchX','stretchY']) {
      await evaluate(popup, `(() => {const row=document.getElementById('local-remote').shadowRoot.querySelector('.size-control[data-field=${field}]');row.querySelector('.picture-value').click();const input=row.querySelector('input');input.value='127.5';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
      await until(popup, `browser.runtime.sendMessage({type:'popup-state'}).then(s=>s.session?.state.picture.${field}===1.275)`, 'toolbar exact ' + field);
    }
    await evaluate(popup, `browser.runtime.sendMessage({type:'local-command',sessionId:${JSON.stringify(state.session.id)},command:{action:'pan.set',args:{x:.08,y:-.04}}})`);
    for (const field of ['zoom','stretchX','stretchY']) {
      const before=JSON.parse(await evaluate(popup,"browser.runtime.sendMessage({type:'popup-state'}).then(s=>JSON.stringify(s.session.state.picture))"));
      await evaluate(popup, `document.getElementById('local-remote').shadowRoot.querySelector('.size-control[data-field=${field}] .size-reset').click();true`);
      await until(popup, `browser.runtime.sendMessage({type:'popup-state'}).then(s=>s.session.state.picture.${field}===1)`, 'individual toolbar reset ' + field);
      const after=JSON.parse(await evaluate(popup,"browser.runtime.sendMessage({type:'popup-state'}).then(s=>JSON.stringify(s.session.state.picture))"));
      assert.deepEqual(after,{...before,[field]:1},'toolbar reset affects only its own setting');
    }
    await evaluate(popup,'refresh()');
    assert.equal(await evaluate(popup,"(() => {const s=document.getElementById('local-remote').shadowRoot;return s.querySelectorAll('.size-control').length===3 && [...s.querySelectorAll('.size-reset')].every(b=>b.disabled) && !s.querySelector('.modes') && [...s.querySelectorAll('.size-control')].every(r=>{const minus=r.querySelector('.minus').getBoundingClientRect(),reset=r.querySelector('.size-reset').getBoundingClientRect(),plus=r.querySelector('.plus').getBoundingClientRect();return reset.top>=minus.bottom && reset.left===minus.left && plus.height>minus.height;});})()"),true,'reset beneath minus; full-height plus; no switcher');
    await evaluate(popup,"document.getElementById('local-remote').shadowRoot.querySelector('.reset-all').click();true");
    await until(player,"document.title==='Fixture TV'",'Reset all clears picture transforms');
    assert.equal(await evaluate(popup,"(() => {const b=document.getElementById('local-remote').shadowRoot.querySelector('.reset-all');return !!b.querySelector('svg') && getComputedStyle(b).backgroundColor==='rgb(41, 46, 56)';})()"),true,'Reset all uses a quiet key surface and shared icon');
    await evaluate(player,"window.dispatchEvent(new KeyboardEvent('keydown',{code:'Equal',altKey:true,shiftKey:true,bubbles:true}));true");
    console.log('[Firefox] PASS: three independent exact values, isolated resets beneath minus and quiet icon Reset all through the real toolbar/engine.');
    assert.equal((await app.hub.dispatch(actor, { action: 'media.mute' })).status, 'forbidden');
    await evaluate(popup, 'refresh()');
    await evaluate(popup, "const range=document.getElementById('local-remote').shadowRoot.querySelector('input[type=range]');range.value='72';range.dispatchEvent(new Event('change'));true");
    await pause(150);
    assert.equal(await evaluate(player, "document.querySelector('video').volume"), .72, 'toolbar media controls work locally while remote is off');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .badge-name').textContent"), 'alice', 'toolbar commands use the paired owner name');
    await evaluate(popup, "range.dispatchEvent(new Event('pointerdown'));range.value='9';range.dispatchEvent(new Event('input'));true");
    await until(player, "document.querySelector('video').volume===.09", 'dragging changes local volume before release');
    const barsWidth = await evaluate(popup, "document.getElementById('local-remote').shadowRoot.querySelector('.bars').getBoundingClientRect().width");
    await evaluate(popup, "remote.render({...current.state,volume:72});true");
    assert.equal(await evaluate(popup, "document.getElementById('local-remote').shadowRoot.querySelector('.volume .number').textContent"), '9%', 'stale render must not flash the number while dragging');
    await evaluate(popup, "range.value='100';range.dispatchEvent(new Event('input'));true");
    await until(player, "document.querySelector('video').volume===1", 'dragging continues without mouse release');
    assert.equal(await evaluate(popup, "document.getElementById('local-remote').shadowRoot.querySelector('.bars').getBoundingClientRect().width"), barsWidth, 'one and three digit values keep the same slider width');
    await evaluate(popup, "range.value='72';range.dispatchEvent(new Event('input'));range.dispatchEvent(new Event('pointerup'));range.dispatchEvent(new Event('change'));true");
    await until(player, "document.querySelector('video').volume===.72", 'final slider value must apply');
    await evaluate(popup, `browser.runtime.sendMessage({type:'local-command',sessionId:${JSON.stringify(state.session.id)},command:{action:'media.mute'}})`);
    await evaluate(player, "(()=>{const target=document.querySelector('video');target.volume=.1;target.muted=false;return true})()");
    await until(player, "document.querySelector('video').volume===.72 && document.querySelector('video').muted", 'site reset does not erase audio intent');
    await evaluate(player, "const old=document.querySelector('video'), replacement=document.createElement('video');replacement.width=640;replacement.height=360;replacement.srcObject=old.srcObject;old.replaceWith(replacement);replacement.play().catch(()=>{});true");
    await pause(500);
    assert.equal(await evaluate(player, "document.querySelector('video').volume===.72 && document.querySelector('video').muted"), true, 'replacement video inherits tab audio intent');
    await evaluate(popup, `browser.runtime.sendMessage({type:'open-controls',sessionId:${JSON.stringify(state.session.id)}})`);
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.getElementById('panel').hidden"), false);
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelectorAll('.media .key').length"), 6, 'in-player controls include new boundary buttons');
    assert.equal(await evaluate(player, "(() => {const s=document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot;return s.querySelector('.start').disabled && s.querySelector('.end').disabled && !s.querySelector('.start').textContent && !s.querySelector('.end').textContent;})()"), true, 'boundary buttons are icon-only and unavailable on an unseekable stream');
    assert.equal(await evaluate(player, "(() => {const s=document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot;return getComputedStyle(s.querySelector('.control-track')).width==='57.5px' && s.querySelector('.sharing-status')===null;})()"), true, 'switches are wider and have no normal status row');
    // Record a short real video so Firefox's native media DOM exposes seekable ranges.
    const seekFixture=JSON.parse(await evaluate(player, `(async () => {const chunks=[],stream=document.querySelector('canvas').captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});recorder.ondataavailable=e=>chunks.push(e.data);await new Promise(resolve=>{recorder.onstop=resolve;recorder.start();setTimeout(()=>recorder.stop(),3000);});const v=document.querySelector('video');v.srcObject=null;v.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));await new Promise((resolve,reject)=>{v.addEventListener('loadeddata',resolve,{once:true});v.addEventListener('error',()=>reject(new Error('Recording video load failed')),{once:true});});v.pause();return JSON.stringify({duration:v.duration,ranges:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)])});})()`));
    console.log('[Firefox] Seek fixture:',seekFixture);
    assert.ok(seekFixture.ranges.length,'recording must expose actual seekable ranges');
    const Engine=require('../extension/engine');
    for (const [action,target] of [['media.seek.start',Engine.seekBoundary(seekFixture.ranges,'start')],['media.seek.end',Engine.seekBoundary(seekFixture.ranges,'end')]]) {
      const r=JSON.parse(await evaluate(popup,`browser.runtime.sendMessage({type:'local-command',sessionId:${JSON.stringify(state.session.id)},command:{action:${JSON.stringify(action)}}}).then(r=>JSON.stringify(r))`));
      assert.equal(r.status,'applied',action);assert.ok(Math.abs(await evaluate(player,"document.querySelector('video').currentTime")-target)<.05,'seek reached boundary');
    }
    await evaluate(player,"(async () => {const v=document.querySelector('video');v.removeAttribute('src');v.srcObject=document.querySelector('canvas').captureStream(10);await v.play();return true;})()");
    await evaluate(player, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'F8',bubbles:true}));true");
    console.log('[Firefox] PASS: toolbar/local media controls, no page launcher, volume/mute survive site resets and video replacement.');
    await evaluate(player, `(() => {
      customElements.define('tp-yt-paper-slider', class extends HTMLElement {
        static get observedAttributes() { return ['value']; }
        attributeChangedCallback(name, old, value) { this.setAttribute('aria-valuenow', value); }
      });
      const control = document.createElement('ytu-volume-slider'), slider = document.createElement('tp-yt-paper-slider'), mute = document.createElement('button');
      control.style.cssText = 'display:block;width:180px;height:30px'; slider.style.cssText = 'display:inline-block;width:100px;height:30px;background:#333';
      slider.tabIndex = 0; slider.setAttribute('value','72'); mute.setAttribute('aria-label','Mute (m)'); mute.textContent='Mute';
      const active = () => document.querySelector('video');
      const change = () => { active().volume = Number(slider.getAttribute('value')) / 100; active().muted = false; mute.setAttribute('aria-label','Mute (m)'); };
      slider.addEventListener('change', change); slider.addEventListener('immediate-value-change', change);
      slider.addEventListener('keydown', e => { if (e.key === 'ArrowUp') { slider.setAttribute('value', String(Number(slider.getAttribute('value')) + 1)); slider.dispatchEvent(new Event('immediate-value-change',{bubbles:true})); } });
      mute.addEventListener('click', () => { active().muted = !active().muted; mute.setAttribute('aria-label', active().muted ? 'Unmute (m)' : 'Mute (m)'); });
      control.append(mute, slider); document.body.append(control); return true;
    })()`);
    await evaluate(popup, `browser.runtime.sendMessage({type:'local-command',sessionId:${JSON.stringify(state.session.id)},command:{action:'media.volume.set',args:{percent:36}}})`);
    assert.equal(await evaluate(player, "document.querySelector('ytu-volume-slider tp-yt-paper-slider').getAttribute('aria-valuenow')"), '36', 'extension updates native slider DOM and the site handler');
    await evaluate(player, "document.querySelector('ytu-volume-slider tp-yt-paper-slider').focus();true");
    await command('input.performActions', { context: player, actions: [{ type: 'key', id: 'native-audio', actions: [{ type: 'keyDown', value: '\uE013' }, { type: 'keyUp', value: '\uE013' }] }] });
    await pause(1300);
    assert.equal(await evaluate(player, "document.querySelector('video').volume"), .37, 'trusted native slider change replaces remembered extension value');
    console.log('[Firefox] PASS: continuous slider input, stable width/draft and native slider handoff using simulated YouTube TV markup.');
    await command('browsingContext.setViewport', { context: player, viewport: { width: 1000, height: 1200 } });
    await evaluate(player, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'F8',bubbles:true}));true");
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector('.sharing').hidden"), false, 'local page includes sharing controls');
    await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector('[data-control=enabled]').click();true");
    assert.equal(await evaluate(player, "document.title.includes('🟢')"), false, 'page script cannot synthesize remote consent');
    await clickPanel('[data-control=enabled]');
    await until(player, "document.title.includes('🟢')", 'trusted local page click enables remote');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelectorAll('[data-mode]').length"),0,'scope choices removed from the local remote');
    await clickPanel('[data-control=enabled]');
    await until(player, "!document.title.includes('🟢')", 'local page disables remote');
    await evaluate(player, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'F8',bubbles:true}));true");
    const result = await evaluate(popup, `browser.runtime.sendMessage({type:'enable',sessionId:${JSON.stringify(state.session.id)},alias:'fixture'}).then(r=>JSON.stringify(r))`);
    assert.equal(JSON.parse(result).error, undefined);
    await pause(300);
    assert.equal(await evaluate(player, 'document.title'), '🟢 🔵 Fixture TV');
    const applied = await app.hub.dispatch(actor, { action: 'zoom.set', args: { value: 1.5 } });
    assert.equal(applied.status, 'applied');
    assert.equal(await evaluate(player, "getComputedStyle(document.querySelector('video')).scale"), '1.5');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .badge-name').textContent"), 'alice', 'remote sender name survives the real server/background/content transport');
    const badgeShot = await command('browsingContext.captureScreenshot', { context: player, origin:'viewport' });
    fs.mkdirSync(path.join(project,'artifacts'), { recursive:true });
    fs.writeFileSync(path.join(project,'artifacts','player-badge-0.3.1-qa.png'),Buffer.from(badgeShot.data,'base64'));
    for (const action of ['status.get', 'help.get']) {
      assert.equal((await app.hub.dispatch(actor, { action })).status, 'applied');
      assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .uburoom-badge').dataset.action"), 'zoom.set', 'queries must not replace the player badge');
    }
    assert.equal((await app.hub.dispatch(actor, { action: 'media.play' })).status, 'applied');
    const { context: web } = await command('browsingContext.create', { type: 'tab' });
    await command('browsingContext.navigate', { context: web, url: config.publicUrl + '/', wait: 'complete' });
    await pause(500);
    assert.equal(await evaluate(web, "document.getElementById('welcome').hidden"), true, 'webpage reuses the authenticated owner login');
    await until(web, "document.querySelector('#welcome .brand').complete && document.querySelector('#welcome .brand').naturalWidth>0", 'web login logo loads under server CSP');
    await evaluate(web, 'refreshPlayers()');
    assert.equal(await evaluate(web, "document.querySelectorAll('#players button').length"), 1);
    assert.equal(await evaluate(web, "document.getElementById('remote').shadowRoot.querySelector('.play').disabled"), false, 'single live host player is selected automatically');
    assert.equal(await evaluate(web, "document.getElementById('players').hidden"), false, 'single host remains visible');
    assert.equal(await evaluate(web, "document.getElementById('player-picker').hidden"), true, 'available hosts need no separate card');
    assert.equal(await evaluate(web, "document.querySelector('#players button').getAttribute('aria-pressed')"), 'true', 'single host is marked selected');
    assert.equal(await evaluate(web, "document.getElementById('remote').shadowRoot.querySelector('slot[name=players]').assignedElements()[0].id"), 'players', 'host buttons are slotted into the remote heading');
    await evaluate(web, "document.getElementById('remote').shadowRoot.querySelector('.play').click();true");
    await pause(400);
    console.log('[Firefox] Web command:', await evaluate(web, "document.getElementById('remote').shadowRoot.querySelector('.message').textContent"));
    assert.equal(await evaluate(player, "document.querySelector('video').paused"), true, 'web command executes through the authenticated hub');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .badge-name').textContent"), 'alice', 'web command shows the authenticated login name');
    assert.equal(await evaluate(web, "getComputedStyle(document.getElementById('remote').shadowRoot.querySelector('.remote')).backgroundColor"), 'rgb(16, 18, 23)', 'shared stylesheet passes the server CSP');
    await until(web, "(() => {const i=document.getElementById('remote').shadowRoot.querySelector('.brand');return i.complete && i.naturalWidth>0;})()", 'web remote logo loads under server CSP');
    await evaluate(web, `(() => {
      const host = document.createElement('div'); host.hidden = true; document.body.append(host);globalThis.pictureLayoutHost=host;
      globalThis.volumeRequests = []; globalThis.volumeReply = undefined;
      globalThis.volumeFixture = uburoomUI.mount(host, { volumeInterval: 0, execute: command => new Promise(resolve => {
        volumeRequests.push(command.args.percent); volumeReply = () => resolve({status:'applied',state:{picture:{zoom:1,stretchX:1,stretchY:1,x:0,y:0},volume:command.args.percent}});
      }) });
      volumeFixture.render({picture:{zoom:1,stretchX:1,stretchY:1,x:0,y:0},volume:50},{available:true});
      const range = volumeFixture.shadow.querySelector('input[type=range]'); range.dispatchEvent(new Event('pointerdown'));
      for (const value of [10,20,30]) { range.value = value; range.dispatchEvent(new Event('input')); }
      return true;
    })()`);
    assert.equal(await evaluate(web, 'JSON.stringify(volumeRequests)'), '[10]', 'network slider waits for acknowledgement with one command in flight');
    await evaluate(web, 'volumeReply();true');
    await until(web, 'JSON.stringify(volumeRequests)==="[10,30]"', 'network slider sends only the latest value after acknowledgement');
    await evaluate(web, "volumeFixture.shadow.querySelector('input[type=range]').value='40';volumeFixture.shadow.querySelector('input[type=range]').dispatchEvent(new Event('input'));volumeFixture.render(undefined,{available:false});volumeReply();true");
    await pause(150);
    assert.equal(await evaluate(web, 'JSON.stringify(volumeRequests)'), '[10,30]', 'disconnect clears unsent slider values');
    await evaluate(web, "document.getElementById('remote').shadowRoot.querySelector('[data-control=enabled]').click();true");
    await until(player, "!document.title.includes('🟢')", 'web host can disable');
    await evaluate(web, 'refreshPlayers()');
    assert.equal(await evaluate(web, "document.querySelectorAll('#players button').length"), 1, 'host can still select an off player');
    await evaluate(web, "document.getElementById('remote').shadowRoot.querySelector('[data-control=enabled]').click();true");
    await until(player, "document.title.includes('🟢')", 'web host can enable with execution acknowledgement');
    assert.equal(await evaluate(web,"document.getElementById('remote').shadowRoot.querySelectorAll('[data-mode]').length"),0,'scope choices removed from the web remote');
    async function seedPicture(picture) {
      for (const [field,value] of Object.entries(picture)) {
        if (field==='x'||field==='y') continue;
        const reply=await app.hub.dispatch(actor,{action:field==='zoom'?'zoom.set':'stretch.set',args:{axis:field,value}});
        assert.equal(reply.status,'applied','seed '+field+' '+value+'; '+await evaluate(player,"JSON.stringify({inline:document.querySelector('video').style.scale,computed:getComputedStyle(document.querySelector('video')).scale})"));
      }
      if (picture.x!==undefined) assert.equal((await app.hub.dispatch(actor,{action:'pan.set',args:{x:picture.x,y:picture.y}})).status,'applied');
      await evaluate(web,'refreshPlayers()');
    }
    await seedPicture({zoom:1.5,stretchX:1.1,stretchY:.95,x:.08,y:-.04});
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('.size-control[data-field=zoom] .plus').dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}));true");
    await until(web,"document.getElementById('remote').shadowRoot.querySelector('.size-control[data-field=zoom] .size-number').textContent==='175%'",'Ctrl fast zoom is independent of width and height');
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('.size-control[data-field=stretchX] .plus').dispatchEvent(new PointerEvent('pointerdown',{button:0}));true");
    await pause(850);
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('.size-control[data-field=stretchX] .plus').dispatchEvent(new PointerEvent('pointerup',{button:0}));true");
    await pause(200);
    const held=app.hub.rooms.get(state.session.id).state.picture.stretchX;
    assert.ok(held>1.1,'holding width repeats through acknowledged web commands');
    await pause(350);assert.equal(app.hub.rooms.get(state.session.id).state.picture.stretchX,held,'release stops repeating');
    for (const field of ['zoom','stretchX','stretchY']) {
      const before={...app.hub.rooms.get(state.session.id).state.picture};
      await evaluate(web,`document.getElementById('remote').shadowRoot.querySelector('.size-control[data-field=${field}] .size-reset').click();true`);
      await until(web,`document.getElementById('remote').shadowRoot.querySelector('.size-control[data-field=${field}] .size-number').textContent==='100%'`,'web reset '+field);
      assert.deepEqual(app.hub.rooms.get(state.session.id).state.picture,{...before,[field]:1},'authenticated web reset preserves other sizes and pan');
    }
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('.reset-all').click();true");
    await until(web,"document.getElementById('remote').shadowRoot.querySelector('.position-text output').textContent==='Centered'",'web Reset all also recenters');
    // Verify rounded computed CSS on a large horizontal stretch without asking
    // headless Firefox to rasterize a 256-by-256 scaled video surface.
    await seedPicture({zoom:1.59999,stretchX:16,stretchY:1});
    await seedPicture({zoom:1.5,stretchX:1.1,stretchY:.95});
    await evaluate(web,"pictureLayoutHost.hidden=false;pictureLayoutHost.style.cssText='width:calc(100% - 12px);max-width:500px;margin:auto';volumeFixture.render({picture:{zoom:15.995,stretchX:15.99,stretchY:16,x:0,y:0},volume:37},{available:true});true");
    for (const width of [320,360,390]) {
      await command('browsingContext.setViewport',{context:web,viewport:{width,height:1200}});
      const layout=JSON.parse(await evaluate(web,`(() => {const s=volumeFixture.shadow,r=s.querySelector('.transform').getBoundingClientRect();const overflow=[...s.querySelectorAll('.size-control button,.size-control input,.dpad button,.footer button')].filter(n=>n.getBoundingClientRect().width).filter(n=>{const b=n.getBoundingClientRect();return b.left<r.left||b.right>r.right;}).map(n=>n.className);const numbers=[...s.querySelectorAll('.size-number')].every(n=>n.getBoundingClientRect().width<=n.parentElement.clientWidth+1);return JSON.stringify({overflow,numbers,pageWidth:document.documentElement.scrollWidth});})()`));
      assert.deepEqual(layout.overflow,[],'phone controls stay inside the Picture card');assert.equal(layout.numbers,true,'large percentages remain readable without overlapping keys');assert.ok(layout.pageWidth<=width,'phone layout has no horizontal scroll');
    }
    await evaluate(web,'pictureLayoutHost.hidden=true;volumeFixture.stop();true');
    await seedPicture({zoom:1.5,stretchX:1.1,stretchY:.95,x:0,y:0});
    await evaluate(player,"if(document.getElementById('uburoom-root').shadowRoot.getElementById('panel').hidden)window.dispatchEvent(new KeyboardEvent('keydown',{code:'F8',bubbles:true}));true");
    await clickPanel('.size-control[data-field=stretchY] .plus');
    await until(player,"document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector('.size-control[data-field=stretchY] .size-number').textContent==='96%'",'trusted player panel increases height independently');
    const panelShot=await command('browsingContext.captureScreenshot',{context:player,origin:'viewport'});fs.writeFileSync(path.join(project,'artifacts','picture-panel-0.3.1-qa.png'),Buffer.from(panelShot.data,'base64'));
    await evaluate(player,"window.dispatchEvent(new KeyboardEvent('keydown',{code:'F8',bubbles:true}));true");
    await seedPicture({zoom:1.5,stretchX:1.1,stretchY:.95});
    console.log('[Firefox] PASS: web size controls, hold/release, Ctrl steps, isolated resets, player panel input and 320/360/390px bounds with large values.');
    await command('browsingContext.setViewport', { context: web, viewport: { width: 390, height: 1200 } });
    await pause(150);
    const shot = await command('browsingContext.captureScreenshot', { context: web, origin: 'document' });
    fs.writeFileSync(path.join(project,'artifacts','remote-controls-0.3.1-qa.png'),Buffer.from(shot.data,'base64'));
    fs.writeFileSync(path.join(project,'artifacts','web-logo-0.3.1-qa.png'),Buffer.from(shot.data,'base64'));
    fs.writeFileSync(path.join(temp, 'web-remote.png'), Buffer.from(shot.data, 'base64'));
    assert.ok(await evaluate(web, 'document.documentElement.scrollWidth <= 390'), 'phone layout must not scroll horizontally');
    // Exercise selection with several authorized players without changing backend identities.
    await evaluate(web, `globalThis.realFetch = fetch; globalThis.fakePlayers = [
      {id:'friend-player',alias:'bob',enabled:true,canManage:false},
      {id:'host-player',alias:'alice',enabled:true,canManage:true}];
      globalThis.fetch = (url,options) => url === '/api/sessions' ? Promise.resolve(new Response(JSON.stringify({sessions:fakePlayers}))) : realFetch(url,options);
      selected=undefined;refreshPlayers()`);
    assert.equal(await evaluate(web, 'selected'), 'host-player', 'host stream has priority over another available stream');
    assert.equal(await evaluate(web, `(() => { const heading = document.getElementById('remote').shadowRoot.querySelector('.header h2').getBoundingClientRect(); const players = document.getElementById('players').getBoundingClientRect(); return Math.abs((heading.top + heading.height/2) - (players.top + players.height/2)) < 1 && players.left > heading.right; })()`), true, 'host buttons align to the right of uburoom on the same row');
    await evaluate(web, "document.querySelector('[data-id=friend-player]').click();refreshPlayers()");
    assert.equal(await evaluate(web, 'selected'), 'friend-player', 'explicit choice survives polling');
    await evaluate(web, "fakePlayers.push({id:'second-host-player',alias:'alice #2',enabled:true,canManage:true});selected=undefined;refreshPlayers()");
    assert.equal(await evaluate(web, 'selected === undefined'), true, 'several own players still require a choice');
    await evaluate(web, "fakePlayers=[{id:'friend-player',alias:'bob',enabled:true},{id:'off-player',alias:'alice',enabled:false,canManage:true}];selected=undefined;refreshPlayers()");
    assert.equal(await evaluate(web, 'selected'), 'friend-player', 'sole live player is selected even with a host off player');
    await evaluate(web, 'fetch=realFetch;selected=undefined;refreshPlayers()');
    console.log('[Firefox] PASS: login cookie, automatic and explicit player selection, web-to-player action, shared colors/CSP and phone layout. Screenshot:', path.join(temp, 'web-remote.png'));
    await command('browsingContext.activate', { context: player });
    assert.equal((await app.hub.dispatch(actor, { action: 'media.pause' })).status, 'applied', 'fixture session before pause: '+JSON.stringify([...app.hub.rooms.values()].map(s=>({enabled:s.enabled,reachable:s.reachable,mode:s.mode,age:Date.now()-s.lastSeen}))));
    assert.equal(await evaluate(player, "document.querySelector('video').paused"), true);
    await evaluate(player, "document.title='Fixture program'");
    await pause(100);
    assert.equal(await evaluate(player, 'document.title'), '🟢 🔵 Fixture program');
    assert.equal((await app.hub.dispatch({ ...actor, userId: 'other' }, { action: 'media.mute' })).status, 'forbidden');
    // Exercise the real popup's local-only sharing controls while the player tab is active.
    await evaluate(popup, 'refresh()');
    assert.equal(await evaluate(popup, "document.getElementById('sharing-hint') === null"), true, 'toolbar Voice has no explanatory paragraph');
    assert.equal(await evaluate(popup, "document.getElementById('local-remote').shadowRoot.querySelector('.sharing').hidden"), false);
    assert.equal(await evaluate(popup,"document.getElementById('local-remote').shadowRoot.querySelectorAll('[data-mode]').length"),0,'scope choices removed from the toolbar');
    await evaluate(popup, 'refresh()');
    console.log('[Firefox] Popup layout:', await evaluate(popup, "JSON.stringify({height:document.body.scrollHeight,modes:document.getElementById('local-remote').shadowRoot.querySelector('.sharing').getBoundingClientRect().top,media:document.getElementById('local-remote').shadowRoot.querySelector('.media').getBoundingClientRect().top})"));
    assert.ok(await evaluate(popup, "(() => {const s=document.getElementById('local-remote').shadowRoot;return document.body.scrollHeight < 600 && s.querySelector('.sharing').getBoundingClientRect().top<s.querySelector('.media').getBoundingClientRect().top;})()"), 'sharing controls remain above media and the popup fits');
    // Firefox BiDi cannot resize/capture privileged extension documents. The
    // real popup height is checked above; capture its shared compact component
    // in a normal web document for visual comparison.
    await evaluate(web,`document.querySelector('main').hidden=true;pictureLayoutHost.hidden=false;pictureLayoutHost.style.cssText='width:358px;max-width:calc(100% - 32px);margin:12px auto';volumeFixture.shadow.querySelector('.remote').classList.add('compact');volumeFixture.render(${JSON.stringify(app.hub.rooms.get(state.session.id).state)},{available:true,session:{canManage:true,enabled:true,reachable:true,connected:true,paired:true,sharingAvailable:true,mode:'voice',controls:{playback:true,transform:true},autoJoin:false}});true`);
    const compactShot=await command('browsingContext.captureScreenshot',{context:web,origin:'document'});fs.writeFileSync(path.join(project,'artifacts','picture-toolbar-component-0.3.1-qa.png'),Buffer.from(compactShot.data,'base64'));
    await evaluate(web,"document.querySelector('main').hidden=false;pictureLayoutHost.hidden=true;volumeFixture.shadow.querySelector('.remote').classList.remove('compact');volumeFixture.stop();true");

    const friendActor = { ...actor, userId: friend, name: '<b>Morgan</b>' };
    assert.equal((await app.hub.dispatch(friendActor, { action: 'media.mute' })).status, 'applied');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .badge-name').textContent"), '<b>Morgan</b>', 'sender text is preserved literally');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd b')===null"), true, 'names never inject HTML under player CSP');
    await evaluate(web,'refreshPlayers()');
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('[data-control=playback]').click();true");
    await until(player,"document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector('[data-control=playback]').getAttribute('aria-checked')==='false'",'web playback permission reaches the player');
    assert.equal((await app.hub.dispatch(friendActor,{action:'media.mute'})).status,'forbidden');
    assert.equal((await app.hub.dispatch(actor,{action:'media.pause'})).status,'applied','host playback unaffected');
    const pictureAcks=[];const originalAck=app.hub.ack.bind(app.hub);
    app.hub.ack=async (socket,message)=>{const p=app.hub.pending.get(message.id),s=p&&app.hub.rooms.get(p.sessionId);if(p)pictureAcks.push({action:p.command.action,result:message.status,epoch:p.epoch===s?.epoch,mode:p.mode===s?.mode,controls:s?.controls,voice:p.hostVoiceChannelId,currentVoice:hostVoice});return originalAck(socket,message);};
    const pictureReply=await app.hub.dispatch(friendActor,{action:'zoom.set',args:{value:1.5}});app.hub.ack=originalAck;
    if(pictureReply.status!=='applied')console.log('[Firefox] Picture trace:',JSON.stringify({reply:pictureReply,closures:fixtureClosures,acks:pictureAcks,popup:JSON.parse(await evaluate(popup,'browser.runtime.sendMessage({type:"popup-state"}).then(s=>JSON.stringify(s.session))'))}));
    assert.equal(pictureReply.status,'applied','picture remains independently shared');
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('[data-control=transform]').click();true");
    await until(player,"document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector('[data-control=transform]').getAttribute('aria-checked')==='false'",'web picture permission reaches the player');
    assert.equal((await app.hub.dispatch(friendActor,{action:'reset.all'})).status,'forbidden');
    assert.equal(await evaluate(player,"document.title.includes('🟢')"),true,'master connection remains enabled with guest controls off');
    for(const category of ['playback','transform']) {
      await evaluate(web,`document.getElementById('remote').shadowRoot.querySelector('[data-control=${category}]').click();true`);
      await until(player,`document.getElementById('uburoom-root').shadowRoot.getElementById('panel').shadowRoot.querySelector('[data-control=${category}]').getAttribute('aria-checked')==='true'`,'guest permission restored');
    }
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('[data-control=enabled]').click();true");
    await until(player,"!document.title.includes('🟢')",'manual remote disable');
    await evaluate(web,"document.getElementById('remote').shadowRoot.querySelector('[data-control=autoJoin]').click();true");
    await until(popup,"browser.storage.local.get('autoJoin').then(s=>s.autoJoin===true)",'On join is durably remembered');
    assert.equal(await evaluate(player,"document.title.includes('🟢')"),false,'arming while already in a call does not enable');
    app.hub.publishVoice();await pause(100);assert.equal(await evaluate(player,"document.title.includes('🟢')"),false,'voice snapshots are not joins');
    const staleJoin={...app.hub.voiceMessage(true),serverNow:Date.now()-4000,expiresAt:Date.now()-1000};
    for(const ws of app.hub.connections.values())ws.send(JSON.stringify(staleJoin));
    await pause(100);assert.equal(await evaluate(player,"document.title.includes('🟢')"),false,'stale joins never enable');
    hostVoice=otherVoice;app.hub.publishVoice(true);
    await until(player,"document.title.includes('🟢')",'fresh call join auto-enables the remembered device');
    app.hub.connections.get(deviceId).close(4000,'Fixture reconnect');
    await until(player,"!document.title.includes('🟢')",'disconnect clears remote');
    await pause(3500);
    await until(popup,"browser.runtime.sendMessage({type:'popup-state'}).then(s=>s.connected && s.session?.autoJoin && !s.session.enabled)",'reconnect retains preference with remote off');
    for(let n=0;n<30&&!app.hub.rooms.has(state.session.id);n++)await pause(50);
    assert.ok(app.hub.rooms.has(state.session.id),'reconnect reports fresh tab presence');
    await pause(300);assert.equal(await evaluate(player,"document.title.includes('🟢')"),false,'reconnect baseline does not enable an existing call');
    hostVoice=fixtureVoice;app.hub.publishVoice(true);
    await until(player,"document.title.includes('🟢')",'a later fresh join works after reconnect');
    console.log('[Firefox] PASS: independent guest permissions, wider switches, icon-only seek boundaries, remembered On join, stale/baseline rejection and reconnect safety.');
    hostVoice = otherVoice;
    assert.equal((await app.hub.dispatch(friendActor, { action: 'media.unmute' })).status, 'forbidden');
    friendVoice = otherVoice;
    assert.equal((await app.hub.dispatch(friendActor, { action: 'media.unmute' })).status, 'applied');
    hostVoice = undefined;
    assert.equal((await app.hub.dispatch(friendActor, { action: 'media.mute' })).status, 'forbidden');
    assert.equal((await app.hub.dispatch(actor, { action: 'media.mute' })).status, 'applied');
    hostVoice = otherVoice;
    friendVoice = undefined;
    assert.equal((await app.hub.dispatch(friendActor, { action: 'media.unmute' })).status, 'forbidden');
    console.log('[Firefox] PASS: guest controls follow the host voice channel, deny departure and retain host authority. Discord membership is simulated.');
    assert.equal((await app.hub.dispatch(actor, { action: 'room.disable' })).status, 'applied');
    await pause(100);
    assert.equal(await evaluate(player, 'document.title'), '🔵 Fixture program');
    assert.equal(await evaluate(player, "document.getElementById('uburoom-root').shadowRoot.querySelector('#osd .uburoom-badge').dataset.action"), 'room.disable', 'management commands show a badge even after remote is off');
    console.log('[Firefox] PASS: 112px shared Player badge, applied values, local/web/remote sender names, literal sender text, 2.5s dismissal and management feedback.');
    assert.equal((await app.hub.dispatch(actor, { action: 'media.mute' })).status, 'forbidden');
    await command('browsingContext.navigate', { context: player, url: 'https://localhost:9443/', wait: 'complete' });
    await until(popup, `browser.runtime.sendMessage({type:'popup-state'}).then(s=>s.session?.reachable && s.session.id!==${JSON.stringify(state.session.id)} && s.session.alias==='fixture')`, 'custom name survives reload');
    state = JSON.parse(await evaluate(popup, "browser.runtime.sendMessage({type:'popup-state'}).then(s=>JSON.stringify(s))"));
    assert.equal(state.session.enabled, false, 'name persistence never restores consent');
    assert.equal(state.session.autoJoin,true,'reload preserves On join, while remote consent resets');
    const renameResult = await evaluate(popup, `browser.runtime.sendMessage({type:'rename',sessionId:${JSON.stringify(state.session.id)},alias:''}).then(r=>JSON.stringify(r))`);
    assert.deepEqual(JSON.parse(renameResult), {}, 'blank player name is accepted');
    await evaluate(web, 'refreshPlayers()');
    assert.equal(await evaluate(web, "document.querySelector('#players button').textContent"), 'alice · Off', 'unnamed player uses the authenticated Discord username');
    await command('browsingContext.navigate', { context: player, url: 'https://localhost:9443/', wait: 'complete' });
    await until(popup, "browser.runtime.sendMessage({type:'popup-state'}).then(s=>s.session?.reachable && s.session.alias==='')", 'optional blank name also survives reload');
    state = JSON.parse(await evaluate(popup, "browser.runtime.sendMessage({type:'popup-state'}).then(s=>JSON.stringify(s))"));
    const {context: extraPlayer}=await command('browsingContext.create',{type:'tab'});
    await command('browsingContext.navigate',{context:extraPlayer,url:'https://localhost:9443/',wait:'complete'});
    await command('browsingContext.activate',{context:extraPlayer});
    await until(popup,"browser.runtime.sendMessage({type:'popup-state'}).then(s=>s.session?.reachable && s.session.autoJoin && !s.session.enabled)",'new tabs inherit remembered On join with remote off');
    await command('browsingContext.close',{context:extraPlayer});await command('browsingContext.activate',{context:player});
    assert.equal(await evaluate(popup,"browser.storage.local.get('autoJoin').then(s=>s.autoJoin)"),true,'closing a tab does not clear the device preference');
    console.log('[Firefox] PASS: named and unnamed players retain their names across refresh, with fresh identity and remote off.');
    const idleArg = process.argv.find(a => a.startsWith('--idle-ms='));
    const idleMs = idleArg ? Number(idleArg.split('=')[1]) : 0;
    if (idleMs) {
      assert.ok(Number.isFinite(idleMs) && idleMs > 0 && idleMs <= 600000);
      await evaluate(popup, `browser.runtime.sendMessage({type:'enable',sessionId:${JSON.stringify(state.session.id)},alias:'fixture'}).then(r=>JSON.stringify(r))`);
      await pause(300);
      await app.hub.dispatch(actor, { action: 'media.play' });
      await command('browsingContext.close', { context: popup });
      const { context: foreground } = await command('browsingContext.create', { type: 'tab' });
      await command('browsingContext.activate', { context: foreground });
      console.log(`[Firefox] ${mv3 ? 'MV3 event-page' : 'MV2 persistent'} lifecycle: player backgrounded for ${idleMs / 1000}s, popup/debugger closed.`);
      await pause(idleMs);
      const afterIdle = await app.hub.dispatch(actor, { action: 'zoom.set', args: { value: 1.75 } });
      assert.equal(afterIdle.status, 'applied', 'backgrounded player must remain reachable');
      assert.equal(await evaluate(player, "getComputedStyle(document.querySelector('video')).scale"), '1.75');
      console.log(`[Firefox] Lifecycle PASS: post-idle execution acknowledged in ${afterIdle.latencyMs} ms (local server round trip).`);
    }
    console.log('[Firefox] PASS: local controls/profile/title, authenticated routing, explicit opt-in, applied media/zoom, owner gate and remote disable.');
    console.log('[Firefox] Simulated OAuth and video fixture only; real Discord sign-in with this new flow and idle/fullscreen reliability need manual verification.');
    await command('browser.close').catch(() => {});
  } finally {
    driver?.close(); firefox?.kill(); await app.close(); await new Promise(resolve => fixture.close(resolve));
    console.log('[Firefox] Disposable profile retained for diagnostics:', temp);
  }
}
main().catch(e => { console.error('[Firefox] FAIL:', e.stack || e.message); process.exitCode = 1; });
