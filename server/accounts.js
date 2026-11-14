'use strict';
const { repositories } = require('./repositories');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('./database');
const { initializeSchema } = require('./storage');

function privateFile(file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
    return;
  }
  const script = `$ErrorActionPreference='Stop'; $taskAcl=[System.Security.AccessControl.FileSecurity]::new(); $taskOwner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $taskAcl.SetOwner($taskOwner); $taskAcl.SetAccessRuleProtection($true,$false); foreach($taskSid in @($taskOwner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$taskRule=[System.Security.AccessControl.FileSystemAccessRule]::new($taskSid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow); [void]$taskAcl.AddAccessRule($taskRule)}; [System.IO.File]::SetAccessControl($env:UBUROOM_PRIVATE_FILE,$taskAcl)`;
  if (
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, UBUROOM_PRIVATE_FILE: file }, windowsHide: true },
    ).status !== 0
  )
    throw new Error('Cannot protect uburoom private files');
}
function credentialVault(file) {
  let key;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    privateFile(file);
    key = fs.readFileSync(file);
  } else key = randomBytes(32);
  if (key.length !== 32) throw new Error('Invalid uburoom credential encryption key');
  return {
    seal(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return {
        encrypted: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: bytes.toString('base64'),
      };
    },
    open(value) {
      if (!value?.encrypted) return value;
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString(),
      );
    },
  };
}

function displayName(value) {
  if (typeof value !== 'string') throw new Error('Invalid display name');
  const name = value.trim().normalize('NFC');
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name))
    throw new Error('Use a display name of 1–80 characters without control or invisible formatting characters');
  return name;
}

