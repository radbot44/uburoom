'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Engine = require('../extension/engine');
const Room = require('../extension/room-protocol');
const Viewport = require('../extension/viewport');
const fixture = require('./fixtures/remote-protocol-v1.json');
const plain = value => JSON.parse(JSON.stringify(value));

function checkContract(engine, room, viewport) {
  assert.deepEqual(plain(engine.PROTOCOL), fixture.protocol);
  for (const { domain, input, args } of fixture.accepted) {
    const expected = { action: input.action, args };
    assert.deepEqual(plain(engine.validate(input)), expected);
    assert.deepEqual(plain((domain === 'room' ? room : viewport).validate(input)), expected);
    assert.throws(() => (domain === 'room' ? viewport : room).validate(input), input.action + ' crosses domains');
  }
  for (const input of fixture.rejected) {
    assert.throws(() => engine.validate(input), JSON.stringify(input));
    assert.throws(() => room.validate(input));
    assert.throws(() => viewport.validate(input));
  }
  for (const { state, command, expected } of fixture.pictures) {
    assert.deepEqual(plain(viewport.picture(state, command)), expected);
    assert.deepEqual(plain(engine.picture(state, command)), expected);
  }
  for (const value of [undefined, null, 1, {}, { room: 1 }, { room: '1', viewport: 1 }, { room: 2, viewport: 1 }, { room: 1, viewport: 2 }]) {
    assert.equal(engine.protocolCompatible(value), false);
  }
  assert.equal(engine.protocolCompatible(fixture.protocol), true);
  assert.throws(() => engine.validate({ action: 'zoom.set', args: { value: NaN } }));
  assert.throws(() => engine.validate({ action: 'media.volume.set', args: { percent: Infinity } }));
}

test('versioned protocol fixtures cover Node dispatch and independent room/viewport contracts', () => {
  checkContract(Engine, Room, Viewport);
});

test('the same protocol fixtures run as browser scripts without Node, DOM or network APIs', () => {
  const context = vm.createContext({});
  for (const file of ['room-protocol.js', 'viewport.js', 'engine.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context, { filename: file });
  }
  checkContract(context.uburoom, context.uburoomRoomProtocol, context.uburoomViewport);
});
