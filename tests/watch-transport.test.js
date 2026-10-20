'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

test('clock recovery tolerates delayed background callbacks, bounds samples and closes a silent foreground connection',async()=>{
  let now=0;const timers=new Map();let sequence=0;
  class Socket {
    constructor(){this.readyState=0;this.sent=[];}
    send(raw){this.sent.push(JSON.parse(raw));}
    close(code,reason){this.readyState=3;this.onclose?.({code,reason,wasClean:true});}
  }
  const ctx={WebSocket:Socket,setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>++sequence,clearInterval:()=>{},Date:{now:()=>now},DOMException,TypeError};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/watch-transport.js'),'utf8'),ctx);
  let closed;
  const transport=new ctx.uburoomWatchTransport({url:'wss://fixture.invalid',identity:()=>({}),onClose:details=>{closed=details;}});
  const connected=transport.connect(),socket=transport.socket;socket.readyState=1;socket.onopen();
  socket.onmessage({data:JSON.stringify({type:'auth-ok'})});await connected;
  for(let i=0;i<20;i++)transport.clock();
  assert.equal(transport.pending.size,1,'one outstanding clock sample');
  const timeout=[...timers.values()].find(timer=>timer.ms===30000);
  now=60000;timeout.fn();assert.equal(socket.readyState,1,'late timer does not disconnect a waking tab');
  transport.clock();const request=socket.sent.at(-1);
  socket.onmessage({data:JSON.stringify({type:'clock',id:request.id,serverNow:now})});
  assert.equal(transport.pending.size,0,'fresh clock exchange succeeds after waking');
  transport.clock();const silentTimer=[...timers.values()].at(-1);
  now+=30000;silentTimer.fn();
  assert.equal(socket.readyState,3,'an on-time timeout detects a silent connection');
  assert.equal(closed.code,4000);assert.equal(closed.reason,'Server heartbeat timed out');
  transport.close();
});
test('browser disconnect rejects in-flight controls, never replays them, and allows a fresh authorized request',async()=>{
  const sockets=[];
  class Socket {
    constructor(){this.readyState=0;this.sent=[];sockets.push(this);}
    send(raw){this.sent.push(JSON.parse(raw));}
    close(){this.readyState=3;this.onclose?.();}
    ready(){this.readyState=1;this.onopen();this.onmessage({data:JSON.stringify({type:'auth-ok'})});}
  }
  const ctx={WebSocket:Socket,setTimeout,clearTimeout,setInterval,clearInterval,Date,DOMException,TypeError};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/watch-transport.js'),'utf8'),ctx);
  const transport=new ctx.uburoomWatchTransport({url:'wss://fixture.invalid/watch-socket',identity:()=>({token:'secret'})});
  const connected=transport.connect();sockets[0].ready();await connected;
  const command=transport.request('/api/watch/rooms/id/command',{command:{action:'media.play'}});
  const rejected=assert.rejects(command,/connection lost/);transport.close();await rejected;
  await assert.rejects(transport.request('/api/watch/rooms/id/command',{}),/unavailable/);
  const again=transport.connect();sockets[1].ready();await again;
  assert.equal(sockets[1].sent.some(message=>message.type==='request'),false,'authentication and clock traffic do not replay a previous command');
  const fresh=transport.request('/api/watch/rooms/id/command',{command:{action:'media.pause'}}),message=sockets[1].sent.at(-1);
  sockets[1].onmessage({data:JSON.stringify({type:'response',id:message.id,status:200,value:{status:'applied'}})});
  assert.equal((await fresh).status,'applied');transport.close();
});
