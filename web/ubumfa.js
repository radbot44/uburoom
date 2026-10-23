/* Reusable display-word generator. Words are not unique identifiers or secrets. */
(function(root) {
  'use strict';
  const V = 'AEIOU';
  const C = 'BCDFGHJKLMNPQRSTVWXYZ';
  // Only these consonants may immediately precede X in a CC pair.
  const BEFORE_X = 'HLNRSWYXZ';
  const C_NO_X = C.replace('X', '');
  // A standalone consonant Y still cannot appear immediately after VV.
  const C_AFTER_VV = C.replace('Y', '');
  // A CC pair directly after VV cannot begin with H, W, or Y.
  const C_PAIR_AFTER_VV = C.replace(/[HWY]/g, '');
  // Every ordered pair of ordinary vowels is allowed, including doubles.
  const VOWEL_PAIRS = [...V].flatMap(a => [...V].map(b => a + b));
  const PATTERNS = ['CVCVCV', 'CVCVVC', 'CVVCCV', 'CVVCVC', 'VCCVCV', 'VCCVVC', 'VCVCCV', 'VCVCVC'];
  function patternForLength(length, rand) {
    // Every two letters contain one vowel and one consonant. The eight
    // original six-letter patterns are exactly the possible combinations.
    if (length === 6) return PATTERNS[rand(PATTERNS.length)];
    let pattern = '';
    for (let i = 0; i < Math.floor(length / 2); i++) {
      pattern += rand(2) === 0 ? 'CV' : 'VC';
    }
    if (length % 2) {
      // A final unmatched letter always alternates with its neighbor.
      pattern += pattern ? (pattern.endsWith('V') ? 'C' : 'V') : (rand(2) === 0 ? 'C' : 'V');
    }
    return pattern;
  }

  function vowelYAllowed(pattern, index) {
    if (index === 0 || index === pattern.length - 1) return true;
    // A vowel Y may sit between single consonants (CYC), but not
    // beside a double-consonant run (CCYC or CYCC).
    return pattern[index - 1] === 'C' && pattern[index + 1] === 'C' &&
      pattern[index - 2] !== 'C' && pattern[index + 2] !== 'C';
  }

  function followsVowelPair(pattern, index) {
    return index >= 2 && pattern[index - 2] === 'V' && pattern[index - 1] === 'V';
  }

  function consonantPair(rand, afterVV) {
    const starters = afterVV ? C_PAIR_AFTER_VV : C;
    // Select uniformly from allowed pairs without maintaining a pair list
    // or retrying invalid random draws.
    let count = 0;
    for (const first of starters) {
      count += BEFORE_X.includes(first) ? C.length : C_NO_X.length;
    }
    let n = rand(count);
    for (const first of starters) {
      const seconds = BEFORE_X.includes(first) ? C : C_NO_X;
      if (n < seconds.length) return first + seconds[n];
      n -= seconds.length;
    }
    throw new RangeError('Random draw out of range');
  }

  function generateWord(length, random) {
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new RangeError('Word length must be a positive safe integer');
    }
    const rand = n => Math.floor(random() * n);
    const p = patternForLength(length, rand), s = Array(length);

    // Fill vowels first. All AEIOU pairs are supported; Y remains
    // restricted to eligible single-vowel slots rather than vowel pairs.
    for (let vv = p.indexOf('VV'); vv !== -1; vv = p.indexOf('VV', vv + 2)) {
      const pair = VOWEL_PAIRS[rand(VOWEL_PAIRS.length)];
      s[vv] = pair[0]; s[vv + 1] = pair[1];
    }
    for (let i = 0; i < length; i++) {
      if (p[i] !== 'V' || s[i] !== undefined) continue;
      if (vowelYAllowed(p, i)) {
        // Each ordinary vowel has weight 3; vowel Y has weight 1.
        const n = rand(16);
        s[i] = n === 15 ? 'Y' : V[Math.floor(n / 3)];
      } else {
        s[i] = V[rand(V.length)];
      }
    }

    // All CC pairs are possible except for the two contextual restrictions.
    for (let cc = p.indexOf('CC'); cc !== -1; cc = p.indexOf('CC', cc + 2)) {
      const pair = consonantPair(rand, followsVowelPair(p, cc));
      s[cc] = pair[0]; s[cc + 1] = pair[1];
    }
    for (let i = 0; i < length; i++) {
      // A standalone consonant Y is also forbidden immediately after VV.
      if (s[i] === undefined) {
        const allowed = followsVowelPair(p, i) ? C_AFTER_VV : C;
        s[i] = allowed[rand(allowed.length)];
      }
    }
    return s.join('');
  }

  // Numeric arguments generate one title-cased word per requested length.
  function generateName(...lengths) {
    if (!lengths.length) return generateWord(6, Math.random);
    if (lengths.length === 1 && typeof lengths[0] === 'function') {
      return generateWord(6, lengths[0]);
    }
    if (lengths.length === 2 && typeof lengths[1] === 'function') {
      return generateWord(lengths[0], lengths[1]);
    }
    return lengths.map(length => {
      const word = generateWord(length, Math.random);
      return word[0] + word.slice(1).toLowerCase();
    }).join(' ');
  }

  function roomName() {
    const word = generateName();
    return 'Room ' + word[0] + word.slice(1).toLowerCase();
  }
  const api = {generateName, roomName};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.uburoomUbumfa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
