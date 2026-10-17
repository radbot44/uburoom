'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
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
