'use strict';
const https = require('node:https');
const { WebSocket } = require('ws');

// Integration fixtures retain authenticated sockets, just like a browser tab.
// HTTP bootstrap/media requests remain in each fixture's ordinary HTTP helper.
function controlClient(t, config, cert) {
  const clients = new Map();
  const handles = path => /^\/api\/(?:rooms|command|watch\/(?:rooms|admin-mode))(?:[/?]|$)/.test(path);
  t.after(() => { for (const client of clients.values()) client.ws?.terminate(); });
  async function request(path, data, supplied = {}) {
    const headers = Object.fromEntries(Object.entries({ Origin: config.publicUrl, ...supplied }).map(([key,value]) => [key.toLowerCase(),value]));
    if (headers.cookie && !headers['x-csrf-token'] && data === undefined) {
      headers['x-csrf-token'] = await new Promise((resolve,reject) => {
        const req = https.get(config.publicUrl + '/api/watch/me', { ca: cert, headers }, res => {
          let raw = ''; res.on('data', bytes => raw += bytes);
          res.on('end', () => resolve(JSON.parse(raw).csrf));
        }); req.on('error', reject);
      });
    }
    const key = JSON.stringify(headers);
    let client = clients.get(key);
    if (!client || client.ws.readyState >= 2) {
      client = { pending: new Map(), sequence: 0 }; clients.set(key, client);
      const ws = client.ws = new WebSocket(config.publicUrl.replace('https:', 'wss:') + '/watch-socket', { ca: cert, origin: headers.origin, headers: headers.cookie ? {Cookie:headers.cookie} : {} });
      client.auth = new Promise(resolve => {
        const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 5000);
        ws.on('open', () => ws.send(JSON.stringify({ type:'auth', token:headers.authorization?.replace(/^Bearer /,''), csrf:headers['x-csrf-token'] })));
        ws.on('message', raw => {
          const message = JSON.parse(raw);
          if (message.type === 'auth-ok') { clearTimeout(timer); client.heartbeat = setInterval(() => { if(ws.readyState === 1) ws.send(JSON.stringify({type:'clock',id:0})); },1000); resolve(true); }
          if (message.type === 'unavailable') client.denial = message;
          if (message.type === 'response') client.pending.get(message.id)?.(message);
        });
        ws.on('error', () => {});
        ws.on('close', () => { clearInterval(client.heartbeat); clearTimeout(timer); resolve(false); for (const done of client.pending.values()) done({status:401,value:{error:'Connection closed'}}); });
      });
    }
    if (!await client.auth) return { status:client.denial?.status || 401, body:client.denial?.value || {error:'Authentication failed'}, headers:{} };
    return new Promise((resolve,reject) => {
      const id = ++client.sequence;
      const timer = setTimeout(() => { client.pending.delete(id); reject(new Error('Control fixture timed out: ' + path)); }, 15000);
      client.pending.set(id, message => { clearTimeout(timer); client.pending.delete(id); resolve({status:message.status,body:message.value,headers:{}}); });
      client.ws.send(JSON.stringify({type:'request',id,path,...(data === undefined ? {} : {data})}));
    });
  }
  return { handles, request };
}
module.exports = { controlClient };
