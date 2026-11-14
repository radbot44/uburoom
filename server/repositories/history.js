'use strict';
const { historyProjection } = require('../history-projection');

class HistoryRepo {
  prune(now) {
    this.statements.deleteBefore.run(now - 90 * 86400000);
    this.statements.pruneRows.run();
  }
  async history(ids) {
    if (this.reads.size >= 8) throw Object.assign(new Error('History is busy; retry shortly'), { status: 503 });
    // SQL shape depends on the number of merged accounts, not the history size.
    // Bound prepared-shape caching too; no history rows survive the request.
    let queries = this.projections.get(ids.length);
    if (!queries) {
      const where = 'FROM playback_history WHERE userId IN (' + ids.map(() => '?').join(',') + ')';
      queries = {
        size: this.db.prepare('SELECT COALESCE(SUM(length(record)),0) AS bytes ' + where),
        rows: this.db.prepare('SELECT record ' + where + ' ORDER BY at DESC'),
      };
      if (this.projections.size >= 8) this.projections.delete(this.projections.keys().next().value);
      this.projections.set(ids.length, queries);
    }
    if (queries.size.get(...ids).bytes > 32 * 1024 * 1024)
      throw Object.assign(new Error('History exceeds the current read budget; retry after retention cleanup'), {
        status: 503,
      });
    const job = historyProjection(queries.rows.all(...ids));
    this.reads.add(job);
    try {
      return await job;
    } finally {
      this.reads.delete(job);
    }
  }
  constructor(db) {
    this.db = db;
    this.reads = new Set();
    this.projections = new Map();
    this.statements = {};
    this.statements.pruneRows = db.prepare(
      'DELETE FROM playback_history WHERE id IN (SELECT id FROM playback_history ORDER BY at DESC LIMIT -1 OFFSET 5000)',
    );
    this.statements.deleteForUser = db.prepare('DELETE FROM playback_history WHERE userId=?');
    this.statements.listInterrupted = db.prepare(
      "SELECT * FROM playback_history WHERE json_extract(record,'$.endedAt') IS NULL",
    );
    this.statements.deleteBefore = db.prepare('DELETE FROM playback_history WHERE at<?');
    this.statements.save = db.prepare(
      'INSERT INTO playback_history VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,record=excluded.record',
    );
  }
  deleteForUser(...values) {
    return this.statements.deleteForUser.run(...values);
  }
  listInterrupted(...values) {
    return this.statements.listInterrupted.all(...values);
  }
  deleteBefore(...values) {
    return this.statements.deleteBefore.run(...values);
  }
  save(...values) {
    return this.statements.save.run(...values);
  }
}
module.exports = { HistoryRepo };
