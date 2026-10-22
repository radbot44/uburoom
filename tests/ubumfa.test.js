'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {generateName, ubumfa, roomName} = require('../web/ubumfa');

const wordPattern = word => word.replace(/[AEIOU]/g, 'v').replace(/[A-Z]/g, 'C').replace(/v/g, 'V');

test('Ubumfa covers every pattern and distinct adjacent vowels', () => {
  const patterns = ['CVCVCV', 'CVCVVC', 'CVVCCV', 'CVVCVC', 'VCCVCV', 'VCCVVC', 'VCVCCV', 'VCVCVC'];
  for (let pattern = 0; pattern < patterns.length; pattern++) {
    for (let draw = 0; draw < 200; draw++) {
      let first = true;
      const word = generateName(() => { if (first) { first = false; return pattern / 8; } return draw / 200; });
      assert.equal(word.length, 6);
      assert.equal(wordPattern(word), patterns[pattern]);
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

test('arbitrary lengths follow two-letter vowel/consonant blocks and distinct vowels', () => {
  for (const length of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 64]) {
    for (let trial = 0; trial < 100; trial++) {
      const word = generateName(length);
      const pattern = wordPattern(word);
      assert.equal(word.length, length);
      assert.match(word, /^[A-Z]+$/);
      for (let i = 0; i + 1 < length; i += 2) {
        assert.ok(pattern.slice(i, i + 2) === 'CV' || pattern.slice(i, i + 2) === 'VC');
      }
      if (length % 2 && length > 1) assert.notEqual(pattern[length - 1], pattern[length - 2]);
      for (let i = 0; i + 1 < length; i++) {
        if (pattern.slice(i, i + 2) === 'VV') assert.notEqual(word[i], word[i + 1]);
      }
    }
  }
  assert.equal(generateName(3, () => 0), 'BAB');
  assert.equal(generateName(4, () => 0), 'BABA');
  const orientationDraws = [0, 0.99, 0, 0.99, 0, 0.99];
  const clustered = generateName(12, () => orientationDraws.shift() ?? 0);
  assert.equal(wordPattern(clustered), 'CVVCCVVCCVVC');
  assert.equal(clustered.length, 12);
});

test('ubumfa returns title-cased words matching each requested length', () => {
  for (const lengths of [[3, 6, 3], [1, 2, 3, 4, 5, 6, 7], [12, 9], [6]]) {
    const words = ubumfa(...lengths).split(' ');
    assert.equal(words.length, lengths.length);
    words.forEach((word, i) => assert.match(word, new RegExp(`^[A-Z][a-z]{${lengths[i] - 1}}$`)));
  }
  assert.match(ubumfa(), /^[A-Z][a-z]{5}$/);
  assert.match(roomName(), /^Room [A-Z][a-z]{5}$/);
});

test('invalid requested lengths are rejected', () => {
  for (const length of [0, -1, 2.5, NaN, Infinity, '6', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => generateName(length), RangeError);
    assert.throws(() => ubumfa(3, length), RangeError);
  }
});
