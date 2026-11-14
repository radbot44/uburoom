'use strict';

class QueueRepo {
  constructor(db) {
    this.statements = {};
    this.statements.deleteRoomProgressByRoomId = db.prepare('DELETE FROM watch_room_progress WHERE roomId=?');
    this.statements.deleteQueueEntriesByRoomId = db.prepare('DELETE FROM watch_queue_entries WHERE roomId=?');
    this.statements.findEntry = db.prepare('SELECT * FROM watch_queue_entries WHERE id = ?');
    this.statements.findCurrent = db.prepare(
      "SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'current'",
    );
    this.statements.findNextPending = db.prepare(
      "SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC LIMIT 1",
    );
    this.statements.findLatestHistory = db.prepare(
      "SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'history' ORDER BY endedAt DESC, rowid DESC LIMIT 1",
    );
    this.statements.countPending = db.prepare(
      "SELECT COUNT(*) AS count FROM watch_queue_entries WHERE roomId = ? AND state = 'pending'",
    );
    this.statements.insertQueueEntries = db.prepare(`
        INSERT INTO watch_queue_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
    this.statements.listPending = db.prepare(
      "SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC",
    );
    this.insertStatement = this.statements.insertQueueEntries;
    this.statements.listRoomProgressByRoomId = db.prepare(
      'SELECT serverId,mediaId FROM watch_room_progress WHERE roomId=?',
    );
    this.rankStatement = db.prepare('UPDATE watch_queue_entries SET rank = ?, updatedAt = ? WHERE id = ?');
    this.statements.interruptCurrent = db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, position = ?, outcome = 'interrupted', endedAt = ?, updatedAt = ?
          WHERE id = ?
        `);
    this.statements.skipPending = db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, outcome = 'skipped', endedAt = ?, updatedAt = ?
          WHERE roomId = ? AND state = 'pending'
        `);
    this.statements.listPendingIds = db.prepare(
      "SELECT id FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC",
    );
    this.statements.deleteQueueEntriesById = db.prepare('DELETE FROM watch_queue_entries WHERE id = ?');
    this.statements.closeRankGap = db.prepare(
      "UPDATE watch_queue_entries SET rank = rank - 1, updatedAt = ? WHERE roomId = ? AND state = 'pending' AND rank > ?",
    );
    this.statements.clearPending = db.prepare("DELETE FROM watch_queue_entries WHERE roomId = ? AND state = 'pending'");
    this.statements.skipBefore = db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, outcome = 'skipped', endedAt = ?, updatedAt = ?
          WHERE roomId = ? AND state = 'pending' AND rank < ?
        `);
    this.statements.shiftRanksAfter = db.prepare(`
          UPDATE watch_queue_entries
          SET rank = rank - ?, updatedAt = ?
          WHERE roomId = ? AND state = 'pending' AND rank > ?
        `);
    this.statements.closeSuccessorGap = db.prepare(`
          UPDATE watch_queue_entries
          SET rank = rank - 1, updatedAt = ?
          WHERE roomId = ? AND state = 'pending' AND rank > ?
        `);
    this.statements.startEntry = db.prepare(`
        UPDATE watch_queue_entries
        SET state = 'current', rank = NULL, startedAt = ?, updatedAt = ?
        WHERE id = ?
      `);
    this.statements.completeCurrent = db.prepare(`
        UPDATE watch_queue_entries
        SET state = 'history', rank = NULL, position = duration, outcome = 'completed', endedAt = ?, updatedAt = ?
        WHERE id = ?
      `);
    this.statements.insertRoomProgress = db.prepare('INSERT OR IGNORE INTO watch_room_progress VALUES(?,?,?)');
    this.statements.endCurrent = db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, position = ?, outcome = ?, endedAt = ?, updatedAt = ?
          WHERE id = ?
        `);
    this.statements.startSuccessor = db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'current', rank = NULL, startedAt = ?, updatedAt = ?
          WHERE id = ?
        `);
    this.statements.updateQueueEntriesSetRankUpdatedAtByRoomIdState = db.prepare(`
          UPDATE watch_queue_entries
          SET rank = rank - 1, updatedAt = ?
          WHERE roomId = ? AND state = 'pending'
        `);
    this.statements.insertQueueEntries3 = db.prepare(`
          INSERT INTO watch_queue_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
    this.statements.updateQueueEntriesSetPositionUpdatedAtById = db.prepare(
      'UPDATE watch_queue_entries SET position = 0, updatedAt = ? WHERE id = ?',
    );
    this.statements.listHistory = db.prepare(
      "SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'history' ORDER BY endedAt DESC, rowid DESC",
    );
    this.statements.shiftPendingRanks = db.prepare(
      "UPDATE watch_queue_entries SET rank = rank + ?, updatedAt = ? WHERE roomId = ? AND state = 'pending'",
    );
    this.deleteStatement = this.statements.deleteQueueEntriesById;
    this.statements.clearHistory = db.prepare("DELETE FROM watch_queue_entries WHERE roomId = ? AND state = 'history'");
    this.statements.updateQueueEntriesSetPositionUpdatedAtByRoomIdState = db.prepare(
      "UPDATE watch_queue_entries SET position = ?, updatedAt = ? WHERE roomId = ? AND state = 'current'",
    );
    this.statements.pagePending = db.prepare(
      "SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC LIMIT ? OFFSET ?",
    );
    this.statements.pageHistory = db.prepare(
      "SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'history' ORDER BY endedAt DESC, rowid DESC LIMIT ? OFFSET ?",
    );
    this.statements.countHistory = db.prepare(
      "SELECT COUNT(*) AS count FROM watch_queue_entries WHERE roomId = ? AND state = 'history'",
    );
    this.statements.countPendingSummary = db.prepare(
      "SELECT COUNT(*) AS c FROM watch_queue_entries WHERE roomId = ? AND state = 'pending'",
    );
    this.statements.countHistorySummary = db.prepare(
      "SELECT COUNT(*) AS c FROM watch_queue_entries WHERE roomId = ? AND state = 'history'",
    );
    this.statements.trimHistory = db.prepare(`
      DELETE FROM watch_queue_entries
      WHERE roomId = ? AND state = 'history' AND id NOT IN (
        SELECT id FROM watch_queue_entries WHERE roomId = ? AND state = 'history' ORDER BY endedAt DESC, rowid DESC LIMIT ?
      )
    `);
    this.statements.listOverHistoryLimit = db.prepare(
      "SELECT roomId FROM watch_queue_entries WHERE state='history' GROUP BY roomId HAVING COUNT(*)>?",
    );
    this.statements.listProgress = db.prepare(
      "SELECT mediaId, position, duration, outcome FROM watch_queue_entries WHERE roomId = ? AND state IN ('current', 'history') ORDER BY updatedAt ASC",
    );
  }
  deleteRoomProgressByRoomId(...values) {
    return this.statements.deleteRoomProgressByRoomId.run(...values);
  }
  deleteQueueEntriesByRoomId(...values) {
    return this.statements.deleteQueueEntriesByRoomId.run(...values);
  }
  findEntry(...values) {
    return this.statements.findEntry.get(...values);
  }
  findCurrent(...values) {
    return this.statements.findCurrent.get(...values);
  }
  findNextPending(...values) {
    return this.statements.findNextPending.get(...values);
  }
  findLatestHistory(...values) {
    return this.statements.findLatestHistory.get(...values);
  }
  countPending(...values) {
    return this.statements.countPending.get(...values);
  }
  insertQueueEntries(...values) {
    return this.statements.insertQueueEntries.run(...values);
  }
  listPending(...values) {
    return this.statements.listPending.all(...values);
  }
  listRoomProgressByRoomId(...values) {
    return this.statements.listRoomProgressByRoomId.all(...values);
  }
  interruptCurrent(...values) {
    return this.statements.interruptCurrent.run(...values);
  }
  skipPending(...values) {
    return this.statements.skipPending.run(...values);
  }
  listPendingIds(...values) {
    return this.statements.listPendingIds.all(...values);
  }
  deleteQueueEntriesById(...values) {
    return this.statements.deleteQueueEntriesById.run(...values);
  }
  closeRankGap(...values) {
    return this.statements.closeRankGap.run(...values);
  }
  clearPending(...values) {
    return this.statements.clearPending.run(...values);
  }
  skipBefore(...values) {
    return this.statements.skipBefore.run(...values);
  }
  shiftRanksAfter(...values) {
    return this.statements.shiftRanksAfter.run(...values);
  }
  closeSuccessorGap(...values) {
    return this.statements.closeSuccessorGap.run(...values);
  }
  startEntry(...values) {
    return this.statements.startEntry.run(...values);
  }
  completeCurrent(...values) {
    return this.statements.completeCurrent.run(...values);
  }
  insertRoomProgress(...values) {
    return this.statements.insertRoomProgress.run(...values);
  }
  endCurrent(...values) {
    return this.statements.endCurrent.run(...values);
  }
  startSuccessor(...values) {
    return this.statements.startSuccessor.run(...values);
  }
  updateQueueEntriesSetRankUpdatedAtByRoomIdState(...values) {
    return this.statements.updateQueueEntriesSetRankUpdatedAtByRoomIdState.run(...values);
  }
  insertQueueEntries3(...values) {
    return this.statements.insertQueueEntries3.run(...values);
  }
  updateQueueEntriesSetPositionUpdatedAtById(...values) {
    return this.statements.updateQueueEntriesSetPositionUpdatedAtById.run(...values);
  }
  listHistory(...values) {
    return this.statements.listHistory.all(...values);
  }
  shiftPendingRanks(...values) {
    return this.statements.shiftPendingRanks.run(...values);
  }
  clearHistory(...values) {
    return this.statements.clearHistory.run(...values);
  }
  updateQueueEntriesSetPositionUpdatedAtByRoomIdState(...values) {
    return this.statements.updateQueueEntriesSetPositionUpdatedAtByRoomIdState.run(...values);
  }
  pagePending(...values) {
    return this.statements.pagePending.all(...values);
  }
  pageHistory(...values) {
    return this.statements.pageHistory.all(...values);
  }
  countHistory(...values) {
    return this.statements.countHistory.get(...values);
  }
  countPendingSummary(...values) {
    return this.statements.countPendingSummary.get(...values);
  }
  countHistorySummary(...values) {
    return this.statements.countHistorySummary.get(...values);
  }
  trimHistory(...values) {
    return this.statements.trimHistory.run(...values);
  }
  listOverHistoryLimit(...values) {
    return this.statements.listOverHistoryLimit.all(...values);
  }
  listProgress(...values) {
    return this.statements.listProgress.all(...values);
  }
}
module.exports = { QueueRepo };
