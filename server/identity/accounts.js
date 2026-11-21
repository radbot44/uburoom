'use strict';
// @ts-check
// uburoom accounts: people the server operator creates, who sign in with a username
// and password. Each is a verified identity with provider 'uburoom' and a stable random
// subject (never the username), attached to an ordinary canonical account UUID.
//
// The account starts unverified, with a one-time link. Setting a password from the link
// verifies it; disabling it unverifies it, so every rule that trusts verified identities
// (admission, operator) stops trusting it at once. Issuing a new link is the only recovery.
const { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual } = require('node:crypto');
const { repositories } = require('../repositories');
const { displayName } = require('../accounts');

const PROVIDER = 'uburoom';
const LINK_MS = 72 * 3600000;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 1024;
// scrypt cost: about 32 MiB and tens of milliseconds per hash, on libuv's thread pool.
const SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keylen: 64 });
// Hashes run off the main thread, but each holds memory: refuse, rather than queue, a burst.
const MAX_HASHING = 4;

const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;

/** Fails with a message safe to show the person who typed the value. */
const invalid = (message, code = 'ACCOUNT_INVALID') => Object.assign(new Error(message), { code });

/**
 * A username as stored: trimmed, lowercased ASCII letters, digits, dots, dashes and underscores,
 * 1–32 characters, starting and ending with a letter or digit. Case never distinguishes two accounts.
 * @param {unknown} value
 */
function normalizeUsername(value) {
  if (typeof value !== 'string') throw invalid('Use a username of letters, digits, dots, dashes or underscores');
  const username = value.trim().normalize('NFKC').toLowerCase();
  if (!USERNAME.test(username))
    throw invalid(
      'Use a username of 1–32 letters, digits, dots, dashes or underscores, starting and ending with a letter or digit',
    );
  return username;
}

/** @param {unknown} value */
function validPassword(value) {
  if (typeof value !== 'string') throw invalid('Use a password of at least 10 characters', 'PASSWORD_INVALID');
  const password = value.normalize('NFC');
  const length = [...password].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX)
    throw invalid(`Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`, 'PASSWORD_INVALID');
  return password;
}

const digest = (/** @type {string} */ token) => createHash('sha256').update(token).digest('hex');

// One process-wide count of hashes running, shared by every caller.
let hashing = 0;
/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {{N: number, r: number, p: number, keylen: number}} params
 * @returns {Promise<Buffer>}
 */
