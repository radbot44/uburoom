'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { badgeDetails } = require('../extension/remote-ui');
const { DEFAULT } = require('../extension/engine');

test('badges describe applied state, resolved toggles and actual seek distances; queries stay silent', () => {
  const state = { picture: { ...DEFAULT, zoom: 1.235, stretchX: 1.11, x: -.025 }, volume: 63, paused: true };
  assert.equal(badgeDetails({ action:'zoom.set', args:{value:2} }, state).value, '123.5%', 'report applied scale rather than the requested value');
  assert.equal(badgeDetails({ action:'stretch.adjust', args:{axis:'stretchX',delta:.01} }, state).color, '#FF9954');
  assert.equal(badgeDetails({ action:'media.volume.set', args:{percent:70} }, state).value, '63%');
  assert.equal(badgeDetails({ action:'media.toggle' }, state).symbol, 'pause');
  assert.equal(badgeDetails({ action:'media.toggle' }, { ...state,paused:false }).symbol, 'play');
  assert.deepEqual(badgeDetails({ action:'media.seek.relative', args:{seconds:-60} }, state),
    {symbol:'back',value:'',label:'Seek back',color:'#F8F7F4',seekSeconds:60});
  assert.equal(badgeDetails({ action:'pan.step',args:{axis:'x',sign:-1} }, state).value, 'X -2.5%');
  assert.equal(badgeDetails({ action:'session.enable' }, state).value, 'Enabled', 'enabled does not claim confirmed reachability');
  for (const action of ['status.get','help.get']) assert.equal(badgeDetails({action},state),undefined);
});
