'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {watchPage}=require('../server/watch-page');
const template=fs.readFileSync(path.join(__dirname,'../web/watch.html'),'utf8');

test('personalized page includes visible authorized rooms and inert safely escaped bootstrap data',()=>{
  const name='</script><img src=x onerror="attack()"> & room';
  const initial={config:{clientId:'</script>\u2028'},me:{status:200,value:{durableRooms:true}},rooms:{status:200,value:{rooms:[{id:'room',name,title:name,viewers:1}]}}};
  const html=watchPage(template,initial);
  assert.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=&quot;attack()&quot;&gt; &amp; room'));
  assert.ok(!html.includes(name));
  assert.ok(html.includes('href="/room/room"'));
  assert.ok(!html.includes('id="room-lobby" hidden'));
  assert.ok(html.includes('id="auth-overlay" class="lobby-auth" hidden'));
  const data=JSON.parse(/<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(data,initial);
  assert.ok(!html.includes('<script>attack()'),'No executable bootstrap script is generated');
});

test('unauthenticated page contains no personalized room rows and retains inline sign-in',()=>{
  const html=watchPage(template,{config:{},me:{status:401,value:{error:'Sign in'}}});
  assert.ok(html.includes('id="room-lobby" hidden'));
  assert.ok(!html.includes('/room/'));
  assert.ok(html.includes('id="welcome"'));
});


test('watch page threads the supplied CSP style nonce only to its scrollbar initializer',()=>{
  const html=watchPage(template,{config:{},me:{status:401,value:{error:'Sign in'}}},'testNonce1234==');
  assert.match(html, /<script src="\/watch-scrollbars\.js" data-os-style-nonce="testNonce1234=="><\/script>/);
  assert.ok(!html.includes('<style nonce="testNonce1234=="'), 'the nonce is not applied to arbitrary inline styles');
});

test('watch page includes audio mode controls and option captions', () => {
  const html = watchPage(template, { config: {}, me: { status: 401, value: { error: 'Sign in' } } });
  assert.ok(html.includes('id="audio-mode"'));
  assert.ok(html.includes('id="audio-mode-group"'));
  assert.ok(html.includes('data-caption="Original dynamic range"'));
  assert.ok(html.includes('data-caption="Boosts speech clarity"'));
  assert.ok(html.includes('data-caption="Levels peaks for quiet listening"'));
});

test('watch page includes chapter selection, tooltip, and skip marker controls', () => {
  const html = watchPage(template, { config: {}, me: { status: 401, value: { error: 'Sign in' } } });
  assert.ok(html.includes('id="chapters"'));
  assert.ok(html.includes('id="timeline-tooltip"'));
  assert.ok(html.includes('id="skip-marker"'));
  assert.ok(html.includes('id="skip-marker-label"'));
});

test('watch page includes Picture-in-Picture button, placeholder, and icon', () => {
  const html = watchPage(template, { config: {}, me: { status: 401, value: { error: 'Sign in' } } });
  assert.ok(html.includes('id="pip"'));
  assert.ok(html.includes('id="pip-placeholder"'));
  assert.ok(html.includes('id="pip-return"'));
  const icons = require('../web/icons.js');
  assert.equal(icons.resolveName('pip'), 'picture-in-picture');
  assert.ok(icons.glyphs['picture-in-picture']);
});

test('room roster renders sync-quality as interactive telemetry button and supports telemetry popovers', () => {
  const roomsUi = require('../web/watch-rooms-ui.js');
  assert.ok(typeof roomsUi.mount === 'function');
  const css = fs.readFileSync(path.join(__dirname, '../web/watch.css'), 'utf8');
  assert.ok(css.includes('.viewer-telemetry-card'));
  assert.ok(css.includes('.telemetry-status-pill'));
  assert.ok(css.includes('#room-participants .room-roster-sync-quality'));
});
