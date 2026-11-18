'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { SCHEMA_VERSION } = require('./storage');

// Baseline 11 is the first supported layout. Add only published forward steps;
// private pre-release transfers never belong here. No migrations are needed yet.
const MIGRATIONS = Object.freeze([]);

// Publish complete ownership records atomically. Holding the descriptor also
// prevents accidental reuse of its inode while this process owns the lock.
function lockFile(file) {
  const canonical = fs.existsSync(file)
    ? fs.realpathSync(file)
    : path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
  const lock = canonical + '.lock';
  const recovering = lock + '.recovery';
  const busy = () => new Error('Account database is already open or lock recovery is in progress');
  const publish = name => {
    const token = randomUUID();
    const temporary = name + '.' + process.pid + '.' + token;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token }));
      fs.linkSync(temporary, name);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(name, 'utf8')).token === token) fs.unlinkSync(name);
      } finally {
        fs.closeSync(fd);
      }
    };
  };
  const noRecovery = () => {
    if (fs.existsSync(recovering))
      throw new Error(
        'Account database lock recovery is in progress or was interrupted; verify its owner has stopped before removing the .lock.recovery file',
      );
  };
  noRecovery();
  try {
    const release = publish(lock);
    try {
      noRecovery();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // One recovery owner checks and replaces a dead PID. New owners check this
  // guard both before and after publishing, so they cannot race stale removal.
  let releaseRecovery;
  try {
    releaseRecovery = publish(recovering);
  } catch (error) {
    if (error.code === 'EEXIST') throw busy();
    throw error;
  }
  try {
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          'Account database lock is unreadable; verify its owner has stopped before removing the .lock file',
        );
    }
    if (owner) {
      if (owner.host !== os.hostname())
        throw new Error(
          'Account database lock belongs to another host or container; verify the prior instance has stopped before removing the .lock file',
        );
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string')
        throw new Error(
          'Account database lock is invalid; verify its owner has stopped before removing the .lock file',
        );
      try {
        process.kill(owner.pid, 0);
        throw busy();
      } catch (error) {
        if (error.code !== 'ESRCH') throw error.code === 'EPERM' ? busy() : error;
      }
      fs.unlinkSync(lock);
    }
    try {
      return publish(lock);
    } catch (error) {
      if (error.code === 'EEXIST') throw busy();
      throw error;
    }
  } finally {
    releaseRecovery();
  }
}
function runMigrations(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new Error('Account database requires a newer uburoom version');
  if (version < 11) throw new Error('Unsupported pre-release database; review a manual state transfer before starting');
  const pending = MIGRATIONS.filter(step => step.version > version);
  if (!pending.length) {
    if (version !== SCHEMA_VERSION)
      throw new Error('Unsupported pre-release database; review a manual state transfer before starting');
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    let current = version;
    for (const { version: next, up } of pending) {
      if (next !== current + 1 || next > SCHEMA_VERSION) throw new Error('Invalid storage migration sequence');
      up(db);
      db.exec('PRAGMA user_version=' + next);
      current = next;
    }
    if (current !== SCHEMA_VERSION) throw new Error('Incomplete storage migration sequence');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// One direct connection; statements and short transactions commit before return.
// WAL/NORMAL survives process crashes; sudden power loss can lose recent commits.
function openDatabase(file, initializeSchema, authenticate = () => {}) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = file && file !== ':memory:' ? lockFile(file) : () => {};
  let db;
  try {
    db = new DatabaseSync(file || ':memory:');
    // Validate the current baseline (or create an empty installation) before
    // authentication. Published forward migrations must also wait for the key.
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 0 || version === SCHEMA_VERSION) initializeSchema(db);
    else if (version < 11 || version > SCHEMA_VERSION) runMigrations(db);
    authenticate(db);
    runMigrations(db);
    initializeSchema(db);
    // Lock contention fails quickly instead of stalling room ticks for seconds.
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;');
  } catch (error) {
    try {
      db?.close();
    } finally {
      release();
    }
    throw error;
  }
  let closed = false;
  const finish = checkpoint => {
    if (closed) return;
    try {
      if (checkpoint) {
        const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (result.busy) throw new Error('Account database checkpoint is busy; preserve the WAL file');
      }
    } finally {
      db.close();
      closed = true;
      release();
    }
  };
  return { db, close: () => finish(true), abort: () => finish(false) };
}
module.exports = { openDatabase, runMigrations };