async function derive(password, salt, params) {
  if (hashing >= MAX_HASHING) throw invalid('Sign-in is busy; try again shortly', 'ACCOUNT_BUSY');
  hashing++;
  try {
    return await new Promise((resolve, reject) =>
      scrypt(
        password,
        salt,
        params.keylen,
        { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    hashing--;
  }
}
/**
 * A password as stored: its scrypt hash, salt and parameters. Checks the length first.
 * @param {unknown} password
 */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(validPassword(password), salt, SCRYPT);
  return { hash: key.toString('base64'), salt: salt.toString('base64'), params: JSON.stringify(SCRYPT) };
}
/** @param {any} value */
const storedHash = value =>
  !!value &&
  typeof value.hash === 'string' &&
  typeof value.salt === 'string' &&
  typeof value.params === 'string' &&
  !!value.hash &&
  !!value.salt;

/**
 * @param {{registry: InstanceType<typeof import('../accounts').Accounts>, now?: () => number}} services
 */
function createUburoomAccounts({ registry, now = Date.now }) {
  const repo = () => repositories(registry.db).uburoomAccounts;

  /** A fresh link; only its hash is stored. @param {'set'|'reset'} purpose */
  function newLink(purpose) {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: digest(token), expires: now() + LINK_MS, purpose };
  }
  /** What the operator may see of an account: never a hash, salt or link token. */
  function summary(row) {
    if (!row) return undefined;
    const pending = !!row.linkExpires && row.linkExpires > now();
    return {
      subject: row.subject,
      userId: row.userId,
      username: row.username,
      name: row.name,
      disabled: row.disabled === 1,
      passwordSet: row.passwordSet === 1,
      link: pending ? { expires: row.linkExpires, purpose: row.linkPurpose } : null,
      signedInAt: row.signedInAt,
      createdAt: row.createdAt,
    };
  }
  const account = (/** @type {string} */ subject) => summary(repo().publicBySubject(subject));
  /** @param {string} subject */
  function existing(subject) {
    if (typeof subject !== 'string' || !repo().bySubject(subject))
      throw invalid('Account not found', 'ACCOUNT_MISSING');
    return subject;
  }
  /**
   * Inserts the account, its canonical user and its identity.
   * @param {string} username
   * @param {string} name
   * @param {{hash: string, salt: string, params: string}|undefined} password
   * @param {{hash: string, expires: number, purpose: string}|undefined} link
   * @param {string} [subject] - chosen ahead (first-run setup names the operator before the account exists)
   */
  function insert(username, name, password, link, subject = randomUUID()) {
    registry.transaction(() => {
      if (repo().byUsername(username)) throw invalid('That username is taken', 'ACCOUNT_TAKEN');
      const userId = registry.create(name);
      repositories(registry.db).accounts.insertIdentities(PROVIDER, subject, userId, name, password ? 1 : 0);
      repo().insert(subject, username, password, link, now());
    });
    return subject;
  }

  return {
    PROVIDER,
    LINK_MS,
    normalizeUsername,
    /** Every uburoom account, for the operator. */
    list: () => repo().list().map(summary),
    account,
    /**
     * Creates an account with a one-time link to set its password. The link's token is returned
     * once, here, for the operator to pass on; afterwards only its hash exists.
     * @param {{username: unknown, name: unknown, actor: string}} input
     */
    create({ username, name, actor }) {
      const normalized = normalizeUsername(username);
      const display = displayName(typeof name === 'string' && name.trim() ? name : normalized);
      const link = newLink('set');
      const subject = insert(normalized, display, undefined, link);
      registry.audit(actor, 'uburoom-account-create', { subject, username: normalized });
      return { account: account(subject), link: { token: link.token, expires: link.expires } };
    },
    /**
     * The first account, made directly with its password (no link): for the setup wizard, before
     * anyone can sign in. The caller decides whether the installation may still do this. Setup passes
     * the password already hashed (`hashed`, from `hashPassword`) and the `subject` it wrote as operator.
     * @param {{username: unknown, name?: unknown, password?: unknown, hashed?: any, subject?: string}} input
     */
    async createFirst({ username, name, password, hashed, subject }) {
      const normalized = normalizeUsername(username);
      const display = displayName(typeof name === 'string' && name.trim() ? name : normalized);
      if (subject !== undefined && (typeof subject !== 'string' || !/^[A-Za-z0-9._@-]{1,100}$/.test(subject)))
        throw invalid('Account not created');
      const stored = storedHash(hashed) ? hashed : await hashPassword(password);
      subject = insert(normalized, display, stored, undefined, subject);
      const created = account(subject);
      registry.seen(created.userId);
      registry.audit(created.userId, 'uburoom-account-create-first', { subject, username: normalized });
      return account(subject);
    },
    /**
     * Replaces the account's link with a new one; the old link stops working. The current password
     * keeps working until the new link is used.
     * @param {string} subject
     * @param {string} actor
     */
    issueLink(subject, actor) {
      existing(subject);
      const row = repo().bySubject(subject);
      if (row.disabled) throw invalid('Enable the account before issuing a link', 'ACCOUNT_DISABLED');
      const link = newLink(row.passwordHash ? 'reset' : 'set');
      repo().setLink(subject, link, now());
      registry.audit(actor, 'uburoom-account-link', { subject });
      return { account: account(subject), link: { token: link.token, expires: link.expires } };
    },
    /**
     * Who a link is for, while it still works.
     * @param {unknown} token
     */
    linkInfo(token) {
      if (typeof token !== 'string' || token.length > 200) return undefined;
      const row = repo().byLink(digest(token));
      if (!row || row.disabled || !(row.linkExpires > now())) return undefined;
      const current = account(row.subject);
      return { username: current.username, name: current.name, purpose: row.linkPurpose };
    },
    /**
     * Sets the password from a one-time link and verifies the identity. The link works once: the
     * write succeeds only if the same link is still current after hashing. Advancing the account
     * revision ends every existing session of the account.
     * @param {unknown} token
     * @param {unknown} password
     * @returns {Promise<string|undefined>} the canonical user id, or undefined for an unusable link
     */
    async setPassword(token, password) {
      const checked = validPassword(password);
      if (typeof token !== 'string' || token.length > 200) return undefined;
      const hash = digest(token);
      const before = repo().byLink(hash);
      if (!before || before.disabled || !(before.linkExpires > now())) return undefined;
      const hashed = await hashPassword(checked);
      return registry.transaction(() => {
        if (!repo().setPassword(before.subject, hash, hashed, now())) return undefined;
        repo().identityVerified(before.subject, true);
        const current = account(before.subject);
        repositories(registry.db).accounts.updateUsersSetRevisionById(current.userId);
        registry.seen(current.userId);
        registry.audit(current.userId, 'uburoom-account-password', { subject: before.subject });
        return current.userId;
      });
    },
    /**
     * Checks a username and password. Unknown, disabled and passwordless accounts cost the same
     * hash as a real one, and every failure looks the same.
     * @param {unknown} username
     * @param {unknown} password
     * @returns {Promise<string|undefined>} the canonical user id on success
     */
    async verify(username, password) {
      let normalized, checked;
      try {
        normalized = normalizeUsername(username);
      } catch {
        normalized = undefined;
      }
      checked = typeof password === 'string' && password.length <= PASSWORD_MAX * 4 ? password.normalize('NFC') : '';
      const row = normalized ? repo().byUsername(normalized) : undefined;
      const usable = !!row && !row.disabled && !!row.passwordHash;
      const params = usable ? JSON.parse(row.passwordParams) : SCRYPT;
      const salt = usable ? Buffer.from(row.passwordSalt, 'base64') : randomBytes(16);
      const expected = usable ? Buffer.from(row.passwordHash, 'base64') : randomBytes(SCRYPT.keylen);
      const key = await derive(checked, salt, params);
      const match = key.length === expected.length && timingSafeEqual(key, expected);
      if (!usable || !match) return undefined;
      // The account may have changed while hashing: disabled, or a new password set.
      const current = repo().bySubject(row.subject);
      if (!current || current.disabled || current.passwordHash !== row.passwordHash) return undefined;
      const userId = account(row.subject).userId;
      registry.seen(userId);
      return userId;
    },
    /**
     * Disables or enables the account. Disabling unverifies the identity and drops any link; the
     * caller ends the account's sessions. Enabling verifies it again only once a password is set.
     * @param {string} subject
     * @param {boolean} disabled
     * @param {string} actor
     * @returns {string} the canonical user id
     */
    setDisabled(subject, disabled, actor) {
      existing(subject);
      return registry.transaction(() => {
        repo().setDisabled(subject, disabled, now());
        const row = repo().bySubject(subject);
        repo().identityVerified(subject, !disabled && !!row.passwordHash);
        const userId = account(subject).userId;
        repositories(registry.db).accounts.updateUsersSetRevisionById(userId);
        registry.audit(actor, disabled ? 'uburoom-account-disable' : 'uburoom-account-enable', { subject });
        return userId;
      });
    },
    /**
     * Whether this canonical account currently signs in as an enabled uburoom account with a
     * password: for entry rules that admit uburoom accounts.
     * @param {string} userId
     */
    admits(userId) {
      const user = registry.canonical(userId);
      if (!user) return false;
      const row = repo().byUser(user.id);
      const identity = row && registry.identity(PROVIDER, row.subject);
      return !!row && !row.disabled && !!row.passwordHash && identity?.verified === 1;
    },
  };
}

module.exports = { createUburoomAccounts, normalizeUsername, hashPassword, PROVIDER, LINK_MS, PASSWORD_MIN };
