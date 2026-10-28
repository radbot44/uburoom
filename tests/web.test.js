'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createApp } = require('../server/app');
const certFile = path.join(__dirname,'../certs/server-cert.pem');
test('removed endpoints are unavailable while the watch page still serves', { skip: !fs.existsSync(certFile) }, async t => {
  const cert=fs.readFileSync(certFile),key=fs.readFileSync(path.join(__dirname,'../certs/server-key.pem'));
  const app=createApp({cert,key,publicUrl:'https://localhost:5756',ownerId:'owner',guildId:'guild',channels:['commands']});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const port=app.server.address().port;
  async function request(route,method='GET') {
    return new Promise((resolve,reject)=>{
      const req=https.request({hostname:'localhost',port,path:route,method,ca:cert,headers:{Origin:'https://localhost:5756'}},res=>{
        let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
      });req.on('error',reject);req.end();
    });
  }
  const watchRes = await request('/watch');
  assert.equal(watchRes.status, 200);
  assert.equal(watchRes.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  assert.ok(watchRes.headers['content-security-policy'].includes("font-src 'self'"));
  const fontRes = await request('/assets/fonts/UburoomSans-Regular.woff2');
  assert.equal(fontRes.status, 200);
  assert.equal(fontRes.headers['content-type'], 'font/woff2');
  for (const path of ['/remote-ui.js','/viewport.js','/api/login/start','/api/login/finish','/api/devices/revoke']) {
    const method=path.startsWith('/api/')?'POST':'GET';
    assert.equal((await request(path,method)).status,404,path);
  }
  assert.equal((await request('/picture.js')).status,200);
  assert.equal((await request('/watch-feedback.js')).status,200);
});
