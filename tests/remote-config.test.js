'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { serverOrigin, configureRemote } = require('../scripts/configure-remote');

test('remote configuration rejects insecure, credentialed and unbounded destinations', () => {
  for (const url of ['http://watch.example', 'https://user:password@watch.example', 'https://watch.example/path', 'https://watch.example/?token=secret', 'https://watch.example/#fragment', 'https://*.example', 'https://[::1]']) assert.throws(() => serverOrigin(url));
  assert.equal(serverOrigin('https://WATCH.example:8443/'), 'https://watch.example:8443');
  assert.throws(() => configureRemote([]));
  assert.throws(() => configureRemote(['https://watch.example'], path.resolve(__dirname, '../extension')));
});

test('configured remote narrows both network policy and permissions while preserving installed identity', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-remote-config-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'extension');
  configureRemote(['https://watch.example:8443', 'https://legacy.example', 'https://watch.example:8443'], destination);
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json')));
  assert.equal(manifest.browser_specific_settings.gecko.id, 'uburoom@uburoom.com');
  assert.deepEqual(manifest.host_permissions, ['https://tv.youtube.com/*', 'https://watch.example/*', 'https://legacy.example/*']);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src https://watch.example:8443 wss://watch.example:8443 https://legacy.example wss://legacy.example");
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(destination, 'server-config.js'), 'utf8'), context);
  assert.deepEqual(Array.from(context.UBUROOM_REMOTE_SERVERS), ['https://watch.example:8443', 'https://legacy.example']);
  assert.throws(() => configureRemote(['https://other.example'], destination), 'existing build is never overwritten');
});
