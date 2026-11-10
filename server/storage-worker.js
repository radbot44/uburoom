'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
let histories = Promise.resolve();
parentPort.on('message', ({ id, changes, close, history }) => {
  if (history) {
    histories = histories
      .then(() => require('./history-projection').historyProjection(db, history))
      .then(
        value => parentPort.postMessage({ id, value }),
        () => parentPort.postMessage({ id, readError: 'History temporarily unavailable' }),
      );
    return;
  }
  try {
    if (changes) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const change of changes) if (!db.applyChangeset(change)) throw new Error('Changeset rejected');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    if (close) db.close();
    parentPort.postMessage({ id });
    if (close) parentPort.close();
  } catch {
    parentPort.postMessage({ id, error: 'Account storage unavailable' });
  }
});
