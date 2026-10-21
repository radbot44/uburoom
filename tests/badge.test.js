'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { badgeDetails } = require('../web/remote-ui');
const { DEFAULT } = require('../shared/engine');
const icons = require('../web/icons');

test('badges describe applied state, resolved toggles and actual seek distances; queries stay silent', () => {
  const state = { picture: { ...DEFAULT, zoom: 1.235, stretchX: 1.11, x: -.025 }, volume: 63, paused: true };
  assert.equal(badgeDetails({ action:'zoom.set', args:{value:2} }, state).value, '123.5%', 'report applied scale rather than the requested value');
  assert.equal(badgeDetails({ action:'stretch.adjust', args:{axis:'stretchX',delta:.01} }, state).color, 'var(--accent-text)');
  assert.equal(badgeDetails({ action:'media.volume.set', args:{percent:70} }, state).value, '63%');
  assert.equal(badgeDetails({ action:'media.volume.set', args:{percent:70} }, state).symbol, 'volume');
  assert.equal(badgeDetails({ action:'media.mute' }, state).symbol, 'volume-off');
  assert.equal(badgeDetails({ action:'media.volume.set', args:{percent:8} }, {...state,volume:8}).symbol, 'volume-4');
  assert.equal(badgeDetails({ action:'media.volume.set', args:{percent:70} }, {...state,muted:true}).symbol, 'volume-off');
  assert.equal(badgeDetails({ action:'media.unmute' }, {...state,muted:true}).symbol, 'volume');
  for (const [action,args] of [['media.mute',{}],['media.unmute',{}],['media.volume.set',{percent:70}],['media.seek.relative',{seconds:-60}]]) {
    const badge = badgeDetails({action,args},state);
    assert.ok(icons.resolveName(badge.symbol,badge.seekSeconds), action + ' uses a bundled Tabler icon');
  }
  assert.equal(badgeDetails({ action:'media.toggle' }, state).symbol, 'pause');
  assert.equal(badgeDetails({ action:'media.toggle' }, { ...state,paused:false }).symbol, 'play');
  assert.deepEqual(badgeDetails({ action:'media.seek.relative', args:{seconds:-60} }, state),
    {symbol:'back',value:'',label:'Seek back',color:'var(--text)',seekSeconds:60});
  assert.equal(badgeDetails({ action:'media.seek.relative',args:{seconds:-42} }, state).value, '42s', 'non-standard seeks show the real distance');
  assert.equal(badgeDetails({ action:'pan.step',args:{axis:'x',sign:-1} }, state).value, 'X -2.5%');
  assert.equal(badgeDetails({ action:'room.enable' }, state).value, 'Enabled', 'enabled does not claim confirmed reachability');
  for (const action of ['status.get','help.get']) assert.equal(badgeDetails({action},state),undefined);
});
