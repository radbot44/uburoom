// @ts-check
'use strict';
const { randomBytes, randomUUID, createHash } = require('node:crypto');

const digest = token => createHash('sha256').update(token).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Ended passes stay listed for a day so hosts can see what happened, then go.
const KEEP_ENDED_MS = 24 * 3600000;

/**
 * @typedef {{id:string,tokenHash:string,roomId:string,issuerId:string,createdAt:number,expiresAt:number,
 *   maxUses:number,uses:number,signIn:number,disabled:number,revokedAt:number|null}} PassRow
 */

// Durable guest passes. A pass lets people into one room. Turning it off stops
// new entries; revoking ends it for good; it also stops working while the
// person who made it no longer may issue passes. Live sessions, sockets and
// room membership belong to the HTTP and room layers.
class GuestPasses {
  /**
   * @param {import('./accounts').Accounts} registry
   * @param {{maxLifetimeHours:number,maxUses:number,requireSignIn:boolean}} settings
   * @param {{issuer:(pass:PassRow)=>boolean|undefined, now?:()=>number}} options
   *   `issuer` says whether the pass's issuer may still issue for its room:
   *   false only when that is definitely no longer true, undefined when unknown.
   */
  constructor(registry, settings, { issuer, now = Date.now }) {
    this.registry = registry; this.db = registry.db; this.settings = settings; this.issuer = issuer; this.now = now;
  }
  /** @returns {PassRow|undefined} */
  get(id) { return typeof id === 'string' ? /** @type {any} */ (this.db.prepare('SELECT * FROM guest_passes WHERE id=?').get(id)) : undefined; }
  /** @returns {PassRow|undefined} */
  byToken(token) { return typeof token === 'string' && TOKEN.test(token) ? /** @type {any} */ (this.db.prepare('SELECT * FROM guest_passes WHERE tokenHash=?').get(digest(token))) : undefined; }
  /** @param {PassRow} pass */
  signInRequired(pass) { return !!pass.signIn || this.settings.requireSignIn; }
  // Whether people already let in may stay. Unknown issuer standing (a provider
  // that has not answered) keeps them, as an outage is not a denial.
  /** @param {PassRow|undefined} pass */
  active(pass) { return !!pass && pass.revokedAt === null && pass.expiresAt > this.now() && this.issuer(pass) !== false; }
  /** @param {PassRow|undefined} pass */
  admits(pass, userId) { return this.active(pass) && !(this.signInRequired(pass) && this.registry.isGuest(userId)); }
  // Whether someone new may come in now. This needs a definite yes about the issuer.
  /** @param {PassRow|undefined} pass */
  open(pass) { return !!pass && this.active(pass) && this.issuer(pass) === true && !pass.disabled && pass.uses < pass.maxUses; }
  /** @param {PassRow} pass */
  status(pass) {
    if (pass.revokedAt !== null) return 'revoked';
    if (pass.expiresAt <= this.now()) return 'expired';
    if (this.issuer(pass) === false) return 'issuer';
    if (pass.disabled) return 'disabled';
    if (pass.uses >= pass.maxUses) return 'used';
    return 'active';
  }
  /** @param {PassRow} pass */
  view(pass) {
    return { id:pass.id, issuer:{ id:pass.issuerId, name:this.registry.canonical(pass.issuerId)?.name || 'Room member' },
      createdAt:pass.createdAt, expiresAt:pass.expiresAt, maxUses:pass.maxUses, uses:pass.uses,
      signIn:this.signInRequired(pass), disabled:!!pass.disabled, revokedAt:pass.revokedAt, status:this.status(pass) };
  }
  list(roomId) {
    return /** @type {PassRow[]} */ (/** @type {any} */ (this.db.prepare('SELECT * FROM guest_passes WHERE roomId=? ORDER BY createdAt DESC').all(roomId))).map(pass => this.view(pass));
  }
  /** Returns the only copy of the token; just its hash is stored. */
  create(roomId, issuerId, { hours, uses, signIn }) {
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > this.settings.maxLifetimeHours) throw failure('Choose a lifetime from 1 to ' + this.settings.maxLifetimeHours + ' hours');
    if (!Number.isSafeInteger(uses) || uses < 1 || uses > this.settings.maxUses) throw failure('Choose from 1 to ' + this.settings.maxUses + ' uses');
    if (typeof signIn !== 'boolean') throw failure('Choose whether guests must sign in');
    const token = randomBytes(32).toString('base64url'), id = randomUUID(), at = this.now();
    this.db.prepare('INSERT INTO guest_passes(id,tokenHash,roomId,issuerId,createdAt,expiresAt,maxUses,signIn) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, digest(token), roomId, issuerId, at, at + hours * 3600000, uses, signIn || this.settings.requireSignIn ? 1 : 0);
    this.registry.audit(issuerId, 'guest-pass-create', { roomId, passId:id, hours, uses, signIn });
    return { pass:this.view(/** @type {PassRow} */ (this.get(id))), token };
  }
  /** Counts one entry, refusing atomically once the pass is full, off or ended. */
  use(id) {
    return this.db.prepare('UPDATE guest_passes SET uses=uses+1 WHERE id=? AND uses<maxUses AND disabled=0 AND revokedAt IS NULL AND expiresAt>?').run(id, this.now()).changes === 1;
  }
  change(roomId, id, actorId, action) {
    const pass = this.get(id);
    if (!pass || pass.roomId !== roomId) throw failure('Guest pass not found', 404);
    if (pass.revokedAt !== null) throw failure('This pass was already revoked', 409);
    if (action === 'revoke') this.db.prepare('UPDATE guest_passes SET revokedAt=? WHERE id=?').run(this.now(), id);
    else if (action === 'disable' || action === 'enable') {
      if (pass.expiresAt <= this.now()) throw failure('This pass has expired', 409);
      this.db.prepare('UPDATE guest_passes SET disabled=? WHERE id=?').run(action === 'disable' ? 1 : 0, id);
    } else throw failure('Unsupported pass change');
    this.registry.audit(actorId, 'guest-pass-' + action, { roomId, passId:id });
    return this.view(/** @type {PassRow} */ (this.get(id)));
  }
  prune() {
    this.db.prepare('DELETE FROM guest_passes WHERE COALESCE(revokedAt,expiresAt)<=?').run(this.now() - KEEP_ENDED_MS);
  }
}

module.exports = { GuestPasses, TOKEN };
