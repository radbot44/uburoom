'use strict';
const { randomBytes, randomInt, timingSafeEqual } = require('node:crypto');
const { hash } = require('./core');
const SECRET = /^[a-f0-9]{64}$/;
const TTL = 60000;

// Memory only. A source approval is bound to one browser proof, not just a URL.
class Handoff {
  constructor(now = Date.now) { this.now = now; this.attempts = new Map(); this.codes = new Map(); }
  issue(source, roomId) {
    this.sweep();
    for (const attempt of this.attempts.values()) if (attempt.source === source) this.remove(attempt);
    if (this.attempts.size >= 200) throw new Error('Browser sign-in is busy; try again shortly');
    const id = randomBytes(32).toString('hex'), code = randomBytes(32).toString('hex');
    const attempt = { id, codeHash: hash(code), source, roomId, expires: this.now() + TTL, state: 'waiting' };
    this.attempts.set(id, attempt); this.codes.set(attempt.codeHash, attempt);
    return { id, code, expires: attempt.expires };
  }
  get(id) {
    const attempt = SECRET.test(id || '') && this.attempts.get(id);
    return attempt && attempt.expires > this.now() ? attempt : undefined;
  }
  claim(code, proof, browserNonce) {
    if (![code, proof, browserNonce].every(value => SECRET.test(value || ''))) return;
    const attempt = this.codes.get(hash(code));
    if (!attempt || this.get(attempt.id) !== attempt || attempt.state !== 'waiting') return;
    this.codes.delete(attempt.codeHash);
    Object.assign(attempt, { state: 'claimed', proofHash: hash(proof), browserHash: hash(browserNonce), verification: String(randomInt(100000, 1000000)) });
    return attempt;
  }
  browser(id, proof, browserNonce) {
    const attempt = this.get(id);
    return SECRET.test(proof || '') && SECRET.test(browserNonce || '') && attempt?.proofHash === hash(proof) && attempt.browserHash === hash(browserNonce) ? attempt : undefined;
  }
  approve(attempt, verification) {
    if (this.get(attempt.id) !== attempt || attempt.state !== 'claimed' || typeof verification !== 'string') return false;
    const expected = Buffer.from(attempt.verification), actual = Buffer.from(verification);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    attempt.state = 'approved'; return true;
  }
  consume(attempt) {
    if (this.get(attempt.id) !== attempt || attempt.state !== 'approved') return false;
    attempt.state = 'complete'; delete attempt.proofHash; delete attempt.browserHash; return true;
  }
  remove(attempt) { this.attempts.delete(attempt.id); this.codes.delete(attempt.codeHash); }
  sweep() { for (const attempt of this.attempts.values()) if (attempt.expires <= this.now()) this.remove(attempt); }
  close() { this.attempts.clear(); this.codes.clear(); }
}
module.exports = { Handoff, TTL, SECRET };
