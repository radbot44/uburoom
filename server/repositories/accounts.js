'use strict';
// Conservative, fixed retention for account/security investigation evidence.
const AUDIT_RETENTION_DAYS = 365;
const AUDIT_MAX_ROWS = 20000;

class AccountsRepo {
  clearBrowserLogins() {
    this.statements.clearBrowserLogins.run();
  }
  pruneAudit(now) {
    // Keep a year and up to 20,000 events for account/security investigations,
    // while bounding growth from repeated management or sign-in activity.
    this.statements.pruneAuditAge.run(now - AUDIT_RETENTION_DAYS * 86400000);
    this.statements.pruneAuditRows.run();
  }
  constructor(db) {
    this.statements = {};
    this.statements.clearBrowserLogins = db.prepare('DELETE FROM browser_logins');
    this.statements.pruneAuditAge = db.prepare('DELETE FROM audit WHERE at<?');
    this.statements.pruneAuditRows = db.prepare(
      `DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY at DESC,id DESC LIMIT -1 OFFSET ${AUDIT_MAX_ROWS})`,
    );
    this.statements.findUsersById = db.prepare('SELECT * FROM users WHERE id=?');
    this.statements.findIdentitiesByProviderSubject = db.prepare(
      'SELECT * FROM identities WHERE provider=? AND subject=?',
    );
    this.statements.listIdentitiesByUserId = db.prepare(
      'SELECT provider,subject,name,verified,assigned FROM identities WHERE userId=? ORDER BY provider',
    );
    this.statements.insertUsers = db.prepare('INSERT INTO users(id,name) VALUES(?,?)');
    this.statements.insertGuest = db.prepare('INSERT INTO users(id,name,guest,signedInAt) VALUES(?,?,1,?)');
    this.statements.listUnusedGuests = db.prepare(`SELECT id FROM users u WHERE guest=1 AND retiredInto IS NULL
      AND NOT EXISTS(SELECT 1 FROM identities WHERE userId=u.id) AND NOT EXISTS(SELECT 1 FROM watch_rooms WHERE creatorId=u.id)
      AND NOT EXISTS(SELECT 1 FROM watch_room_hosts WHERE userId=u.id) AND NOT EXISTS(SELECT 1 FROM watch_room_host_grants WHERE issuerId=u.id)`);
    this.statements.deleteUsersById = db.prepare('DELETE FROM users WHERE id=?');
    this.statements.updateUsersSetNameById = db.prepare('UPDATE users SET name=? WHERE id=?');
    this.statements.updateUsersSetSignedInAtById = db.prepare(
      'UPDATE users SET signedInAt=COALESCE(signedInAt,?) WHERE id=?',
    );
    this.statements.listDirectory = db.prepare(
      'SELECT id,name,signedInAt FROM users WHERE retiredInto IS NULL AND guest=0',
    );
    this.statements.updateIdentitiesSetVerifiedNameByProviderSubject = db.prepare(
      'UPDATE identities SET verified=1,name=? WHERE provider=? AND subject=?',
    );
    this.statements.updateUsersSetNameByIdSignedInAt = db.prepare(
      'UPDATE users SET name=? WHERE id=? AND signedInAt IS NULL',
    );
    this.statements.insertIdentities = db.prepare(
      'INSERT INTO identities(provider,subject,userId,name,verified) VALUES(?,?,?,?,?)',
    );
    this.statements.insertVerifiedIdentity = db.prepare(
      'INSERT INTO identities(provider,subject,userId,name,verified) VALUES(?,?,?,?,1)',
    );
    this.statements.updateUsersSetRevisionById = db.prepare('UPDATE users SET revision=revision+1 WHERE id=?');
    this.statements.deleteIdentitiesByUserIdProviderSubject = db.prepare(
      'DELETE FROM identities WHERE userId=? AND provider=? AND subject=?',
    );
    this.statements.deleteCredentialsBySubject = db.prepare('DELETE FROM credentials WHERE subject=?');
    this.statements.updateIdentitiesSetUserIdByUserId = db.prepare('UPDATE identities SET userId=? WHERE userId=?');
    this.statements.updateIdentitiesSetVerifiedNameByUserIdProviderSubject = db.prepare(
      'UPDATE identities SET verified=1,name=COALESCE(?,name) WHERE userId=? AND provider=? AND subject=?',
    );
    this.statements.updateUsersSetRetiredIntoRevisionById = db.prepare(
      'UPDATE users SET retiredInto=?,revision=revision+1 WHERE id=?',
    );
    this.statements.updateUsersSetRevisionSignedInAtById = db.prepare(
      'UPDATE users SET revision=revision+1,signedInAt=COALESCE(signedInAt,(SELECT signedInAt FROM users WHERE id=?)) WHERE id=?',
    );
    this.statements.insertAssignedIdentity = db.prepare(
      'INSERT INTO identities(provider,subject,userId,name,assigned) VALUES(?,?,?,?,1)',
    );
    this.statements.listUsersByRetiredInto = db.prepare(
      'SELECT id FROM users WHERE retiredInto IS NULL ORDER BY name LIMIT 200',
    );
    this.statements.hasCredential = db.prepare('SELECT 1 FROM credentials WHERE subject=?');
    this.statements.insertCredentials = db.prepare(
      'INSERT INTO credentials(subject,value) VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET value=excluded.value',
    );
    this.statements.findCredential = db.prepare('SELECT value FROM credentials WHERE subject=?');
    this.statements.insertMeta = db.prepare(
      'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    this.statements.findMetaByKey = db.prepare('SELECT value FROM meta WHERE key=?');
    this.statements.insertAudit = db.prepare('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)');
    this.statements.listMergedUsers = db.prepare(
      'WITH RECURSIVE merged(id) AS (SELECT ? UNION SELECT u.id FROM users u JOIN merged m ON u.retiredInto=m.id) SELECT id FROM merged',
    );
    this.statements.listMetaPrefix = db.prepare('SELECT key,value FROM meta WHERE key LIKE ?');
    this.statements.deleteMetaByKey = db.prepare('DELETE FROM meta WHERE key=?');
    this.statements.listBrowserLogins = db.prepare('SELECT id,record FROM browser_logins');
    this.statements.deleteBrowserLoginsById = db.prepare('DELETE FROM browser_logins WHERE id=?');
    this.statements.insertBrowserLogins = db.prepare(
      'INSERT INTO browser_logins VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
    );
  }
  findUsersById(...values) {
    return this.statements.findUsersById.get(...values);
  }
  findIdentitiesByProviderSubject(...values) {
    return this.statements.findIdentitiesByProviderSubject.get(...values);
  }
  listIdentitiesByUserId(...values) {
    return this.statements.listIdentitiesByUserId.all(...values);
  }
  insertUsers(...values) {
    return this.statements.insertUsers.run(...values);
  }
  insertGuest(...values) {
    return this.statements.insertGuest.run(...values);
  }
  listUnusedGuests(...values) {
    return this.statements.listUnusedGuests.all(...values);
  }
  deleteUsersById(...values) {
    return this.statements.deleteUsersById.run(...values);
  }
  updateUsersSetNameById(...values) {
    return this.statements.updateUsersSetNameById.run(...values);
  }
  updateUsersSetSignedInAtById(...values) {
    return this.statements.updateUsersSetSignedInAtById.run(...values);
  }
  listDirectory(...values) {
    return this.statements.listDirectory.all(...values);
  }
  updateIdentitiesSetVerifiedNameByProviderSubject(...values) {
    return this.statements.updateIdentitiesSetVerifiedNameByProviderSubject.run(...values);
  }
  updateUsersSetNameByIdSignedInAt(...values) {
    return this.statements.updateUsersSetNameByIdSignedInAt.run(...values);
  }
  insertIdentities(...values) {
    return this.statements.insertIdentities.run(...values);
  }
  insertVerifiedIdentity(...values) {
    return this.statements.insertVerifiedIdentity.run(...values);
  }
  updateUsersSetRevisionById(...values) {
    return this.statements.updateUsersSetRevisionById.run(...values);
  }
  deleteIdentitiesByUserIdProviderSubject(...values) {
    return this.statements.deleteIdentitiesByUserIdProviderSubject.run(...values);
  }
  deleteCredentialsBySubject(...values) {
    return this.statements.deleteCredentialsBySubject.run(...values);
  }
  updateIdentitiesSetUserIdByUserId(...values) {
    return this.statements.updateIdentitiesSetUserIdByUserId.run(...values);
  }
  updateIdentitiesSetVerifiedNameByUserIdProviderSubject(...values) {
    return this.statements.updateIdentitiesSetVerifiedNameByUserIdProviderSubject.run(...values);
  }
  updateUsersSetRetiredIntoRevisionById(...values) {
    return this.statements.updateUsersSetRetiredIntoRevisionById.run(...values);
  }
  updateUsersSetRevisionSignedInAtById(...values) {
    return this.statements.updateUsersSetRevisionSignedInAtById.run(...values);
  }
  insertAssignedIdentity(...values) {
    return this.statements.insertAssignedIdentity.run(...values);
  }
  listUsersByRetiredInto(...values) {
    return this.statements.listUsersByRetiredInto.all(...values);
  }
  hasCredential(...values) {
    return this.statements.hasCredential.get(...values);
  }
  insertCredentials(...values) {
    return this.statements.insertCredentials.run(...values);
  }
  findCredential(...values) {
    return this.statements.findCredential.get(...values);
  }
  insertMeta(...values) {
    return this.statements.insertMeta.run(...values);
  }
  findMetaByKey(...values) {
    return this.statements.findMetaByKey.get(...values);
  }
  insertAudit(...values) {
    return this.statements.insertAudit.run(...values);
  }
  listMergedUsers(...values) {
    return this.statements.listMergedUsers.all(...values);
  }
  listMetaPrefix(...values) {
    return this.statements.listMetaPrefix.all(...values);
  }
  deleteMetaByKey(...values) {
    return this.statements.deleteMetaByKey.run(...values);
  }
  listBrowserLogins(...values) {
    return this.statements.listBrowserLogins.all(...values);
  }
  deleteBrowserLoginsById(...values) {
    return this.statements.deleteBrowserLoginsById.run(...values);
  }
  insertBrowserLogins(...values) {
    return this.statements.insertBrowserLogins.run(...values);
  }
}
module.exports = { AccountsRepo };
