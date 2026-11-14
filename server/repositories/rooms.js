'use strict';

class RoomsRepo {
  deleteRoomEventsByRoomId(...values) {
    return this.statements.deleteRoomEventsByRoomId.run(...values);
  }
  constructor(db) {
    this.statements = {};
    this.statements.deleteRoomEventsByRoomId = db.prepare('DELETE FROM watch_room_events WHERE roomId=?');
    this.statements.exists = db.prepare('SELECT 1 FROM watch_rooms WHERE id=?');
    this.slugStatement = db.prepare('SELECT id FROM watch_rooms WHERE slug=?');
    this.statements.inviteCodeExists = db.prepare('SELECT 1 FROM watch_rooms WHERE inviteCode=?');
    this.statements.findRoom = db.prepare('SELECT * FROM watch_rooms WHERE id=?');
    this.statements.listRoomHostsByRoomId = db.prepare(
      'SELECT userId FROM watch_room_hosts WHERE roomId=? ORDER BY userId',
    );
    this.statements.listRoomInvitesByRoomId = db.prepare(
      'SELECT userId FROM watch_room_invites WHERE roomId=? ORDER BY createdAt',
    );
    this.statements.findRoomsBySlugId = db.prepare('SELECT id FROM watch_rooms WHERE slug=? OR id=?');
    this.statements.count = db.prepare('SELECT COUNT(*) AS n FROM watch_rooms');
    this.statements.insertRooms = db.prepare(
      'INSERT INTO watch_rooms(id,creatorId,name,slug,ubumfaWord,visibility,revision,checkpointRevision,queueRevision,createdAt,updatedAt,permissions,bookmark,autoplay,autoQueue,lastAccessedAt,keepEmpty,maxMembers,inviteCode,allowGuests) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.statements.listRooms = db.prepare('SELECT id FROM watch_rooms ORDER BY lastAccessedAt DESC,id');
    this.statements.findByInviteCode = db.prepare('SELECT id FROM watch_rooms WHERE inviteCode=?');
    this.statements.insertRoomInvites = db.prepare('INSERT OR IGNORE INTO watch_room_invites VALUES(?,?,?)');
    this.statements.findRoomInviteBlocksByRoomIdSubject = db.prepare(
      'SELECT 1 FROM watch_room_invite_blocks WHERE roomId=? AND subject=?',
    );
    this.statements.insertRoomInviteBlocks = db.prepare('INSERT OR IGNORE INTO watch_room_invite_blocks VALUES(?,?,?)');
    this.statements.deleteRoomInvitesByRoomIdUserId = db.prepare(
      'DELETE FROM watch_room_invites WHERE roomId=? AND userId=?',
    );
    this.statements.deleteRoomHostGrantsByRoomIdProviderSubject = db.prepare(
      'DELETE FROM watch_room_host_grants WHERE roomId=? AND provider=? AND subject=?',
    );
    this.statements.insertRoomHosts = db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)');
    this.statements.insertRoomHostGrants = db.prepare(
      'INSERT OR IGNORE INTO watch_room_host_grants VALUES(?,?,?,?,?,?)',
    );
    this.statements.updateRoomsSetKeepEmptyById = db.prepare('UPDATE watch_rooms SET keepEmpty=? WHERE id=?');
    this.statements.updateRoomsSetMaxMembersById = db.prepare('UPDATE watch_rooms SET maxMembers=? WHERE id=?');
    this.statements.updateRoomsSetAutoQueueQueueRevisionById = db.prepare(
      'UPDATE watch_rooms SET autoQueue=?,queueRevision=queueRevision+1 WHERE id=?',
    );
    this.statements.updateRoomsSetAutoplayById = db.prepare('UPDATE watch_rooms SET autoplay=? WHERE id=?');
    this.statements.listHosts = db.prepare('SELECT userId FROM watch_room_hosts WHERE roomId=?');
    this.statements.deleteRoomHostsByRoomIdUserId = db.prepare(
      'DELETE FROM watch_room_hosts WHERE roomId=? AND userId=?',
    );
    this.statements.updateRoomsSetInviteCodeById = db.prepare('UPDATE watch_rooms SET inviteCode=? WHERE id=?');
    this.statements.deleteRoomInviteBlocksByRoomId = db.prepare('DELETE FROM watch_room_invite_blocks WHERE roomId=?');
    this.statements.updateRoomsSetAllowGuestsById = db.prepare('UPDATE watch_rooms SET allowGuests=? WHERE id=?');
    this.statements.updateRoomsSetBookmarkCheckpointRevisionById = db.prepare(
      'UPDATE watch_rooms SET bookmark=NULL,checkpointRevision=checkpointRevision+1 WHERE id=?',
    );
    this.statements.deleteRoomHostGrantsByRoomId = db.prepare('DELETE FROM watch_room_host_grants WHERE roomId=?');
    this.statements.deleteRoomInvitesByRoomId = db.prepare('DELETE FROM watch_room_invites WHERE roomId=?');
    this.statements.deleteRoomHostsByRoomId = db.prepare('DELETE FROM watch_room_hosts WHERE roomId=?');
    this.statements.deleteRoomsById = db.prepare('DELETE FROM watch_rooms WHERE id=?');
    this.statements.updateRoomsSetCreatorIdNameSlugVisibilityPermissionsRevisionUpdatedAtLastAccessedAtById =
      db.prepare(
        'UPDATE watch_rooms SET creatorId=?,name=?,slug=?,visibility=?,permissions=?,revision=revision+1,updatedAt=?,lastAccessedAt=? WHERE id=?',
      );
    this.statements.listRoomHostGrantsByRoomId = db.prepare(
      'SELECT provider,subject,name FROM watch_room_host_grants WHERE roomId=? ORDER BY name,provider,subject',
    );
    this.statements.listRoomHostGrantsByUserIdVerified = db.prepare(
      'SELECT g.* FROM watch_room_host_grants g JOIN identities i ON i.provider=g.provider AND i.subject=g.subject WHERE i.userId=? AND i.verified=1',
    );
    this.statements.updateRoomsSetRevisionById = db.prepare('UPDATE watch_rooms SET revision=revision+1 WHERE id=?');
    this.statements.updateRoomsSetLastAccessedAtById = db.prepare(
      'UPDATE watch_rooms SET lastAccessedAt=MAX(lastAccessedAt,?) WHERE id=?',
    );
    this.statements.updateRoomsSetBookmarkCheckpointRevisionUpdatedAtById = db.prepare(
      'UPDATE watch_rooms SET bookmark=?,checkpointRevision=checkpointRevision+1,updatedAt=? WHERE id=?',
    );
    this.statements.updateRoomsSetAutoQueueQueueRevisionUpdatedAtLastAccessedAtById = db.prepare(
      'UPDATE watch_rooms SET autoQueue = ?, queueRevision = queueRevision + 1, updatedAt = ?, lastAccessedAt = ? WHERE id = ?',
    );
    this.statements.updateRoomsSetQueueRevisionUpdatedAtLastAccessedAtById = db.prepare(
      'UPDATE watch_rooms SET queueRevision = queueRevision + 1, updatedAt = ?, lastAccessedAt = ? WHERE id = ?',
    );
    this.statements.updateRoomsSetAutoplayRevisionUpdatedAtLastAccessedAtById = db.prepare(
      'UPDATE watch_rooms SET autoplay = ?, revision = revision + 1, updatedAt = ?, lastAccessedAt = ? WHERE id = ?',
    );
    this.statements.updateRoomsSetAutoQueueById = db.prepare('UPDATE watch_rooms SET autoQueue = ? WHERE id = ?');
    this.statements.saveQueueAndAutoBookmark = db.prepare(`
        UPDATE watch_rooms
        SET bookmark = ?, autoQueue = ?, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
        WHERE id = ?
      `);
    this.statements.clearBookmark = db.prepare(
      'UPDATE watch_rooms SET bookmark = NULL, checkpointRevision = checkpointRevision + 1 WHERE id = ?',
    );
    this.statements.clearQueueBookmark = db.prepare(`
        UPDATE watch_rooms
        SET bookmark = NULL, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
        WHERE id = ?
      `);
    this.statements.saveQueueBookmark = db.prepare(`
          UPDATE watch_rooms
          SET bookmark = ?, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
          WHERE id = ?
        `);
    this.statements.saveTransitionBookmark = db.prepare(`
          UPDATE watch_rooms
          SET bookmark = ?, autoQueue = ?, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
          WHERE id = ?
        `);
    this.statements.savePositionBookmark = db.prepare(
      'UPDATE watch_rooms SET bookmark = ?, checkpointRevision = checkpointRevision + 1, updatedAt = ? WHERE id = ?',
    );
    this.statements.findQueueSettings = db.prepare(
      'SELECT queueRevision,autoQueue,autoplay FROM watch_rooms WHERE id = ?',
    );
    this.statements.updateRoomsSetQueueRevisionById = db.prepare(
      'UPDATE watch_rooms SET queueRevision=queueRevision+1 WHERE id=?',
    );
    this.statements.listRoomsByLiveState = db.prepare('SELECT id FROM watch_rooms WHERE liveState IS NOT NULL');
    this.statements.clearLiveState = db.prepare('UPDATE watch_rooms SET liveState=NULL WHERE id=?');
    this.statements.listRoomsByLastAccessedAt = db.prepare(
      'SELECT id FROM watch_rooms WHERE lastAccessedAt<=? ORDER BY lastAccessedAt,id',
    );
    this.statements.updateRoomsSetCreatorIdById = db.prepare('UPDATE watch_rooms SET creatorId=? WHERE id=?');
    this.statements.updateRoomsSetNameSlugKeepEmptyById = db.prepare(
      "UPDATE watch_rooms SET name='Room',slug='room',keepEmpty=1 WHERE id=?",
    );
    this.statements.resetRoom = db.prepare(
      "UPDATE watch_rooms SET bookmark=NULL,checkpointRevision=checkpointRevision+1,queueRevision=queueRevision+1,revision=revision+1,autoplay=1,autoQueue=NULL,liveState=NULL,maxMembers=NULL,permissions=?,name=?,visibility='public' WHERE id=?",
    );
    this.statements.saveLiveState = db.prepare('UPDATE watch_rooms SET liveState=? WHERE id=?');
    this.statements.findRoomEventsById = db.prepare('SELECT * FROM watch_room_events WHERE id=?');
    this.statements.listRoomEventsByRoomIdEnd = db.prepare(
      'SELECT * FROM watch_room_events WHERE roomId=? AND end>? ORDER BY start,id',
    );
    this.statements.findRoomEventsByRoomIdEnd = db.prepare(
      'SELECT 1 FROM watch_room_events WHERE roomId=? AND end>? LIMIT 1',
    );
    this.statements.insertRoomEvents =
      db.prepare(`INSERT INTO watch_room_events(id,roomId,creatorId,title,description,start,end,timeZone,state,createdAt,updatedAt,discord) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,start=excluded.start,end=excluded.end,timeZone=excluded.timeZone,
      state=excluded.state,updatedAt=excluded.updatedAt,discord=excluded.discord`);
    this.statements.deleteRoomEventsById = db.prepare('DELETE FROM watch_room_events WHERE id=?');
    this.statements.listRoomEventsByEndState = db.prepare(
      "SELECT * FROM watch_room_events WHERE end>? AND state='scheduled' ORDER BY start,id",
    );
    this.statements.listRoomEventsByEnd = db.prepare('SELECT id,roomId FROM watch_room_events WHERE end<=?');
    this.statements.listRoomEventsByDiscordEnd = db.prepare(
      'SELECT DISTINCT roomId FROM watch_room_events WHERE discord IS NOT NULL AND end>?',
    );
  }
  exists(...values) {
    return this.statements.exists.get(...values);
  }
  inviteCodeExists(...values) {
    return this.statements.inviteCodeExists.get(...values);
  }
  findRoom(...values) {
    return this.statements.findRoom.get(...values);
  }
  listRoomHostsByRoomId(...values) {
    return this.statements.listRoomHostsByRoomId.all(...values);
  }
  listRoomInvitesByRoomId(...values) {
    return this.statements.listRoomInvitesByRoomId.all(...values);
  }
  findRoomsBySlugId(...values) {
    return this.statements.findRoomsBySlugId.get(...values);
  }
  count(...values) {
    return this.statements.count.get(...values);
  }
  insertRooms(...values) {
    return this.statements.insertRooms.run(...values);
  }
  listRooms(...values) {
    return this.statements.listRooms.all(...values);
  }
  findByInviteCode(...values) {
    return this.statements.findByInviteCode.get(...values);
  }
  insertRoomInvites(...values) {
    return this.statements.insertRoomInvites.run(...values);
  }
  findRoomInviteBlocksByRoomIdSubject(...values) {
    return this.statements.findRoomInviteBlocksByRoomIdSubject.get(...values);
  }
  insertRoomInviteBlocks(...values) {
    return this.statements.insertRoomInviteBlocks.run(...values);
  }
  deleteRoomInvitesByRoomIdUserId(...values) {
    return this.statements.deleteRoomInvitesByRoomIdUserId.run(...values);
  }
  deleteRoomHostGrantsByRoomIdProviderSubject(...values) {
    return this.statements.deleteRoomHostGrantsByRoomIdProviderSubject.run(...values);
  }
  insertRoomHosts(...values) {
    return this.statements.insertRoomHosts.run(...values);
  }
  insertRoomHostGrants(...values) {
    return this.statements.insertRoomHostGrants.run(...values);
  }
  updateRoomsSetKeepEmptyById(...values) {
    return this.statements.updateRoomsSetKeepEmptyById.run(...values);
  }
  updateRoomsSetMaxMembersById(...values) {
    return this.statements.updateRoomsSetMaxMembersById.run(...values);
  }
  updateRoomsSetAutoQueueQueueRevisionById(...values) {
    return this.statements.updateRoomsSetAutoQueueQueueRevisionById.run(...values);
  }
  updateRoomsSetAutoplayById(...values) {
    return this.statements.updateRoomsSetAutoplayById.run(...values);
  }
  listHosts(...values) {
    return this.statements.listHosts.all(...values);
  }
  deleteRoomHostsByRoomIdUserId(...values) {
    return this.statements.deleteRoomHostsByRoomIdUserId.run(...values);
  }
  updateRoomsSetInviteCodeById(...values) {
    return this.statements.updateRoomsSetInviteCodeById.run(...values);
  }
  deleteRoomInviteBlocksByRoomId(...values) {
    return this.statements.deleteRoomInviteBlocksByRoomId.run(...values);
  }
  updateRoomsSetAllowGuestsById(...values) {
    return this.statements.updateRoomsSetAllowGuestsById.run(...values);
  }
  updateRoomsSetBookmarkCheckpointRevisionById(...values) {
    return this.statements.updateRoomsSetBookmarkCheckpointRevisionById.run(...values);
  }
  deleteRoomHostGrantsByRoomId(...values) {
    return this.statements.deleteRoomHostGrantsByRoomId.run(...values);
  }
  deleteRoomInvitesByRoomId(...values) {
    return this.statements.deleteRoomInvitesByRoomId.run(...values);
  }
  deleteRoomHostsByRoomId(...values) {
    return this.statements.deleteRoomHostsByRoomId.run(...values);
  }
  deleteRoomsById(...values) {
    return this.statements.deleteRoomsById.run(...values);
  }
  updateRoomsSetCreatorIdNameSlugVisibilityPermissionsRevisionUpdatedAtLastAccessedAtById(...values) {
    return this.statements.updateRoomsSetCreatorIdNameSlugVisibilityPermissionsRevisionUpdatedAtLastAccessedAtById.run(
      ...values,
    );
  }
  listRoomHostGrantsByRoomId(...values) {
    return this.statements.listRoomHostGrantsByRoomId.all(...values);
  }
  listRoomHostGrantsByUserIdVerified(...values) {
    return this.statements.listRoomHostGrantsByUserIdVerified.all(...values);
  }
  updateRoomsSetRevisionById(...values) {
    return this.statements.updateRoomsSetRevisionById.run(...values);
  }
  updateRoomsSetLastAccessedAtById(...values) {
    return this.statements.updateRoomsSetLastAccessedAtById.run(...values);
  }
  updateRoomsSetBookmarkCheckpointRevisionUpdatedAtById(...values) {
    return this.statements.updateRoomsSetBookmarkCheckpointRevisionUpdatedAtById.run(...values);
  }
  updateRoomsSetAutoQueueQueueRevisionUpdatedAtLastAccessedAtById(...values) {
    return this.statements.updateRoomsSetAutoQueueQueueRevisionUpdatedAtLastAccessedAtById.run(...values);
  }
  updateRoomsSetQueueRevisionUpdatedAtLastAccessedAtById(...values) {
    return this.statements.updateRoomsSetQueueRevisionUpdatedAtLastAccessedAtById.run(...values);
  }
  updateRoomsSetAutoplayRevisionUpdatedAtLastAccessedAtById(...values) {
    return this.statements.updateRoomsSetAutoplayRevisionUpdatedAtLastAccessedAtById.run(...values);
  }
  updateRoomsSetAutoQueueById(...values) {
    return this.statements.updateRoomsSetAutoQueueById.run(...values);
  }
  saveQueueAndAutoBookmark(...values) {
    return this.statements.saveQueueAndAutoBookmark.run(...values);
  }
  clearBookmark(...values) {
    return this.statements.clearBookmark.run(...values);
  }
  clearQueueBookmark(...values) {
    return this.statements.clearQueueBookmark.run(...values);
  }
  saveQueueBookmark(...values) {
    return this.statements.saveQueueBookmark.run(...values);
  }
  saveTransitionBookmark(...values) {
    return this.statements.saveTransitionBookmark.run(...values);
  }
  savePositionBookmark(...values) {
    return this.statements.savePositionBookmark.run(...values);
  }
  findQueueSettings(...values) {
    return this.statements.findQueueSettings.get(...values);
  }
  updateRoomsSetQueueRevisionById(...values) {
    return this.statements.updateRoomsSetQueueRevisionById.run(...values);
  }
  listRoomsByLiveState(...values) {
    return this.statements.listRoomsByLiveState.all(...values);
  }
  clearLiveState(...values) {
    return this.statements.clearLiveState.run(...values);
  }
  listRoomsByLastAccessedAt(...values) {
    return this.statements.listRoomsByLastAccessedAt.all(...values);
  }
  updateRoomsSetCreatorIdById(...values) {
    return this.statements.updateRoomsSetCreatorIdById.run(...values);
  }
  updateRoomsSetNameSlugKeepEmptyById(...values) {
    return this.statements.updateRoomsSetNameSlugKeepEmptyById.run(...values);
  }
  resetRoom(...values) {
    return this.statements.resetRoom.run(...values);
  }
  saveLiveState(...values) {
    return this.statements.saveLiveState.run(...values);
  }
  findRoomEventsById(...values) {
    return this.statements.findRoomEventsById.get(...values);
  }
  listRoomEventsByRoomIdEnd(...values) {
    return this.statements.listRoomEventsByRoomIdEnd.all(...values);
  }
  findRoomEventsByRoomIdEnd(...values) {
    return this.statements.findRoomEventsByRoomIdEnd.get(...values);
  }
  insertRoomEvents(...values) {
    return this.statements.insertRoomEvents.run(...values);
  }
  deleteRoomEventsById(...values) {
    return this.statements.deleteRoomEventsById.run(...values);
  }
  listRoomEventsByEndState(...values) {
    return this.statements.listRoomEventsByEndState.all(...values);
  }
  listRoomEventsByEnd(...values) {
    return this.statements.listRoomEventsByEnd.all(...values);
  }
  listRoomEventsByDiscordEnd(...values) {
    return this.statements.listRoomEventsByDiscordEnd.all(...values);
  }
}
module.exports = { RoomsRepo };
