'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname,'..');

test('legacy client code and public routes are absent from the repository',()=>{
  for(const name of ['server/login.js','web/remote-ui.js','shared/viewport.js','scripts/remote-compatibility.js','docs/remote-protocol.md','tests/remote-protocol.test.js','tests/fixtures/remote-protocol-v1.json'])
    assert.equal(fs.existsSync(path.join(root,name)),false,name);
  const html=fs.readFileSync(path.join(root,'web/watch.html'),'utf8');
  assert.doesNotMatch(html,/remote-ui\\.js|viewport\\.js|id=\"remote\"/);
  assert.match(html,/picture\\.js/);
  assert.match(html,/watch-feedback\\.js/);
});

test('live documentation contains no old client references',()=>{
  const docs=['AGENTS.md','README.md','ROADMAP.md','SPEC.md'];
  function visit(folder){for(const entry of fs.readdirSync(path.join(root,folder),{withFileTypes:true})){
    const name=path.posix.join(folder,entry.name);
    if(entry.isDirectory()){if(name==='docs/archive')continue;visit(name);}
    else if(entry.isFile() && /\\.md$/.test(name))docs.push(name);
  }}
  visit('docs');
  for(const name of docs)assert.doesNotMatch(fs.readFileSync(path.join(root,name),'utf8'),/\\bremote\\b|uburoom-remote|remote-ui\\.js|viewport\\.js/i,name);
});
