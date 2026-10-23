'use strict';
// First-release baseline. Future published schemas add explicit forward migrations.
// Never repair or upgrade an unpublished layout implicitly.
function initializeSchema(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 7) throw new Error('Account database requires a newer uburoom version');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (version === 6 || version === 7) {
    const columns = { users:['id','name','revision','retiredInto','signedInAt'], identities:['provider','subject','userId','name','verified','assigned'],
      credentials:['subject','value'], meta:['key','value'], audit:['id','at','actor','action','detail'], ...(version === 6 ? {devices:['id','record']} : {}),
      browser_logins:['id','record'], playback_history:['id','userId','at','record'],
      watch_rooms:['id','creatorId','name','visibility','revision','checkpointRevision','queueRevision','createdAt','updatedAt','permissions','bookmark','autoQueue','autoplay','lastAccessedAt','keepEmpty','maxMembers','liveState'],
      watch_room_hosts:['roomId','userId'], watch_room_host_grants:['roomId','provider','subject','name','issuerId','createdAt'],
      watch_room_progress:['roomId','serverId','mediaId'],
      watch_queue_entries:['id','roomId','state','rank','serverId','mediaId','type','title','parentTitle','grandparentTitle','thumb','duration','position','outcome','provenance','createdAt','startedAt','endedAt','updatedAt'] };
    if (tables.length !== Object.keys(columns).length) throw new Error('Unsupported pre-release database; review a manual state transfer before starting');
    for (const [table, expected] of Object.entries(columns)) {
      const actual = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name);
      if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) throw new Error('Unsupported pre-release database; restore a matched backup or review a manual state transfer before starting');
    }
    if (version === 6) db.exec('BEGIN IMMEDIATE; DROP TABLE devices; PRAGMA user_version=7; COMMIT;');
    return;
  }
  if (version !== 0 || tables.length) throw new Error('Unsupported pre-release database; restore a matched backup or review a manual state transfer before starting');
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,retiredInto TEXT,signedInAt INTEGER);
    CREATE TABLE identities(provider TEXT NOT NULL,subject TEXT NOT NULL,userId TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,assigned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,subject),UNIQUE(provider,userId));
    CREATE TABLE credentials(subject TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE browser_logins(id TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE playback_history(id TEXT PRIMARY KEY,userId TEXT NOT NULL,at INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE INDEX playback_history_user ON playback_history(userId,at);
    CREATE TABLE watch_rooms(id TEXT PRIMARY KEY,creatorId TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,visibility TEXT NOT NULL,revision INTEGER NOT NULL,checkpointRevision INTEGER NOT NULL,queueRevision INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,permissions TEXT NOT NULL,bookmark TEXT,autoQueue TEXT,autoplay INTEGER NOT NULL DEFAULT 1 CHECK(autoplay IN (0,1)),lastAccessedAt INTEGER NOT NULL,keepEmpty INTEGER NOT NULL DEFAULT 0 CHECK(keepEmpty IN (0,1)),maxMembers INTEGER,liveState TEXT);
    CREATE INDEX watch_rooms_accessed ON watch_rooms(lastAccessedAt,id);
    CREATE TABLE watch_room_progress(roomId TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,serverId TEXT NOT NULL,mediaId TEXT NOT NULL,PRIMARY KEY(roomId,serverId,mediaId));
    CREATE TABLE watch_room_hosts(roomId TEXT NOT NULL REFERENCES watch_rooms(id),userId TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(roomId,userId));
    CREATE INDEX watch_room_hosts_user ON watch_room_hosts(userId,roomId);
    CREATE TABLE watch_room_host_grants(roomId TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,provider TEXT NOT NULL,subject TEXT NOT NULL,name TEXT NOT NULL,issuerId TEXT NOT NULL REFERENCES users(id),createdAt INTEGER NOT NULL,PRIMARY KEY(roomId,provider,subject));
    CREATE INDEX watch_room_host_grants_subject ON watch_room_host_grants(provider,subject,roomId);
    CREATE TABLE watch_queue_entries(id TEXT PRIMARY KEY,roomId TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,state TEXT NOT NULL,rank INTEGER,serverId TEXT NOT NULL,mediaId TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,parentTitle TEXT,grandparentTitle TEXT,thumb TEXT,duration REAL NOT NULL,position REAL NOT NULL DEFAULT 0,outcome TEXT,provenance TEXT,createdAt INTEGER NOT NULL,startedAt INTEGER,endedAt INTEGER,updatedAt INTEGER NOT NULL);
    CREATE INDEX watch_queue_room_state_rank ON watch_queue_entries(roomId, state, rank);
    CREATE INDEX watch_queue_room_history ON watch_queue_entries(roomId, state, endedAt DESC);
    CREATE UNIQUE INDEX watch_queue_current ON watch_queue_entries(roomId) WHERE state='current';
    PRAGMA user_version=7;
    COMMIT;`);
}
// Fixtures without a database stay ephemeral; production always supplies Accounts.
function loginStore(context, vault, registry) {
  if (!registry) return { logins: new Map(), ownerName: '', save() {} };
  const db = registry.db;
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
module.exports = { loginStore, initializeSchema };
