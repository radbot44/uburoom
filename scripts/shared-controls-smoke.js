/* Room increment: disposable accounts/state and independent browser profiles. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { accountFixture } = require('./account-fixture');

async function main() {
  const label = process.argv.includes('--before') ? 'before' : 'after';
  for (const name of (process.argv.find(arg => arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',')) {
    const fixture = accountFixture();
    const config = {cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',
      ownerId:'100000000000000001',guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:true,
      demoSubjects:{host:'100000000000000001',guest:'100000000000000002'},
      plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'};
    const app = createApp(config,{plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch,plexDemo:fixture});
    app.hub.access = {isMember:()=>true,refresh:async()=>true,voiceChannel:()=> 'fixture',validVoiceChannel:()=>true,options:()=>({available:true})};
    await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    let browser, page;
    try {
      browser = await playbackBrowser(name);
      page = await browser.page(config.publicUrl + '/watch?demo=host');
      const run = async expression => { await pause(100); return browser.evaluate(page,expression); };
      const until = (expression,title) => browser.until(page,expression,title);
      const shot = title => browser.screenshot(page,path.resolve('artifacts/shared-controls-' + name + '-' + label + '-' + title + '.png'));
      await browser.viewport(page,1360,1000);
      await until('me?.durableRooms && transport?.ready','Room login');
      await run('$("create").click()');
      await until('$("room-dialog").open','Room creation');
      await run('$("room-name").value="Shared controls room";$("room-create").click()');
      await until('state?.roomName==="Shared controls room"','Created room');
      await until('!pending && !$("room-settings-open").hidden','Room controls ready');
      if (label === 'after') {
        assert.deepEqual(await run(`['room-settings-open','room-visibility','room-people-open','room-more-permissions','switch-room','close-room'].map(id=>{
          const e=$(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return [r.height,s.borderTopWidth,s.borderRadius];
        })`),Array(6).fill([40,'0px','10px']));
        assert.deepEqual(await run('(()=>{const r=$("room-settings-open").getBoundingClientRect();return [r.width,r.height]})()'),[40,40]);
        assert.equal(await run('getComputedStyle(document.querySelector(".watch-panel-heading")).fontSize'),'17px');
        assert.equal(await run('getComputedStyle($("options-collapse")).gap'),'8px');
        assert.equal(await run('[...document.querySelectorAll("#options-panel .watch-control>svg")].filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().width===24 && e.getBoundingClientRect().height===24)'),true);
        assert.equal(await run('[...document.querySelectorAll("#options-panel .watch-control")].every(e=>!!e.getAttribute("aria-label") && !!e.title)'),true);
        assert.equal(await run('document.querySelectorAll("#queue-panel .watch-control,#library-panel .watch-control").length'),0);
        assert.equal(await run('getComputedStyle($("room-settings-open")).backgroundColor'),'rgba(0, 0, 0, 0)');
        assert.equal(await run('getComputedStyle(document.querySelector(".room-header-actions")).gap'),'0px');
        assert.equal(await run('document.querySelector("#room-participants .room-person").dataset.personId===me.account.id'),true);
        assert.equal(await run('getComputedStyle($("current-room")).gridTemplateColumns.split(" ").length'),2);
        await browser.click(page,'options-collapse');
        assert.equal(await run('getComputedStyle($("options-content")).display'),'none');
        await browser.click(page,'options-collapse');
        assert.notEqual(await run('getComputedStyle($("options-content")).display'),'none');
        assert.equal(await run('[...document.querySelectorAll("[data-quick-permission]")].every(e=>e.getAttribute("role")==="switch" && e.labels.length===1 && e.labels[0].parentElement.getBoundingClientRect().height>=44)'),true);
        assert.deepEqual(await run('(()=>{const r=document.querySelector("[data-quick-permission]").getBoundingClientRect();return [r.width,r.height]})()'),[36,22]);
        // Delay just this fixture's permission request to exercise the pending guard.
        await run(`globalThis.originalRequest=transport.request.bind(transport);globalThis.permissionWrites=0;
          transport.request=async(path,data,options)=>{if(data?.change?.action==='permissions'){permissionWrites++;await new Promise(resolve=>setTimeout(resolve,700));}return originalRequest(path,data,options)};
          document.querySelector('[data-quick-permission=playPause]').closest('label').click();`);
        assert.equal(await run('$("room-quick-status").textContent'),'Saving…');
        assert.equal(await run('[...document.querySelectorAll("[data-quick-permission]")].every(e=>e.disabled) && !$("room-more-permissions").disabled && !$("room-settings-open").disabled'),true);
        await run('document.querySelector("[data-quick-permission=playPause]").click()');
        await until('$("room-quick-status").textContent==="Saved"','Permission saved');
        assert.equal(await run('permissionWrites'),1);
        assert.equal(await run('state.participantPermissions.playPause'),true);
        assert.equal(await run('document.querySelector("[data-quick-permission=playPause]").closest(".watch-switch-pill").classList.contains("is-on")'),true);
        assert.equal(await run('document.querySelector("[data-quick-permission=playPause]").previousElementSibling.className'),'watch-switch-pill-label');
        await shot('switch-pill-on');
        await run('transport.request=originalRequest;document.querySelector("[data-quick-permission=playPause]").click()');
        await until('!state.participantPermissions.playPause && $("room-quick-status").textContent==="Saved"','Permission restored');
        await run('$("room-quick-status").textContent=""');
      }
      await shot('desktop');
      if (label === 'after') {
        await run('execute({action:"room.visibility",args:{visibility:"private"}})');
        await until('state.visibility==="private" && !pending','Private visibility');
        await run('$("badge").classList.remove("visible")');
        assert.equal(await run('$("room-visibility").textContent'),'');
        assert.match(await run('$("room-visibility").getAttribute("aria-label")'),/Private/);
        await shot('private-desktop');
        await run('execute({action:"room.visibility",args:{visibility:"public"}})');
        await until('state.visibility==="public" && !pending','Public visibility');
        await run('$("badge").classList.remove("visible")');
        assert.equal(await run('$("room-visibility").textContent'),'');
      }
      await browser.viewport(page,390,844); await pause(200); await shot('phone');
      await browser.viewport(page,320,844); await pause(200); await shot('narrow');
      if (label === 'after') {
        assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true);
        assert.equal(await run('$("room-visibility").querySelector(".watch-control-label")===null'),true);
        assert.match(await run('$("room-visibility").getAttribute("aria-label")'),/Public/);
        assert.equal(await run('$("room-visibility").closest("header") === $("room-settings-open").closest("header") && $("room-people-open").nextElementSibling === $("room-settings-open")'),true);
        assert.equal(await run('getComputedStyle($("options-title")).textOverflow'),'ellipsis');
        await run('globalThis.originalRoomName=state.roomName;api("/api/watch/rooms/"+selected+"/settings").then(details=>api("/api/watch/rooms/"+selected+"/settings",{revision:details.revision,change:{action:"rename",name:"A very long room name that must truncate while the header actions remain visible"}}))');
        await until('state.roomName.startsWith("A very long")','Long room name');
        assert.equal(await run('$("options-title").scrollWidth>$("options-title").clientWidth'),true);
        assert.equal(await run('(()=>{const r=$("options-panel").getBoundingClientRect();return ["room-visibility","room-people-open","room-settings-open"].every(id=>{const b=$(id).getBoundingClientRect();return b.left>=r.left && b.right<=r.right})})()'),true);
        await shot('long-name-narrow');
        await run('api("/api/watch/rooms/"+selected+"/settings").then(details=>api("/api/watch/rooms/"+selected+"/settings",{revision:details.revision,change:{action:"rename",name:originalRoomName}}))');
        await until('state.roomName===originalRoomName','Room name restored');
      }
      await browser.viewport(page,1360,1000);
      await run('roomUI.open(selected,"permissions")');
      if (label === 'after') {
        assert.equal(await run(`(()=>{
          let clicks=0,changes=0;
          const pill=uburoomControls.switchPill(document,{label:'Fixture switch pill',checked:true,onChange:()=>changes++,action:{label:'Fixture settings',onClick:()=>clicks++}});
          document.body.append(pill.element);
          const input=pill.input,action=pill.element.querySelector('button');
          const editable=input.isConnected && action.isConnected && pill.element.querySelector('label').firstElementChild.textContent==='Fixture switch pill';
          action.click();input.closest('label').click();
          const border=getComputedStyle(action).borderInlineStartWidth==='1px';
          pill.update({checked:true,editable:false});
          pill.update({checked:true});
          const readonly=!input.isConnected && !action.isConnected && pill.element.querySelectorAll('input,button,label').length===0 && pill.element.textContent.includes(': On');
          pill.update({checked:false,editable:true});
          const restored=input.isConnected && action.isConnected && !input.checked && !pill.element.classList.contains('is-on');
          pill.element.remove();return editable && readonly && restored && clicks===1 && changes===1 && border;
        })()`),true,'Split pill detaches controls for read-only badges and restores them when authorized');
      }
      await until('$("room-settings-dialog").open && !$("room-settings-content").hidden','Permissions');
      await shot('permissions-desktop');
      await browser.viewport(page,390,844); await pause(200); await shot('permissions-phone');
      if (label === 'after') {
        const group = '$("room-permission-preset-group")';
        assert.equal(await run(`getComputedStyle(${group}).height`),'40px');
        assert.equal(await run(`getComputedStyle(${group}).borderRadius`),'12px');
        assert.equal(await run(`${group}.querySelectorAll('button[tabindex="0"]').length`),1);
        await run('$("room-all-hosts").focus()');
        await browser.key(page,'Tab');
        assert.equal(await run('document.activeElement.id'),'room-preset-host-control','Tab enters at the selected preset');
        await browser.key(page,'ArrowRight');
        assert.equal(await run('document.activeElement.id'),'room-preset-play-pause');
        assert.equal(await run('$("room-permission-preset").value'),'host-control');
        assert.equal(await run('getComputedStyle(document.activeElement).outlineWidth'),'2px');
        assert.equal(await run('getComputedStyle(document.activeElement).outlineColor'),'rgb(255, 153, 84)');
        await browser.key(page,'Enter');
        await until('$("room-permission-preset").value==="play-pause" && $("room-settings-status").textContent==="Saved" && !$("room-preset-play-pause").disabled','Enter selects');
        await run('$("room-preset-play-pause").focus()');
        await browser.key(page,'Home');
        assert.equal(await run('$("room-permission-preset").value'),'play-pause');
        await browser.key(page,' ');
        await until('$("room-permission-preset").value==="host-control" && $("room-settings-status").textContent==="Saved" && !$("room-preset-host-control").disabled','Space selects');
        await run('$("room-preset-host-control").focus()');
        await browser.key(page,'Tab');
        assert.equal(await run('document.activeElement.closest("#room-permission-preset-group")===null'),true,'Tab leaves the segmented group in one step');
        assert.equal(await run('[...$("room-permissions").querySelectorAll("input")].every(e=>e.type==="checkbox" && e.getAttribute("role")==="switch" && e.labels.length===1 && !!e.getAttribute("aria-label"))'),true);
        assert.equal(await run('[...$("room-permissions").querySelectorAll("input[data-role=viewer]:disabled")].every(e=>!!e.closest("label").title)'),true);
        await browser.viewport(page,320,844); await pause(150);
        assert.equal(await run('$("room-settings-panels").scrollWidth<=$("room-settings-panels").clientWidth'),true);
        await shot('permissions-narrow');
        await run('document.documentElement.dataset.theme="light";document.documentElement.dataset.accent="pink"');
        await pause(200);
        await shot('permissions-light-pink');
        await run('$("room-settings-dismiss").click()');
        await browser.viewport(page,1360,1000);
        await run('$("theater").click();scrollTo(0,400)'); await shot('theater-light-pink');
        const guest = await browser.page(config.publicUrl + '/watch?demo=guest');
        await browser.until(guest,'me?.durableRooms && transport?.ready && $("lobby-rooms").querySelector("button")','Guest login');
        await browser.evaluate(guest,'document.querySelector("#lobby-rooms button").click()');
        await browser.until(guest,'state?.roomName==="Shared controls room"','Guest joins');
        assert.equal(await browser.evaluate(guest,'!$("room-quick-switches").hidden && $("room-quick-switches").querySelectorAll("input,button").length===0 && $("room-quick-switches").querySelectorAll(".watch-switch-pill.is-readonly").length===3'),true);
        assert.match(await browser.evaluate(guest,'$("room-visibility").title'),/authorized room managers/);
        await browser.until(guest,'$("room-participants").children.length===2','Participant roster updates');
        const guestId = await browser.evaluate(guest,'me.account.id');
        await run('document.querySelector("[data-quick-permission=playPause]").click()');
        await until('state.participantPermissions.playPause && $("room-quick-status").textContent==="Saved"','Permission badge enabled');
        await browser.until(guest,'$("room-quick-switches").firstElementChild.classList.contains("is-on") && $("room-quick-switches").querySelectorAll("input,button").length===0','Read-only On badge has no switch');
        await browser.viewport(guest,390,844);
        await browser.screenshot(guest,path.resolve('artifacts/shared-controls-' + name + '-after-switch-pill-badges-on.png'));
        await run('document.querySelector("[data-quick-permission=playPause]").click()');
        await until('!state.participantPermissions.playPause && $("room-quick-status").textContent==="Saved"','Permission badge restored');
        assert.equal(await browser.evaluate(guest,'$("room-participants").firstElementChild.dataset.personId'),guestId);
        await browser.evaluate(guest,'roomUI.open(selected,"people")');
        await browser.until(guest,'$("room-settings-dialog").open && $("room-current-people").children.length===2','Settings participant roster');
        assert.equal(await browser.evaluate(guest,'$("room-current-people").firstElementChild.dataset.personId'),guestId);
        assert.deepEqual(await browser.evaluate(guest,'[...$("room-current-people").children].map(e=>e.dataset.personId)'),await browser.evaluate(guest,'[...$("room-participants").children].map(e=>e.dataset.personId)'));
        await browser.evaluate(guest,'$("room-settings-dismiss").click()');
        await browser.viewport(guest,390,844);
        await browser.screenshot(guest,path.resolve('artifacts/shared-controls-' + name + '-after-participants-phone.png'));
        await browser.activate(page);
        await until('state?.participants?.some(p=>p.id===' + JSON.stringify(guestId) + ' && p.present)','Host sees connected guest');
        await run('$("theater").click();scrollTo(0,0);document.documentElement.dataset.theme="dark";document.documentElement.dataset.accent="orange"');
        await pause(200); await shot('participants-desktop');
        assert.equal(await run('$("current-room-meta")===null && $("room-participants-title")===null'),true);
        assert.equal(await run('getComputedStyle($("room-participants")).height'),'320px');
        assert.equal(await run('(()=>{const c=document.querySelector(".room-controls-column").getBoundingClientRect(),r=document.querySelector(".room-participant-column").getBoundingClientRect();return Math.abs(c.width/r.width-2/3)<.01})()'),true);
        assert.equal(await browser.evaluate(guest,'$("room-participants").classList.contains("can-host") || $("room-participants").classList.contains("can-kick")'),false);
        assert.equal(await run('[...$("room-participants").children].every(row=>getComputedStyle(row).borderBottomWidth==="0px" && row.getBoundingClientRect().height===40)'),true);
        const hostButton = 'room-roster-host-' + guestId;
        await run('$("' + hostButton + '").click()');
        await until('state.participants.some(p=>p.id===' + JSON.stringify(guestId) + ' && p.role==="host")','Inline host assignment');
        await run('$("' + hostButton + '").click()');
        await until('state.participants.some(p=>p.id===' + JSON.stringify(guestId) + ' && p.role==="viewer")','Inline host removal');
        await run('$("room-kick-' + guestId + '").click()');
        await until('$("room-confirm-dialog").open','Kick confirmation');
        await run('$("room-confirm-dialog").querySelector("button[value=cancel]").click()');
        assert.equal(await browser.evaluate(guest,'!!selected && !!state'),true,'Cancel keeps participant connected');
        await run('$("room-kick-' + guestId + '").click()');
        await until('$("room-confirm-dialog").open','Kick confirmation again');
        await run('$("room-confirm-yes").click()');
        await browser.until(guest,'!selected && !state','Kicked viewer returns to lobby');
        await pause(1200);
        assert.equal(await browser.evaluate(guest,'!selected && !state'),true,'Subscription does not silently rejoin');
        await browser.evaluate(guest,'document.querySelector("#lobby-rooms button").click()');
        await browser.until(guest,'!!state && !!selected','Manual rejoin after kick');
        await run('roomUI.open(selected,"people")');
        await until('!!$("room-settings-kick-' + guestId + '")','Settings kick action');
        await run('$("room-settings-kick-' + guestId + '").click()');
        await until('$("room-confirm-dialog").open','Settings kick confirmation');
        await run('$("room-confirm-yes").click()');
        await browser.until(guest,'!selected && !state','Settings kick removes viewer');
        await until('$("room-settings-status").textContent==="Participant removed"','Settings kick feedback');
        await run('$("room-settings-dismiss").click()');
        await browser.evaluate(guest,'document.querySelector("#lobby-rooms button").click()');
        await browser.until(guest,'!!selected && !!state','Manual rejoin after Settings kick');
        await run(`globalThis.realParticipants=state.participants;globalThis.realMessage=transport.onMessage;
          transport.onMessage=message=>{if(message.type!=='state')realMessage(message)};
          state.participants=Array.from({length:35},(_,i)=>({id:crypto.randomUUID(),name:'Very long fixture participant username '+i,role:i%4===0?'host':'viewer',present:false}));roomUI.render();`);
        await until('!$("room-participants-expand").hidden','Overflow expander');
        assert.equal(await run('(()=>{const b=$("room-participants-expand"),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("button")===b})()'),true,'Expander is visible and hit-testable');
        assert.equal(await run('getComputedStyle($("room-participants").querySelector(".room-roster-name")).textOverflow'),'ellipsis');
        await shot('roster-overflow');
        await run('$("room-participants").scrollTop=$("room-participants").scrollHeight');
        assert.equal(await run('$("room-participants").lastElementChild.getBoundingClientRect().bottom <= $("room-participants-expand").getBoundingClientRect().top + 1'),true,'Gutter protects final row');
        await run('$("room-participants-expand").click()');
        assert.equal(await run('getComputedStyle($("room-participants")).height'),'640px');
        await shot('roster-expanded');
        await run('$("options-collapse").click()');
        assert.equal(await run('$("room-participants-expand").getAttribute("aria-expanded")'),'false');
        await run('$("options-collapse").click();state.participants=realParticipants;transport.onMessage=realMessage;roomUI.render()');
      }
      console.log(name + ': ' + label + ' Room desktop/390px/320px and permissions captures complete');
    } catch (error) {
      if (browser && page) console.error(await browser.evaluate(page,'({controls:typeof uburoomControls,identity:typeof me!=="undefined"?!!me:false,room:typeof state!=="undefined"?state?.roomName:null,status:$("room-settings-status")?.textContent,preset:$("room-permission-preset").value,focus:document.activeElement.id,buttons:[...$("room-permission-preset-group").children].map(b=>({text:b.textContent,disabled:b.disabled,pressed:b.getAttribute("aria-pressed")}))})'));
      throw error;
    } finally { await browser?.close(); await app.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
