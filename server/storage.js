'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Forward-only migrations run before listeners start. Rooms/consent are not stored.
function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error('Account database requires a newer uburoom version');
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,retiredInto TEXT);
    CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL,subject TEXT NOT NULL,userId TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,assigned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,subject),UNIQUE(provider,userId));
    CREATE TABLE IF NOT EXISTS credentials(subject TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS browser_logins(id TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS playback_history(id TEXT PRIMARY KEY,userId TEXT NOT NULL,at INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS playback_history_user ON playback_history(userId,at);
    PRAGMA user_version=1;
    COMMIT;`);
}
// Credentials and account metadata only; active players and consent are never durable.
function write(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function deviceStore(file, registry) {
  if (registry) {
    const db = registry.db;
    if (!registry.meta('devicesImported')) {
      const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      if (!Array.isArray(saved) || saved.some(device => !device || typeof device.id !== 'string')) throw new Error('Invalid device database');
      registry.transaction(() => {
        for (const device of saved) db.prepare('INSERT INTO devices VALUES(?,?)').run(device.id, JSON.stringify(device));
        registry.meta('devicesImported', '1');
      });
    }
    const devices = db.prepare('SELECT record FROM devices ORDER BY rowid').all().map(row => JSON.parse(row.record));
    return { devices, save() {
      registry.transaction(() => {
        db.exec('DELETE FROM devices');
        for (const device of devices) db.prepare('INSERT INTO devices VALUES(?,?)').run(device.id, JSON.stringify(device));
      });
      return registry.flush();
    } };
  }
  let devices = [];
  if (file && fs.existsSync(file)) {
    devices = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(devices)) throw new Error('Invalid device database');
  }
  function save() {
    write(file, devices);
  }
  return { devices, save };
}
function loginStore(file, context, vault, registry) {
  if (registry) return databaseLogins(file, context, vault, registry);
  const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const matching = saved.context === context;
  const decoded=(matching && Array.isArray(saved.logins) ? saved.logins : []).map(entry=>{
    if(vault && entry?.[1]?.oauth?.encrypted) entry[1].oauth=vault.open(entry[1].oauth);return entry;
  });
  const logins = new Map(decoded.filter(entry =>
    Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && entry[1] &&
    typeof entry[1].userId === 'string' && typeof entry[1].name === 'string' &&
    (!entry[1].oauth || typeof entry[1].oauth.refreshToken === 'string' && Number.isFinite(entry[1].oauth.expires)) &&
    /^[a-f0-9]{64}$/.test(entry[1].csrf) && (entry[1].expires === null || Number.isFinite(entry[1].expires) && entry[1].expires > Date.now())));
  const store = { logins, ownerName: matching && typeof saved.ownerName === 'string' ? saved.ownerName.slice(0, 100) : '',
    save() { write(file, { context, ownerName: store.ownerName, logins: [...logins].map(([id,login])=>[id,{...login,...(vault&&login.oauth?{oauth:vault.seal(login.oauth)}:{})}]) }); } };
  return store;
}
function databaseLogins(file, context, vault, registry) {
  const db = registry.db;
  if (!registry.meta('loginsImported')) {
    // Decode first: a corrupt envelope must fail startup without importing a
    // partially usable identity set. The original files remain rollback inputs.
    const legacy = loginStore(file, context, vault);
    registry.transaction(() => {
      for (const [id, value] of legacy.logins) db.prepare('INSERT INTO browser_logins VALUES(?,?)').run(id, JSON.stringify({ ...value, ...(value.oauth ? { oauth: vault.seal(value.oauth) } : {}) }));
      registry.meta('loginContext', context); registry.meta('ownerName', legacy.ownerName);
      registry.meta('loginsImported', '1');
    });
  }
  const matching = registry.meta('loginContext') === context;
  const entries = matching ? db.prepare('SELECT id,record FROM browser_logins').all().map(row => [row.id, JSON.parse(row.record)]) : [];
  const logins = new Map(entries.map(([id, value]) => [id, { ...value, ...(value.oauth ? { oauth: vault.open(value.oauth) } : {}) }]).filter(([, value]) => value.expires === null || value.expires > Date.now()));
  // Cache encrypted records so pruning expired logins never re-encrypts every
  // other user's OAuth credentials on the one-second lifecycle sweep.
  const encoded = new Map(entries.map(([id, value]) => [id, { plain: JSON.stringify(logins.get(id)), value: JSON.stringify(value) }]));
  const store = { logins, ownerName: matching ? registry.meta('ownerName') || '' : '', save() {
    registry.transaction(() => {
      for (const id of encoded.keys()) if (!logins.has(id)) { db.prepare('DELETE FROM browser_logins WHERE id=?').run(id); encoded.delete(id); }
      for (const [id, value] of logins) {
        const plain = JSON.stringify(value); if (encoded.get(id)?.plain === plain) continue;
        const record = JSON.stringify({ ...value, ...(value.oauth ? { oauth: vault.seal(value.oauth) } : {}) });
        db.prepare('INSERT INTO browser_logins VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id, record);
        encoded.set(id, { plain, value: record });
      }
      registry.meta('loginContext', context); registry.meta('ownerName', store.ownerName);
    });
    return registry.flush();
  } };
  if (!matching) { db.exec('DELETE FROM browser_logins'); registry.meta('loginContext', context); }
  return store;
}
module.exports = { deviceStore, loginStore, migrate };
