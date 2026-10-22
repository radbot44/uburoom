/* Reusable display-word generator. Words are not unique identifiers or secrets. */
(function(root) {
  'use strict';
  const V = 'AEIOU';
  const C = 'BCDFGHJKLMNPRSTVWZ';
  const PAIRS = `BL BR CL CR DR DW FL FR GL GR KL KR PL PR SK SL SM SN SP ST SW TR TW
MB MD MF MG MH MK ML MN MP MR MS MT MV MZ
NB ND NF NG NH NJ NK NL NM NP NR NS NT NV NZ
LB LD LF LG LK LM LN LP LR LS LT LV LW LZ
RB RD RF RG RK RL RM RN RP RS RT RV RW RZ
BD BG BP BS BT DB DG DK DP DS DT
FB FD FK FM FN FP FS FT GB GD GN GP GS GT
KB KD KF KG KM KN KP KS KT
PB PD PF PG PK PM PN PS PT
SB SD SF SG SR SV
TB TD TF TG TK TL TM TN TP TS
VB VD VG VL VN VR VS VT
ZB ZD ZG ZL ZM ZN ZR ZS ZT ZV`.split(/\s+/);
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

  function generateWord(length, random) {
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new RangeError('Word length must be a positive safe integer');
    }
    const rand = n => Math.floor(random() * n);
    const p = patternForLength(length, rand), s = Array(length);
    // Fill all doubled consonants before doubled vowels, preserving the
    // existing six-letter random draw order.
    for (let cc = p.indexOf('CC'); cc !== -1; cc = p.indexOf('CC', cc + 2)) {
      const pair = PAIRS[rand(PAIRS.length)];
      s[cc] = pair[0]; s[cc + 1] = pair[1];
    }
    for (let vv = p.indexOf('VV'); vv !== -1; vv = p.indexOf('VV', vv + 2)) {
      const n = rand(20), a = n >> 2, b = n & 3;
      s[vv] = V[a]; s[vv + 1] = V[b >= a ? b + 1 : b];
    }
    for (let i = 0; i < length; i++) {
      // Filled pairs may contain literal V; do not interpret them as pattern markers.
      if (s[i] === undefined) s[i] = p[i] === 'V' ? V[rand(5)] : C[rand(C.length)];
    }
    return s.join('');
  }

  // Preserve the original unparameterized and seeded six-letter results.
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
