'use strict';
// @ts-check
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const META = 'serverPassword';

/**
 * The server password entry rule (`access.password`, `secrets.server_password`): knowing it is
 * enough to get in, as a server-wide guest. Every session it admits carries the password's
 * **revision**; changing the password gives a new revision, which ends those sessions.
 *
 * The revision is remembered beside the password it was made for, sealed with the credential
 * key, so the database alone never holds anything a password could be guessed against.
 */
class ServerPassword {
  /**
   * @param {string} password - The configured password; blank when the rule is off.
   * @param {any} registry - The account database (`meta`, `vault`), when there is one.
   */
  constructor(password, registry) {
    this.password = password || '';
    this.revision = this.password ? revisionFor(registry, this.password) : undefined;
  }
  /** Whether a typed value is the password, compared in constant time. */
  matches(value) {
    if (!this.password || typeof value !== 'string' || value.length > 1024) return false;
    const digest = text => createHash('sha256').update(text).digest();
    return timingSafeEqual(digest(value), digest(this.password));
  }
}

/** The stored revision when the password is unchanged, else a new one (stored for next start). */
function revisionFor(registry, password) {
  const vault = registry?.vault;
  if (!vault || typeof registry.meta !== 'function') return randomBytes(16).toString('hex');
  try {
    const stored = registry.meta(META);
    const current = stored && vault.open(JSON.parse(stored));
    if (current?.password === password && typeof current.revision === 'string') return current.revision;
  } catch {
    // An unreadable record is replaced, which ends the sessions it would have kept.
  }
  const revision = randomBytes(16).toString('hex');
  registry.meta(META, JSON.stringify(vault.seal({ revision, password })));
  return revision;
}

module.exports = { ServerPassword };
