'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

// Only startup touches disk here. Runtime SQL targets memory; atomic changesets
// are written to the same accounts.sqlite by one bounded worker.
function openDatabase(file, initializeSchema) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  if (!file) { initializeSchema(db); return { db, flush: async () => {}, close: () => db.close(), abort: () => db.close() }; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const disk = new DatabaseSync(file);
  try { initializeSchema(disk); disk.exec('PRAGMA journal_mode=DELETE;'); }
  catch (error) { db.close(); throw error; }
  finally { disk.close(); }
  db.prepare('ATTACH DATABASE ? AS durable').run(file);
  try {
    const schema = db.prepare("SELECT type,name,sql FROM durable.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type='index'").all();
    for (const row of schema) if (row.type === 'table' || row.type === 'index') db.exec(row.sql);
    for (const row of schema.filter(row => row.type === 'table')) {
      const name = '"' + row.name.replaceAll('"', '""') + '"';
      db.exec(`INSERT INTO main.${name} SELECT * FROM durable.${name}`);
    }
  } finally { db.exec('DETACH DATABASE durable'); }
  let session = db.createSession(), serial = Promise.resolve(), failure, closing = false, sequence = 0, pendingBytes = 0, batch;
  const worker = new Worker(path.join(__dirname, 'storage-worker.js'), { workerData: { file } });
  const pending = new Map();
  function fail() {
    if(!failure){failure=Object.assign(new Error('Account storage unavailable; restart after checking the database and disk'),{status:503});console.error('[uburoom] '+failure.message);}
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  }
  worker.on('error', fail);
  worker.on('exit', () => { if (!closing || pending.size) fail(); });
  worker.on('message', message => {
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.error) { request.reject(new Error(message.error)); fail(); } else request.resolve();
  });
  function send(changes, close = false) {
    return new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++sequence; pending.set(id, { resolve, reject });
      worker.postMessage({ id, changes, close });
    });
  }
  function flush() {
    const rejected=()=>{const promise=Promise.reject(failure);promise.catch(()=>{});return promise;};
    if (failure) return rejected();
    const changes = session.changeset(); session.close(); session = db.createSession();
    if (!changes.length) return serial;
    pendingBytes += changes.byteLength;
    if (pendingBytes > 16 * 1024 * 1024) { fail(); return rejected(); }
    if(!batch){
      const current=batch={changes:[],bytes:0};
      serial=serial.then(async()=>{
        // Coalesce this event-loop turn's mutations into one disk transaction.
        await new Promise(setImmediate);batch=undefined;await send(current.changes);
      }).finally(()=>{pendingBytes-=current.bytes;});
      serial.catch(fail);
    }
    batch.changes.push(changes);batch.bytes+=changes.byteLength;
    return serial;
  }
  const timer = setInterval(() => { void flush().catch(() => {}); }, 250); timer.unref();
  return { db, flush, get error(){return failure;}, abort() {
    clearInterval(timer);closing=true;failure||=new Error('Account startup cancelled');
    for(const request of pending.values())request.reject(failure);pending.clear();
    session.close();db.close();return worker.terminate();
  }, async close() {
    clearInterval(timer);
    try { await flush(); closing = true; await send(undefined, true); }
    finally { closing = true; session.close(); db.close(); await worker.terminate(); }
  } };
}
module.exports = { openDatabase };
