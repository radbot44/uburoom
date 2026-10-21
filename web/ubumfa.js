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
  function generateName(random = Math.random) {
    const rand = n => Math.floor(random() * n);
    const p = PATTERNS[rand(PATTERNS.length)], s = Array(6);
    const cc = p.indexOf('CC'), vv = p.indexOf('VV');
    if (cc !== -1) {
      const pair = PAIRS[rand(PAIRS.length)];
      s[cc] = pair[0]; s[cc + 1] = pair[1];
    }
    if (vv !== -1) {
      const n = rand(20), a = n >> 2, b = n & 3;
      s[vv] = V[a]; s[vv + 1] = V[b >= a ? b + 1 : b];
    }
    for (let i = 0; i < 6; i++) {
      // Filled pairs may contain literal V; do not interpret them as pattern markers.
      if (s[i] === undefined) s[i] = p[i] === 'V' ? V[rand(5)] : C[rand(C.length)];
    }
    return s.join('');
  }
  function roomName() {
    const word = generateName();
    return 'Room ' + word[0] + word.slice(1).toLowerCase();
  }
  const api = {generateName, roomName};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.uburoomUbumfa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
