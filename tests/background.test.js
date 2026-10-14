'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto, randomUUID } = require('node:crypto');
const Engine = require('../extension/engine');

async function extension(saved, serverOrigins) {
  const sockets = [], timers = new Map(); let nextTimer = 0, onConnect, onMessage;
  const event = register => ({ addListener: register || (() => {}) });
  const browser = {
    storage: { local: { get: async () => ({...saved}), set: async value => Object.assign(saved,value), remove: async key => delete saved[key] } },
    runtime: { getURL: file => 'moz-extension://fixture/'+file, onConnect:event(fn=>onConnect=fn), onMessage:event(fn=>onMessage=fn) },
    tabs: { query:async()=>[{id:1}], onRemoved:event(), sendMessage:async()=>({status:'applied'}), create:async()=>{} },
    sessions:{getTabValue:async()=>'',setTabValue:async()=>{}}
  };
  class Socket {
    static OPEN = 1;
    constructor(url){this.url=url;this.readyState=1;this.sent=[];sockets.push(this);}
    send(raw){this.sent.push(JSON.parse(raw));}
    close(){this.readyState=3;this.onclose?.();}
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background'),'utf8'),{
    browser,RadTV:Engine,WebSocket:Socket,crypto:webcrypto,URL,URLSearchParams,TextEncoder,Uint8Array,UBUROOM_REMOTE_SERVERS:serverOrigins,
    setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,console
  });
  await new Promise(resolve=>setImmediate(resolve));
  const ws=sockets[0];assert.ok(ws);ws.onopen();
  const receive=async message=>ws.onmessage({data:JSON.stringify(message)});
  await receive({type:'auth-ok'});
  await receive({type:'sharing-options',available:true,ownerName:'Alice'});
  await receive({type:'voice-state',sequence:1,available:true,joined:false,channelId:'voice',serverNow:Date.now(),expiresAt:Date.now()+3000});
  async function player(tabId = 1) {
    let listen,disconnect;const messages=[],id=randomUUID();
    const port={name:'radtv-player',sender:{tab:{id:tabId},frameId:0,url:'https://tv.youtube.com/'},
      postMessage:m=>messages.push(m),onMessage:event(fn=>listen=fn),onDisconnect:event(fn=>disconnect=fn)};
    onConnect(port);await listen({type:'hello',sessionId:id});await listen({type:'presence',reachable:true,state:{picture:{...Engine.DEFAULT}}});
    const report=ws.sent.findLast(m=>m.type==='session');
    await receive({type:'session-ack',sessionId:id,epoch:report.epoch,serverNow:Date.now(),live:false});
    return {id,messages,disconnect,state:()=>messages.findLast(m=>m.type==='remote-state')};
  }
  return {ws,receive,player,sockets,timers,command:(id,command)=>onMessage({type:'local-command',sessionId:id,command},{url:'moz-extension://fixture/popup.html'})};
}

test('remembered On join survives fresh background and tab sessions, without restoring consent or replaying voice snapshots', async () => {
  const saved={deviceId:randomUUID(),credential:'a'.repeat(64),serverUrl:'https://localhost:6767'};
  const first=await extension(saved),tab=await first.player();
  assert.equal(tab.state().autoJoin,false);assert.equal(tab.state().enabled,false);
  assert.equal((await first.command(tab.id,{action:'session.autojoin',args:{enabled:true}})).status,'applied');
  assert.equal(saved.autoJoin,true,'preference is written to private extension storage');
  tab.disconnect();
  const replacement=await first.player();assert.equal(replacement.state().autoJoin,true);assert.equal(replacement.state().enabled,false);
  const restarted=await extension(saved),newTab=await restarted.player();
  assert.equal(newTab.state().autoJoin,true,'new background loads remembered preference before hello');
  assert.equal(newTab.state().enabled,false,'already-in-call baseline does not enable a new tab');
  await restarted.receive({type:'voice-state',sequence:2,available:true,joined:true,channelId:'voice',serverNow:Date.now()-4000,expiresAt:Date.now()-1000});
  assert.equal(newTab.state().enabled,false,'expired joins are discarded');
  await restarted.receive({type:'voice-state',sequence:3,available:true,joined:true,channelId:'other-call',serverNow:Date.now(),expiresAt:Date.now()+3000});
  assert.equal(newTab.state().enabled,true,'fresh join enables the opted-in tab');
  await restarted.command(newTab.id,{action:'session.disable'});
  await restarted.receive({type:'voice-state',sequence:3,available:true,joined:true,channelId:'other-call',serverNow:Date.now(),expiresAt:Date.now()+3000});
  assert.equal(newTab.state().enabled,false,'duplicate voice events cannot override a later manual disable');
  const extra=await restarted.player(2);await restarted.command(newTab.id,{action:'session.autojoin',args:{enabled:false}});
  assert.equal(extra.state().autoJoin,false,'device preference is consistent across existing tabs');
  assert.equal(saved.autoJoin,false);assert.equal(extra.state().enabled,false);
});

test('a configured upgrade retains the paired device and exact stored origin with remote consent off', async () => {
  const saved = { deviceId: randomUUID(), credential: 'a'.repeat(64), serverUrl: 'https://legacy.example', autoJoin: true };
  const original = { ...saved };
  const upgraded = await extension(saved, ['https://watch.example', 'https://legacy.example']);
  assert.equal(upgraded.ws.url, 'wss://legacy.example/ws');
  assert.deepEqual(saved, original);
  const tab = await upgraded.player();
  assert.equal(tab.state().enabled, false);
  assert.equal(tab.state().live, false);
  assert.equal(tab.state().autoJoin, true);
});