class Accounts {
  constructor(file, vault) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.persistence = openDatabase(file, initializeSchema);
    this.db = this.persistence.db;
    try {
      repositories(this.db).accounts.pruneAudit(Date.now());
      this.auditPrunedAt = Date.now();
    } catch (error) {
      this.persistence.abort();
      throw error;
    }
    this.vault = vault;
    this.credentialCache = new Map();
    if (file)
      try {
        privateFile(file);
      } catch (error) {
        Promise.resolve(this.persistence.abort()).catch(() => {});
        throw error;
      }
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /**
   * @param {string} id
   * @returns {{id:string,name:string,revision:number,retiredInto:string|null,signedInAt:number|null,guest:number}|undefined}
   */
  canonical(id) {
    let row = repositories(this.db).accounts.findUsersById(id);
    for (let n = 0; row?.retiredInto && n < 20; n++)
      row = repositories(this.db).accounts.findUsersById(row.retiredInto);
    return row && !row.retiredInto ? row : undefined;
  }
  identity(provider, subject) {
    return repositories(this.db).accounts.findIdentitiesByProviderSubject(provider, String(subject));
  }
  identities(userId) {
    return repositories(this.db).accounts.listIdentitiesByUserId(userId);
  }
  create(name) {
    const id = randomUUID();
    repositories(this.db).accounts.insertUsers(id, name);
    return id;
  }
  // Guests have a typed, unverified name and no provider identity. They are never
  // listed in host search, never linked to a provider and are removed once unused.
  createGuest(name) {
    const id = randomUUID();
    repositories(this.db).accounts.insertGuest(id, displayName(name), Date.now());
    return id;
  }
  isGuest(id) {
    return this.canonical(id)?.guest === 1;
  }
  // Deletes guest accounts that no session, room or pass still uses.
  removeUnusedGuests(inUse) {
    const unused = repositories(this.db)
      .accounts.listUnusedGuests()
      .map(row => row.id)
      .filter(id => !inUse.has(id));
    if (unused.length)
      this.transaction(() => {
        for (const id of unused) {
          repositories(this.db).history.deleteForUser(id);
          repositories(this.db).accounts.deleteUsersById(id);
        }
      });
    return unused;
  }
  rename(userId, value) {
    const user = this.canonical(userId);
    if (!user || typeof value !== 'string') throw new Error('Invalid display name');
    const name = displayName(value);
    repositories(this.db).accounts.updateUsersSetNameById(name, user.id);
    return this.canonical(user.id);
  }
  seen(userId) {
    repositories(this.db).accounts.updateUsersSetSignedInAtById(Date.now(), userId);
  }
  directory() {
    return repositories(this.db)
      .accounts.listDirectory()
      .map(user => ({
        ...user,
        identities: this.identities(user.id)
          .filter(identity => identity.verified)
          .map(({ provider, subject, name }) => ({ provider, subject, name })),
      }));
  }
  resolve(provider, subject, name, verified = true) {
    subject = String(subject);
    const old = this.identity(provider, subject);
    if (old) {
      if (verified)
        this.transaction(() => {
          repositories(this.db).accounts.updateIdentitiesSetVerifiedNameByProviderSubject(name, provider, subject);
          repositories(this.db).accounts.updateUsersSetNameByIdSignedInAt(name, old.userId);
          this.seen(old.userId);
        });
      return this.canonical(old.userId);
    }
    return this.transaction(() => {
      const id = this.create(name);
      repositories(this.db).accounts.insertIdentities(provider, subject, id, name, Number(verified));
      if (verified) this.seen(id);
      return this.canonical(id);
    });
  }
  link(userId, provider, subject, name) {
    const user = this.canonical(userId),
      old = this.identity(provider, subject),
      current = this.identities(user.id).find(i => i.provider === provider);
    if (user.guest === 1) throw new Error('Guest accounts cannot connect Discord or Plex; sign in instead');
    if (current && current.subject !== String(subject))
      throw new Error('This account already has a different ' + provider + ' identity');
    if (old && old.userId !== user.id) return { conflict: this.canonical(old.userId) };
    this.transaction(() => {
      if (old)
        repositories(this.db).accounts.updateIdentitiesSetVerifiedNameByProviderSubject(
          name,
          provider,
          String(subject),
        );
      else repositories(this.db).accounts.insertVerifiedIdentity(provider, String(subject), user.id, name);
      repositories(this.db).accounts.updateUsersSetRevisionById(user.id);
    });
    return { user: this.canonical(user.id) };
  }
  unlink(userId, provider, subject) {
    const user = this.canonical(userId),
      identities = this.identities(user.id);
    if (!identities.some(i => i.provider === provider && i.subject === subject))
      throw new Error('Account connection changed; open Account again');
    const remaining = identities.find(
      i => i.provider !== provider && i.verified && (i.provider !== 'plex' || this.hasCredential(i.subject)),
    );
    if (!remaining) throw new Error('Connect another sign-in method before removing this account');
    this.transaction(() => {
      repositories(this.db).accounts.deleteIdentitiesByUserIdProviderSubject(user.id, provider, subject);
      if (provider === 'plex') repositories(this.db).accounts.deleteCredentialsBySubject(subject);
      repositories(this.db).accounts.updateUsersSetRevisionById(user.id);
      this.audit(user.id, 'self-unlink', { provider, subject });
    });
    if (provider === 'plex') this.credentialCache.delete(subject);
    return this.canonical(user.id);
  }
  merge(survivor, retired, actor, action = 'self-merge', verifiedIdentity) {
    survivor = this.canonical(survivor).id;
    retired = this.canonical(retired).id;
    if (survivor === retired) return survivor;
    const all = [...this.identities(survivor), ...this.identities(retired)];
    if (new Set(all.map(i => i.provider)).size !== all.length)
      throw new Error('Accounts have conflicting login identities');
    return this.transaction(() => {
      repositories(this.db).accounts.updateIdentitiesSetUserIdByUserId(survivor, retired);
      if (verifiedIdentity?.provider && verifiedIdentity?.subject)
        repositories(this.db).accounts.updateIdentitiesSetVerifiedNameByUserIdProviderSubject(
          verifiedIdentity.name || null,
          survivor,
          verifiedIdentity.provider,
          String(verifiedIdentity.subject),
        );
      repositories(this.db).accounts.updateUsersSetRetiredIntoRevisionById(survivor, retired);
      repositories(this.db).accounts.updateUsersSetRevisionSignedInAtById(retired, survivor);
      this.audit(actor, action, { survivor, retired, identities: all });
      return survivor;
    });
  }
  preview(discordId, plexId) {
    const a = this.identity('discord', discordId),
      b = this.identity('plex', plexId),
      ids = [...new Set([a?.userId, b?.userId].filter(Boolean))];
    const users = ids.map(id => this.summary(id));
    const identities = users.flatMap(u => u.identities);
    if (
      identities.some(
        i => (i.provider === 'discord' && i.subject !== discordId) || (i.provider === 'plex' && i.subject !== plexId),
      )
    )
      throw new Error('One account already has a different linked identity');
    return { discordId, plexId, users, version: JSON.stringify(users.map(u => [u.id, u.revision, u.identities])) };
  }
  assign(preview, actor) {
    const current = this.preview(preview.discordId, preview.plexId);
    if (current.version !== preview.version) throw new Error('Accounts changed; preview again');
    let id = current.users[0]?.id;
    if (current.users.length === 2) id = this.merge(id, current.users[1].id, actor, 'owner-merge');
    this.transaction(() => {
      id ||= this.create('Assigned account');
      let changed = false;
      for (const [provider, subject] of [
        ['discord', preview.discordId],
        ['plex', preview.plexId],
      ])
        if (!this.identity(provider, subject)) {
          repositories(this.db).accounts.insertAssignedIdentity(
            provider,
            subject,
            id,
            provider === 'discord' ? preview.discordName || subject : subject,
          );
          changed = true;
        }
      if (changed) repositories(this.db).accounts.updateUsersSetRevisionById(id);
      this.audit(actor, 'owner-match', { userId: id, discordId: preview.discordId, plexId: preview.plexId });
    });
    return id;
  }
  summary(id) {
    const user = this.canonical(id);
    return (
      user && {
        ...user,
        identities: this.identities(user.id).map(i => ({
          ...i,
          authenticated: !!i.verified,
          credentialStored: i.provider === 'plex' && !!this.credential(i.subject),
        })),
      }
    );
  }
  list() {
    return repositories(this.db)
      .accounts.listUsersByRetiredInto()
      .map(u => this.summary(u.id));
  }
  hasCredential(subject) {
    return !!repositories(this.db).accounts.hasCredential(subject);
  }
  credential(subject, value) {
    if (value !== undefined && JSON.stringify(this.credentialCache.get(subject)) !== JSON.stringify(value)) {
      repositories(this.db).accounts.insertCredentials(subject, JSON.stringify(this.vault.seal(value)));
      this.credentialCache.set(subject, structuredClone(value));
    }
    if (this.credentialCache.has(subject)) return structuredClone(this.credentialCache.get(subject));
    const row = repositories(this.db).accounts.findCredential(subject);
    if (!row) return;
    const envelope = JSON.parse(row.value);
    if (envelope.encrypted !== 1) throw new Error('Invalid encrypted credential record');
    const decoded = this.vault.open(envelope);
    this.credentialCache.set(subject, decoded);
    return structuredClone(decoded);
  }
  meta(key, value) {
    if (value !== undefined) repositories(this.db).accounts.insertMeta(key, value);
    return repositories(this.db).accounts.findMetaByKey(key)?.value;
  }
  audit(actor, action, detail) {
    const now = Date.now();
    repositories(this.db).accounts.insertAudit(now, actor, action, JSON.stringify(detail));
    // Retention runs at most hourly, outside the playback observation/tick path.
    if (!this.auditPrunedAt || now - this.auditPrunedAt >= 3600000) {
      repositories(this.db).accounts.pruneAudit(now);
      this.auditPrunedAt = now;
    }
  }
  flush() {
    // Kept as an async service settlement point for existing callers. There is
    // no pending storage: every statement/transaction has already committed.
    return Promise.resolve();
  }
  close() {
    this.credentialCache.clear();
    return this.persistence.close();
  }
}
module.exports = { Accounts, credentialVault, privateFile, displayName };
