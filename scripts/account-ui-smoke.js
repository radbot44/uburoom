/* Login and account UI against isolated providers in disposable browsers. No .env. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { accountFixture } = require('./account-fixture');
const { playbackBrowser, pause } = require('./lib/playback-browser');

async function main() {
  const before = process.argv.includes('--before');
  const output = path.resolve('artifacts/account-ui-' + (before ? 'before-' : '') + Date.now());
  fs.mkdirSync(output, { recursive: true });
  for (const name of (process.argv.find(arg => arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',')) {
    const fixture = accountFixture();
    const config = { cert: fs.readFileSync('certs/server-cert.pem'), key: fs.readFileSync('certs/server-key.pem'),
      publicUrl: 'https://localhost', ownerId: fixture.subjects.host, guildId: 'fixture', channels: ['fixture'], demo: true,
      unifiedAccounts: true, demoSubjects: fixture.subjects, clientId: '100000000000000010', clientSecret: 'fixture-secret',
      plexUrl: 'http://plex-fixture.invalid:32400', plexToken: 'fixture-owner' };
    let hold, failure, releaseHold=()=>{};
    const startFixture = async () => {
      const app = createApp(config, { plexFetch: fixture.fetch, oauthFetch: fixture.discordFetch, plexDemo: fixture });
      app.hub.access = { refresh: async () => true, isMember: () => true, voiceChannel: () => 'fixture', validVoiceChannel: () => true, options: () => ({ available: true }) };
      const handler = app.server.listeners('request')[0];
      app.server.removeListener('request', handler);
      app.server.on('request', async (req, res) => {
        if (req.url === hold?.route) await hold.promise;
        if (req.url === failure) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Fixture sign-in service unavailable' }));
        } else handler(req, res);
      });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      config.publicUrl = 'https://localhost:' + app.server.address().port;
      return app;
    };
    const block = route => {
      let release;
      hold = { route, promise: new Promise(resolve => { release = resolve; }) };
      releaseHold = () => { hold = undefined; release(); };
      return releaseHold;
    };
    let app = await startFixture();
    let browser;
    try {
      browser = await playbackBrowser(name);
      let release = ()=>{};
      const page = await browser.page(config.publicUrl + '/watch');
      const evaluate = expression => browser.evaluate(page, expression);
      const until = (expression, label) => browser.until(page, expression, label);
      const shot = label => browser.screenshot(page, path.join(output, name + '-' + label + '.png'));
      await browser.viewport(page, 1200, 850);
      await pause(300);
      await shot('checking');
      if (!before) assert.equal(await evaluate('!!document.getElementById("watch-bootstrap") && !document.getElementById("welcome").hidden && !document.querySelector("main").inert && document.getElementById("empty-stage").contains(document.getElementById("auth-overlay")) && document.getElementById("empty-title").textContent==="Join or create a room" && getComputedStyle(document.getElementById("video")).visibility==="hidden"'), true, 'Page response supplies sign-in state directly inside the video-sized lobby');
      release();
      await until('!document.getElementById("welcome").hidden', 'Signed-out welcome');
      await shot('login');
      await evaluate('location.assign("/watch?demo=host");true');
      await until('typeof me!=="undefined" && !!me && transport?.ready', 'Account login');
      await browser.click(page, 'identity');
      await until('document.getElementById("account-dialog").open', 'Account dialog');
      await shot('discord-only');
      if (before) {
        await browser.click(page, 'connect-plex');
        await until('!!document.getElementById("demo-alice")', 'Plex provider');
        await browser.click(page, 'demo-alice');
        await until('typeof me!=="undefined" && me?.account?.identities.length===2 && document.getElementById("account-dialog").open', 'Linked account');
        await shot('linked');
        console.log(name, 'before renders captured');
        continue;
      }
      await until('!document.getElementById("account-content").hidden', 'Account details');
      assert.equal(await evaluate('document.getElementById("connect-discord").textContent'), 'Connect Discord');
      assert.equal(await evaluate('document.getElementById("plex-identity").textContent'), 'Not connected');
      const accountId = await evaluate('me.account.id');
      await browser.click(page, 'connect-plex');
      await until('!!document.getElementById("demo-alice")', 'Plex provider');
      await browser.click(page, 'demo-alice');
      await until('typeof me!=="undefined" && me?.account?.identities.length===2 && document.getElementById("account-dialog").open && !document.getElementById("account-content").hidden', 'Linked account');
      assert.equal(await evaluate('me.account.id'), accountId, 'Linking preserves the account UUID');
      assert.equal(await evaluate('document.getElementById("connect-plex").textContent'), 'Connect Plex');
      assert.equal(await evaluate('document.getElementById("account-identities").textContent.includes("100000000000000001") || !!document.getElementById("account-id")'), false, 'No account IDs displayed');
      assert.equal(await evaluate('[...document.querySelectorAll("#account-identities img")].every(img=>img.complete&&img.naturalWidth>0)'), true, 'Discord asset loads locally');
      await shot('linked');
      assert.equal(await evaluate('document.getElementById("connect-discord").hidden && document.getElementById("connect-plex").hidden && !document.getElementById("remove-discord").hidden && !document.getElementById("remove-plex").hidden'),true,'Connected providers have only a remove icon');
      await browser.click(page,'remove-plex');
      await until('document.getElementById("account-remove-dialog").open','Removal confirmation');
      await shot('remove-confirm');
      await browser.click(page,'account-remove-cancel');
      assert.equal(await evaluate('me.account.identities.length'),2,'Cancel preserves both connections');
      await browser.click(page,'remove-plex');
      failure='/api/account/plex/remove';
      await browser.click(page,'account-remove-confirm');
      await until('document.getElementById("account-remove-error").textContent.includes("unavailable") && !document.getElementById("account-remove-confirm").disabled','Removal error is recoverable');
      failure=undefined;
      await browser.click(page,'account-remove-confirm');
      await until('typeof me!=="undefined" && me?.account?.identities.length===1 && document.getElementById("account-dialog").open && !document.getElementById("account-content").hidden','Plex removal');
      assert.equal(await evaluate('me.account.id'),accountId,'Removal preserves UUID');
      assert.equal(await evaluate('document.getElementById("remove-discord").disabled && !document.getElementById("connect-plex").hidden'),true,'Last sign-in is protected and Connect replaces removal');
      await shot('connect-again');
      for(const width of [390,320]){
        await browser.viewport(page,width,850);
        assert.equal(await evaluate('(()=>{const row=document.getElementById("connect-plex").closest(".provider-row"),label=row.querySelector("h3").getBoundingClientRect(),button=document.getElementById("connect-plex").getBoundingClientRect();return button.left>=label.right && row.scrollWidth<=row.clientWidth;})()'),true,'Connect stays beside the provider on narrow screens');
        await shot('connect-again-'+width);
      }
      await browser.viewport(page,1200,850);
      await browser.click(page,'connect-plex');
      await until('!!document.getElementById("demo-alice")','Plex connect again');
      await browser.click(page,'demo-alice');
      await until('typeof me!=="undefined" && me?.account?.identities.length===2 && document.getElementById("account-dialog").open && !document.getElementById("account-content").hidden','Plex reconnect');
      assert.equal(await evaluate('me.account.id'),accountId,'Plex reconnect preserves UUID');
      for (const [label,width,light,theater] of [['desktop',1200,false,false],['theater',1200,false,true],['phone',390,false,false],['small-phone',320,false,false],['light',1200,true,false],['light-phone',390,true,false]]) {
        await browser.viewport(page,width,850);
        await evaluate('setTheater('+theater+');if((document.documentElement.dataset.theme==="light")!=='+light+')document.getElementById("theme-toggle").click();true');
        await pause(120);
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth && document.getElementById("account-dialog").scrollWidth<=document.getElementById("account-dialog").clientWidth'),true,'Account fits '+label);
        await shot(label);
      }
      await browser.viewport(page,1200,850);
      await evaluate('if(document.documentElement.dataset.theme==="light")document.getElementById("theme-toggle").click();true');
      await browser.click(page,'account-close');
      release = block('/api/account');
      await browser.click(page,'identity');
      assert.equal(await evaluate('document.getElementById("account-dialog").open && !document.getElementById("account-loading").hidden'),true,'Account opens immediately while loading');
      await browser.click(page,'account-close');
      release();await pause(250);
      assert.equal(await evaluate('document.getElementById("account-dialog").open'),false,'Late response cannot reopen dismissed account');
      failure='/api/account';
      await browser.click(page,'identity');
      await until('!document.getElementById("account-retry").hidden','Account fetch error');
      failure=undefined;
      await browser.click(page,'account-retry');
      await until('!document.getElementById("account-content").hidden','Account retry');
      await browser.click(page,'account-close');
      // Owner matching remains available, but is collapsed outside ordinary account controls.
      await browser.click(page,'admin-mode');
      await until('me.adminMode','Owner Admin mode');
      await browser.click(page,'identity');
      await until('!document.getElementById("account-admin").hidden','Owner account tools');
      assert.equal(await evaluate('document.getElementById("account-admin").open'),false,'Owner matching starts collapsed');
      await evaluate('document.getElementById("account-admin").open=true;true');
      await browser.viewport(page,390,900);
      await shot('owner-tools-phone');
      await browser.click(page,'account-close');
      // Missing saved Plex credentials must request sign-in without hiding the known username.
      app.registry.db.prepare('DELETE FROM credentials').run();app.registry.credentialCache.clear();
      await browser.click(page,'identity');
      await until('document.getElementById("plex-identity").textContent.includes("Sign-in needed")','Missing Plex credential');
      assert.equal(await evaluate('document.getElementById("plex-identity").textContent.includes("alice_plex")'),true);
      await browser.click(page,'account-close');
      // Start the remaining journeys on a fresh origin to stay inside the real request limit.
      await evaluate('transport.close();true');
      await app.close();app=await startFixture();
      await evaluate('location.assign('+JSON.stringify(config.publicUrl+'/watch?demo=host')+');true');
      await until('typeof me!=="undefined" && !!me && transport?.ready','Fresh browser login');
      const activityPage=await browser.page(config.publicUrl+'/watch?demo=host&frame_id=fixture');
      try { await browser.until(activityPage,'typeof me!=="undefined" && !!me && transport?.ready','Activity fixture'); }
      catch(error) { console.error(await browser.evaluate(activityPage,'JSON.stringify({auth:document.getElementById("auth-status").textContent,error:document.getElementById("error").textContent,status:document.getElementById("status").textContent,identity:typeof me,transport:typeof transport!=="undefined"&&transport?.ready})'));throw error; }
      await browser.evaluate(activityPage,'toggleDrawer(true);document.getElementById("identity").click();true');
      await browser.until(activityPage,'!document.getElementById("account-content").hidden','Activity account');
      assert.equal(await browser.evaluate(activityPage,'document.getElementById("account-logout").hidden && !document.getElementById("account-browser-hint").hidden && !document.getElementById("remove-discord").hidden && !document.getElementById("connect-plex").hidden'),true,'Activity offers both providers through browser handoff, without cookie logout');
      await browser.screenshot(activityPage,path.join(output,name+'-activity.png'));
      await browser.click(page,'identity');
      await until('!document.getElementById("account-content").hidden','Fresh account');
      await browser.click(page,'connect-plex');
      await until('!!document.getElementById("demo-alice")','Second fixture Plex provider');
      await browser.click(page,'demo-alice');
      await until('typeof me!=="undefined" && me?.account?.identities.length===2 && document.getElementById("account-dialog").open && !document.getElementById("account-content").hidden','Second fixture linked');
      const secondId=await evaluate('me.account.id');
      await browser.click(page,'remove-discord');
      await browser.click(page,'account-remove-confirm');
      await until('typeof me!=="undefined" && me?.account?.identities.length===1 && document.getElementById("account-dialog").open && !document.getElementById("account-content").hidden','Discord removal');
      assert.equal(await evaluate('me.account.id'),secondId);
      assert.equal(await evaluate('!document.getElementById("connect-discord").hidden && document.getElementById("remove-plex").disabled'),true);
      await shot('connect-discord-again');
      await browser.click(page,'connect-discord');
      await until('!!document.getElementById("demo-host")','Discord connect again');
      await browser.click(page,'demo-host');
      await until('typeof me!=="undefined" && me?.account?.identities.length===2 && document.getElementById("account-dialog").open && !document.getElementById("account-content").hidden','Discord reconnect');
      assert.equal(await evaluate('me.account.id'),secondId,'Discord reconnect preserves UUID');
      // Provider round trips reload all assets; keep logout independent of the
      // fixture's accumulated HTTP rate-limit bucket without relaxing it.
      await evaluate('transport.close();true');
      await browser.evaluate(activityPage,'transport.close();true');
      await app.close();app=await startFixture();
      await evaluate('location.assign('+JSON.stringify(config.publicUrl+'/watch?demo=host')+');true');
      await until('typeof me!=="undefined" && !!me && transport?.ready','Logout fixture login');
      await browser.click(page,'identity');
      await until('!document.getElementById("account-content").hidden','Logout account');
      await evaluate('document.getElementById("account-logout").scrollIntoView({block:"center"});true');
      await browser.click(page,'account-logout');
      try { await until('!!document.getElementById("welcome") && !document.getElementById("welcome").hidden','Logout returns to sign-in'); }
      catch(error){console.error(await evaluate('({url:location.href,error:document.getElementById("account-error")?.textContent,auth:document.getElementById("auth-status")?.textContent,logout:document.getElementById("account-logout")?.disabled})'));throw error;}
      assert.equal(await evaluate('!document.querySelector("main").inert && !document.getElementById("auth-overlay").hidden && document.getElementById("auth-loading").hidden'),true);
      console.log(name,browser.version,'PASS: neutral login, errors/retry, confirmed removal and connect again, stable UUID, username-only display, account loading/close, responsive themes, owner tools, Activity and logout');
    } finally {
      releaseHold();
      await browser?.close();
      await app.close();
    }
  }
  console.log('Account UI artifacts:', output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
