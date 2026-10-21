'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {generateName, roomName} = require('../web/ubumfa');

test('Ubumfa covers every pattern and distinct adjacent vowels', () => {
  const patterns = ['CVCVCV', 'CVCVVC', 'CVVCCV', 'CVVCVC', 'VCCVCV', 'VCCVVC', 'VCVCCV', 'VCVCVC'];
  for (let pattern = 0; pattern < patterns.length; pattern++) {
    for (let draw = 0; draw < 200; draw++) {
      let first = true;
      const word = generateName(() => { if (first) { first = false; return pattern / 8; } return draw / 200; });
      assert.equal(word.length, 6);
      assert.equal(word.replace(/[AEIOU]/g, 'v').replace(/[A-Z]/g, 'C').replace(/v/g, 'V'), patterns[pattern]);
      const vv = patterns[pattern].indexOf('VV');
      if (vv !== -1) assert.notEqual(word[vv], word[vv + 1]);
    }
  }
  assert.match(roomName(), /^Room [A-Z][a-z]{5}$/);
});

test('literal V in a consonant pair remains a consonant', () => {
  const draws = [4 / 8, 0.999999, 0, 0, 0];
  assert.equal(generateName(() => draws.shift() ?? 0), 'AZVABA');
});
