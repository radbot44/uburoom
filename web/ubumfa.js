/* Reusable display-word generator matching Ububall uburithm. Words are not unique identifiers or secrets. */
(function (root) {
  'use strict';
  const V = 'AEIOU';
  const C = 'BCDFGHJKLMNPQRSTVWXYZ';
  const BEFORE_X = 'HLNRSWYXZ';
  const C_NO_X = C.replace('X', '');
  const weight = ch => (ch === 'X' || ch === 'Z' ? 1 : ch === 'Q' ? 2 : ch === 'K' || ch === 'Y' ? 3 : 6);
  const C_POOL = [...C].flatMap(ch => Array(weight(ch)).fill(ch));
  const C_AFTER_VV_POOL = C_POOL.filter(ch => ch !== 'Y');
  const VOWEL_PAIRS = [...V].flatMap(a => [...V].map(b => a + b));
  const PAIRS = [C, C.replace(/[HWY]/g, '')].map(starters =>
    [...starters].flatMap(first =>
      [...(BEFORE_X.includes(first) ? C : C_NO_X)].flatMap(second =>
        Array(weight(first) * weight(second)).fill(first + second),
      ),
    ),
  );
  const MASK = 0xffffffffffffffffn;

  class NameRandom {
    constructor(state) {
      state = (state + 0x9e3779b97f4a7c15n) & MASK;
      this.state = state;
      let z = state;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
      z ^= z >> 31n;
      const low = Number(z & 0xffffffffn);
      this.flags = low & 0xff;
      this.value = low >>> 8;
      this.range = 0x1000000;
      this.low = Number(z >> 32n);
      this.haveLow = true;
    }
    next32() {
      if (this.haveLow) {
        this.haveLow = false;
        return this.low;
      }
      let state = (this.state + 0x9e3779b97f4a7c15n) & MASK;
      this.state = state;
      let z = state;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
      z ^= z >> 31n;
      this.low = Number(z & 0xffffffffn);
      this.haveLow = true;
      return Number(z >> 32n);
    }
    int(n) {
      for (;;) {
        if (this.range < n) {
          this.value = this.value * 4294967296 + this.next32();
          this.range *= 4294967296;
        }
        const limit = this.range - (this.range % n);
        if (this.value < limit) {
          const result = this.value % n;
          this.value = (this.value - result) / n;
          this.range = limit / n;
          return result;
        }
        this.value -= limit;
        this.range -= limit;
      }
    }
  }

  const VY_UP = [...V].flatMap(v => Array(6).fill(v)).concat('Y');
  const VY_LO = VY_UP.map(v => v.toLowerCase());
  const V5_LO = [...V].map(v => v.toLowerCase());
  const C0_UP = C_POOL;
  const C0_LO = C_POOL.map(c => c.toLowerCase());
  const C1_LO = C_AFTER_VV_POOL.map(c => c.toLowerCase());
  const VV_LO = VOWEL_PAIRS.map(vv => vv.toLowerCase());
  const CC0_LO = PAIRS[0].map(cc => cc.toLowerCase());
  const CC1_LO = PAIRS[1].map(cc => cc.toLowerCase());

  const CAP_CV = C0_UP.flatMap(c => VY_LO.map(v => c + v)); // 3,286
  const LOW_CV = C0_LO.flatMap(c => VY_LO.map(v => c + v)); // 3,286
  const CAP_VC = VY_UP.flatMap(v => C0_LO.map(c => v + c)); // 3,286
  const LOW_VC = VY_LO.flatMap(v => C0_LO.map(c => v + c)); // 3,286
  const WORD_2 = CAP_CV.concat(CAP_VC); // 6,572
  const CAP_CVV = C0_UP.flatMap(c => VV_LO.map(vv => c + vv)); // 2,650
  const LOW_VVC1 = VV_LO.flatMap(vv => C1_LO.map(c => vv + c)); // 2,575
  const LOW_C1V = C1_LO.flatMap(c => VY_LO.map(v => c + v)); // 3,193
  const LOW_V5C = V5_LO.flatMap(v => C0_LO.map(c => v + c)); // 530
  const VY_PAIR_HEAD = VY_UP.flatMap(v1 => VY_LO.map(() => v1)); // 961
  const VY_PAIR_TAIL = VY_UP.flatMap(() => VY_LO); // 961
  const V5_VY_HEAD = V5_LO.flatMap(v1 => VY_LO.map(() => v1)); // 155
  const V5_VY_TAIL = V5_LO.flatMap(() => VY_LO); // 155

  function word6(random) {
    switch (random.int(8)) {
      case 0:
        return CAP_CV[random.int(3286)] + LOW_CV[random.int(3286)] + LOW_CV[random.int(3286)];
      case 1:
        return CAP_CV[random.int(3286)] + C0_LO[random.int(106)] + LOW_VVC1[random.int(2575)];
      case 2:
        return CAP_CVV[random.int(2650)] + CC1_LO[random.int(9581)] + VY_LO[random.int(31)];
      case 3:
        return CAP_CVV[random.int(2650)] + LOW_C1V[random.int(3193)] + C0_LO[random.int(106)];
      case 4: {
        const vv = random.int(961);
        return VY_PAIR_HEAD[vv] + CC0_LO[random.int(11171)] + LOW_V5C[random.int(530)] + VY_PAIR_TAIL[vv];
      }
      case 5:
        return VY_UP[random.int(31)] + CC0_LO[random.int(11171)] + LOW_VVC1[random.int(2575)];
      case 6: {
        const vv = random.int(155);
        return CAP_VC[random.int(3286)] + V5_VY_HEAD[vv] + CC0_LO[random.int(11171)] + V5_VY_TAIL[vv];
      }
      default:
        return CAP_VC[random.int(3286)] + LOW_VC[random.int(3286)] + LOW_VC[random.int(3286)];
    }
  }

  function word(length, random) {
    if (length === 6) return word6(random);
    if (length === 2) return WORD_2[random.int(6572)];
    if (length === 3) {
      return random.int(2) === 0
        ? CAP_CV[random.int(3286)] + C0_LO[random.int(106)]
        : CAP_VC[random.int(3286)] + VY_LO[random.int(31)];
    }
    switch (random.int(4)) {
      case 0:
        return CAP_CV[random.int(3286)] + LOW_CV[random.int(3286)];
      case 1: {
        const vv = random.int(961);
        return VY_PAIR_HEAD[vv] + CC0_LO[random.int(11171)] + VY_PAIR_TAIL[vv];
      }
      case 2:
        return CAP_CVV[random.int(2650)] + C1_LO[random.int(103)];
      default:
        return CAP_VC[random.int(3286)] + LOW_VC[random.int(3286)];
    }
  }

  function ubunym(state) {
    const random = new NameRandom(state);
    const nomen = word6(random);
    const length = [2, 3, 4, 6][random.flags & 3];
    const extra = word(length, random);
    const before = (random.flags & 4) === 0;
    const opposite = length < 6 ? word(6 - length, random) : '';
    const showPraenomen = (random.flags & 8) === 0;
    const showCognomen = (random.flags & 16) === 0;
    const praenomen = showPraenomen ? (before ? extra : opposite) : '';
    const cognomen = showCognomen ? (before ? opposite : extra) : '';
    const frontRoll = (random.flags & 224) === 0;
    const cognomenBeforeNomen = Boolean(cognomen) && frontRoll;
    const ordered = cognomenBeforeNomen ? [praenomen, cognomen, nomen] : [praenomen, nomen, cognomen];
    return { praenomen, nomen, cognomen, cognomenBeforeNomen, fullName: ordered.filter(Boolean).join(' ') };
  }

  function seedToBigInt(seed) {
    if (typeof seed === 'bigint') return seed & MASK;
    if (typeof seed !== 'string' && !Number.isSafeInteger(seed)) {
      throw new TypeError('Seed must be a string, safe integer, or BigInt');
    }
    const value = (typeof seed === 'string' ? 's:' : 'n:') + seed;
    let state = 0xcbf29ce484222325n;
    for (let i = 0; i < value.length; i++) {
      state = ((state ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n) & MASK;
    }
    return state;
  }

  function randomState() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const buf = new BigUint64Array(1);
      crypto.getRandomValues(buf);
      return buf[0];
    }
    return (BigInt(Math.floor(Math.random() * 0xffffffff)) << 32n) | BigInt(Math.floor(Math.random() * 0xffffffff));
  }

  function generateWord(length = 6, seed) {
    if (![2, 3, 4, 6].includes(length)) length = 6;
    const state = seed !== undefined ? seedToBigInt(seed) : randomState();
    return word(length, new NameRandom(state));
  }

  function generateName(...lengths) {
    let seed;
    if (lengths.length > 0) {
      const last = lengths[lengths.length - 1];
      if (typeof last === 'string' || (typeof last === 'object' && last !== null && 'seed' in last)) {
        seed = typeof last === 'string' ? last : last.seed;
        lengths.pop();
      }
    }
    if (!lengths.length) return generateWord(6, seed);
    return lengths.map(l => generateWord(l, seed)).join(' ');
  }

  function roomName(seed) {
    const w = generateWord(6, seed);
    return 'Room ' + w[0] + w.slice(1).toLowerCase();
  }

  function slugify(text) {
    const raw = String(text ?? '')
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[-\s]+/g, '-');
    return raw || generateWord(6).toLowerCase();
  }

  function roomSlug(name, ubumfaWord) {
    if (!name || typeof name !== 'string') return (ubumfaWord || generateWord(6)).toLowerCase();
    const match = /^Room\s+([A-Za-z]+)$/i.exec(name.trim());
    if (match) return match[1].toLowerCase();
    return slugify(name);
  }

  const api = {
    generateWord,
    generateName,
    roomName,
    slugify,
    roomSlug,
    ubunym: seed =>
      ubunym(
        seed !== undefined
          ? seedToBigInt(typeof seed === 'object' && seed !== null && 'seed' in seed ? seed.seed : seed)
          : randomState(),
      ),
    word,
    word6,
    NameRandom,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.uburoomUbumfa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
