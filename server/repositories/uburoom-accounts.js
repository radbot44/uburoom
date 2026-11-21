'use strict';
// uburoom account passwords and one-time links (table uburoom_accounts). The account's
// identity row is identities('uburoom', subject); both change in one transaction.

const PUBLIC = `a.subject,a.username,a.disabled,a.createdAt,a.updatedAt,a.linkExpires,a.linkPurpose,
  a.passwordHash IS NOT NULL AS passwordSet,i.userId,u.name,u.signedInAt`;
const JOINED = `FROM uburoom_accounts a JOIN identities i ON i.provider='uburoom' AND i.subject=a.subject
  JOIN users u ON u.id=i.userId`;

class UburoomAccountsRepo {
  constructor(db) {
    this.statements = {
      insert: db.prepare(`INSERT INTO uburoom_accounts(subject,username,passwordHash,passwordSalt,passwordParams,
        linkHash,linkExpires,linkPurpose,disabled,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,0,?,?)`),
      bySubject: db.prepare('SELECT * FROM uburoom_accounts WHERE subject=?'),
      byUsername: db.prepare('SELECT * FROM uburoom_accounts WHERE username=?'),
      byLink: db.prepare('SELECT * FROM uburoom_accounts WHERE linkHash=?'),
      publicBySubject: db.prepare(`SELECT ${PUBLIC} ${JOINED} WHERE a.subject=?`),
      list: db.prepare(`SELECT ${PUBLIC} ${JOINED} ORDER BY a.username LIMIT 1000`),
      setLink: db.prepare(
        'UPDATE uburoom_accounts SET linkHash=?,linkExpires=?,linkPurpose=?,updatedAt=? WHERE subject=?',
      ),
      setPassword: db.prepare(`UPDATE uburoom_accounts SET passwordHash=?,passwordSalt=?,passwordParams=?,
        linkHash=NULL,linkExpires=NULL,linkPurpose=NULL,updatedAt=? WHERE subject=? AND linkHash=? AND linkExpires>? AND disabled=0`),
      setDisabled: db.prepare(`UPDATE uburoom_accounts SET disabled=?,updatedAt=?,
        linkHash=CASE WHEN ?=1 THEN NULL ELSE linkHash END,linkExpires=CASE WHEN ?=1 THEN NULL ELSE linkExpires END,
        linkPurpose=CASE WHEN ?=1 THEN NULL ELSE linkPurpose END WHERE subject=?`),
      identityVerified: db.prepare("UPDATE identities SET verified=? WHERE provider='uburoom' AND subject=?"),
      byUser: db.prepare(`SELECT a.* FROM uburoom_accounts a JOIN identities i ON i.provider='uburoom'
        AND i.subject=a.subject WHERE i.userId=?`),
    };
  }
  insert(subject, username, password, link, now) {
    return this.statements.insert.run(
      subject,
      username,
      password?.hash ?? null,
      password?.salt ?? null,
      password?.params ?? null,
      link?.hash ?? null,
      link?.expires ?? null,
      link?.purpose ?? null,
      now,
      now,
    );
  }
  bySubject(subject) {
    return this.statements.bySubject.get(subject);
  }
  byUsername(username) {
    return this.statements.byUsername.get(username);
  }
  byLink(hash) {
    return this.statements.byLink.get(hash);
  }
  byUser(userId) {
    return this.statements.byUser.get(userId);
  }
  publicBySubject(subject) {
    return this.statements.publicBySubject.get(subject);
  }
  list() {
    return this.statements.list.all();
  }
  setLink(subject, link, now) {
    return this.statements.setLink.run(link.hash, link.expires, link.purpose, now, subject);
  }
  /** Sets the password only while the named link is still current; returns whether it did. */
  setPassword(subject, linkHash, password, now) {
    return (
      this.statements.setPassword.run(password.hash, password.salt, password.params, now, subject, linkHash, now)
        .changes === 1
    );
  }
  setDisabled(subject, disabled, now) {
    const flag = disabled ? 1 : 0;
    return this.statements.setDisabled.run(flag, now, flag, flag, flag, subject).changes === 1;
  }
  identityVerified(subject, verified) {
    return this.statements.identityVerified.run(verified ? 1 : 0, subject);
  }
}
module.exports = { UburoomAccountsRepo };
