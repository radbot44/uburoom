'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {createApp} = require('../server/app');
const certificate = path.join(__dirname,'../certs/server-cert.pem');

test('explicit diagnostic server serves codec assets and bounded fixture ranges', {skip:!fs.existsSync(certificate)}, async t => {
  const cert=fs.readFileSync(certificate);
  const app=createApp({cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'fixture',guildId:'fixture',channels:[],diagnostics:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const request=(route,method='GET',headers={})=>new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',servername:'localhost',port:app.server.address().port,path:route,method,ca:cert,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end();
  });
  const page=await request('/__diagnostics/codec');
  assert.equal(page.status,200);assert.match(page.body.toString(),/Copy diagnostics/);
  assert.match(page.headers['content-security-policy'],/media-src/);
  for(const asset of ['codec.js','codec.css'])assert.equal((await request('/__diagnostics/'+asset)).status,200);
  const media='/__diagnostics/media/sample.mp4';
  if(fs.existsSync(path.join(__dirname,'../assets/demo/sync-test.mp4'))){
    const range=await request(media,'GET',{Range:'bytes=0-15'});
    assert.equal(range.status,206);assert.equal(range.body.length,16);assert.equal(range.headers['content-type'],'video/mp4');
    const head=await request(media,'HEAD');assert.equal(head.status,200);assert.equal(head.body.length,0);
    assert.equal((await request(media,'GET',{Range:'bytes=999999999-'})).status,416);
  }else assert.equal((await request(media)).status,404,'missing fixtures fail truthfully');
  assert.equal((await request('/__diagnostics/media/private.mp4')).status,404);
  assert.equal((await request('/watch/test')).status,404);
  const watch=await request('/watch');
  assert.doesNotMatch(watch.body.toString(),/playback-dialog|playback-frame|__diagnostics/);
});
