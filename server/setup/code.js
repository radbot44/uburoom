'use strict';
// @ts-check
/**
 * The setup code and the setup session (docs/first-run-setup.md, "Security of setup mode").
 *
 * The code is 128 random bits shown as grouped base32, made new each time setup starts and after
 * 10 wrong guesses; only its hash is kept and comparison is constant-time. A correct code is
 * exchanged for one random session (30 minutes); a new exchange ends the old session.
 */
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_WRONG = 10;
const SESSION_MS = 30 * 60000;

/** 128 random bits as base32, in groups of four: ABCD-EFGH-…-XY. */
function newCode() {
  const bytes = randomBytes(16);
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

/** A typed or pasted code as compared: letters and digits only, uppercase. */
const normalize = value =>
  typeof value === 'string' && value.length <= 200 ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
const digest = value => createHash('sha256').update(value).digest();

/**
 * @param {{announce: (code: string) => void, now?: () => number}} options - `announce` shows a new
 *   code where the owner can see it (the console and the log)
 */
function createSetupGuard({ announce, now = Date.now }) {
  let codeHash, wrong, session;
  function rotate() {
    const code = newCode();
    codeHash = digest(normalize(code));
    wrong = 0;
    announce(code);
  }
  rotate();
  return {
    /**
     * Exchanges a code for a new session. Wrong codes count; the tenth makes a new code.
     * @returns {{session: string} | {error: 'wrong' | 'locked'}}
     */
    exchange(input) {
      const match = timingSafeEqual(digest(normalize(input)), codeHash);
      if (!match) {
        wrong++;
        if (wrong >= MAX_WRONG) {
          rotate();
          return { error: 'locked' };
        }
        return { error: 'wrong' };
      }
      const token = randomBytes(32).toString('base64url');
      session = { hash: digest(token), expires: now() + SESSION_MS };
      return { session: token };
    },
    /** Whether a cookie value is the current, unexpired session. */
    valid(token) {
      if (!session || typeof token !== 'string' || !token || token.length > 100) return false;
      if (session.expires <= now()) {
        session = undefined;
        return false;
      }
      return timingSafeEqual(digest(token), session.hash);
    },
    /** Ends the session (setup finished). */
    end() {
      session = undefined;
    },
    SESSION_MS,
  };
}

module.exports = { createSetupGuard, newCode, normalize, MAX_WRONG, SESSION_MS };
