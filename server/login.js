'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { hash, UUID } = require('./core');
// Fixed integration identity; never derive it from another repository's manifest.
const FIREFOX_EXTENSION_ID = 'uburoom@uburoom.com';
// Firefox derives its private auth return URL from the fixed add-on ID.
const FIREFOX_REDIRECT = `https://${createHash('sha1').update(FIREFOX_EXTENSION_ID).digest('hex')}.extensions.allizom.org/`;
const CHROME_REDIRECT_PATTERN = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/?$/i;
function isAllowedExtensionRedirect(uri) {
  return typeof uri === 'string' && (uri === FIREFOX_REDIRECT || CHROME_REDIRECT_PATTERN.test(uri));
}
const TOKEN = /^[a-f0-9]{64}$/;
class DeviceLogin {
  constructor() { this.requests = new Map(); }
  start(deviceId, challenge, state, redirectUri = FIREFOX_REDIRECT) {
    this.sweep();
    if (!UUID.test(deviceId) || !TOKEN.test(challenge) || !TOKEN.test(state) || !isAllowedExtensionRedirect(redirectUri) || this.requests.size >= 100) throw new Error('Invalid login request');
    const id = randomBytes(32).toString('hex');
    this.requests.set(id, { deviceId, challenge, state, redirectUri, expires: Date.now() + 300000, attempts: 0 });
    return id;
  }
  get(id) { this.sweep(); return this.requests.get(id); }
  approve(id, ownerId) {
    const request = this.get(id);
    if (!request || request.codeHash) throw new Error('Invalid or expired login');
    const code = randomBytes(32).toString('hex');
    request.ownerId = ownerId; request.codeHash = hash(code);
    return { code, state: request.state };
  }
  finish(id, verifier, code) {
    const request = this.get(id);
    if (!request) throw new Error('Invalid or expired login');
    if (!TOKEN.test(verifier) || !TOKEN.test(code) || request.challenge !== hash(verifier) || request.codeHash !== hash(code)) {
      if (++request.attempts >= 5) this.requests.delete(id);
      throw new Error('Invalid or expired login');
    }
    this.requests.delete(id);
    return { deviceId: request.deviceId, ownerId: request.ownerId, credential: randomBytes(32).toString('hex') };
  }
  sweep() { for (const [id, request] of this.requests) if (request.expires <= Date.now()) this.requests.delete(id); }
}
module.exports = { DeviceLogin, FIREFOX_EXTENSION_ID, FIREFOX_REDIRECT, isAllowedExtensionRedirect };
