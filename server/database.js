'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_VERSION } = require('./storage');

// Baseline 11 is the first supported layout. Add only published forward steps;
// private pre-release transfers never belong here. No migrations are needed yet.
const MIGRATIONS = Object.freeze([]);
function runMigrations(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new Error('Account database requires a newer uburoom version');
  if (version < 11) throw new Error('Unsupported pre-release database; review a manual state transfer before starting');
  const pending = MIGRATIONS.filter(step => step.version > version);
  if (!pending.length) {
    if (version !== SCHEMA_VERSION) throw new Error('Incomplete storage migration sequence');
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
function openDatabase(file, initializeSchema) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file || ':memory:');
  try {
    // Validate before changing journal mode, so rejected layouts stay unchanged.
    if (db.prepare('PRAGMA user_version').get().user_version === 0) initializeSchema(db);
    runMigrations(db);
    initializeSchema(db);
    // Lock contention fails quickly instead of stalling room ticks for seconds.
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;');
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    try {
      const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (result.busy) throw new Error('Account database checkpoint is busy; preserve the WAL file');
    } finally {
      db.close();
      closed = true;
    }
  };
  return { db, close, abort: close };
}
module.exports = { openDatabase, runMigrations };
