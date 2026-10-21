'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {Accounts,credentialVault}=require('../server/accounts');
const {deviceStore,loginStore}=require('../server/storage');

function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-storage-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,file:path.join(directory,'accounts.sqlite'),vault:credentialVault()};
}
test('SQLite alone preserves devices, contexts and encrypted logins across restart',async t=>{
  const {directory,file,vault}=fixture(t),deviceFile=path.join(directory,'devices.json'),loginFile=path.join(directory,'logins.json');
  const device={id:'device',credentialHash:'c'.repeat(64)},id='a'.repeat(64),value={userId:'user',name:'Alice',csrf:'b'.repeat(64),expires:null,oauth:{refreshToken:'private-test-token',expires:9999999999999}};
  fs.writeFileSync(deviceFile,'invalid legacy data');fs.writeFileSync(loginFile,'invalid legacy data');
  let accounts=new Accounts(file,vault);
  const devices=deviceStore(accounts),logins=loginStore('one',vault,accounts);
  assert.deepEqual(devices.devices,[]);assert.equal(logins.logins.size,0);
  devices.devices.push(device);logins.logins.set(id,value);await devices.save();await logins.save();
  assert.deepEqual(devices.devices,[device]);assert.equal(logins.logins.get(id).oauth.refreshToken,value.oauth.refreshToken);
  await accounts.flush();
  const read=new DatabaseSync(file);assert.ok(!read.prepare('SELECT record FROM browser_logins').get().record.includes('private-test-token'));read.close();
  logins.logins.delete(id);await logins.save();devices.devices.length=0;await devices.save();await accounts.close();
  accounts=new Accounts(file,vault);
  try {
    assert.equal(deviceStore(accounts).devices.length,0);
    assert.equal(loginStore('one',vault,accounts).logins.size,0,'legacy login is not reimported after logout');
    const next=loginStore('two',vault,accounts);next.logins.set(id,value);await next.save();
    assert.equal(loginStore('two',vault,accounts).logins.size,1,'new sign-in survives an authorization context change');
    assert.equal(loginStore('one',vault,accounts).logins.size,0,'old context cannot reuse a login');
  } finally {await accounts.close();}
});
test('disk locks delay persistence acknowledgement while the main playback event loop keeps running',async t=>{
  const {file,vault}=fixture(t),accounts=new Accounts(file,vault);await accounts.flush();
  const lock=new DatabaseSync(file);lock.exec('BEGIN EXCLUSIVE');
  let ticks=0,completed=false;const timer=setInterval(()=>ticks++,5);
  const id=accounts.resolve('plex','101','Alice').id,flush=accounts.flush().then(()=>{completed=true;});
  try {
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(completed,false);assert.ok(ticks>=10,'timer executes while the disk writer waits for its lock');
    assert.equal(accounts.canonical(id).name,'Alice','in-memory reads remain available');
    lock.exec('COMMIT');await flush;
  } finally {clearInterval(timer);lock.close();await accounts.close();}
  const restarted=new Accounts(file,vault);assert.equal(restarted.canonical(id).name,'Alice');await restarted.close();
});
test('worker write conflicts fail future durability acknowledgements without silently overwriting another writer',async t=>{
  const {file,vault}=fixture(t),accounts=new Accounts(file,vault);await accounts.flush();
  const disk=new DatabaseSync(file);disk.prepare('INSERT INTO meta VALUES(?,?)').run('conflict','external');disk.close();
  accounts.meta('conflict','memory');
  await assert.rejects(accounts.flush(),/storage unavailable/);
  assert.ok(accounts.persistence.error);await assert.rejects(accounts.flush(),/storage unavailable/);
  await assert.rejects(accounts.close(),/storage unavailable/);
  const read=new DatabaseSync(file);assert.equal(read.prepare('SELECT value FROM meta WHERE key=?').get('conflict').value,'external');read.close();
});

test('worker-backed playback writes keep the local event-loop p95 below the synchronization budget',async t=>{
  const {monitorEventLoopDelay}=require('node:perf_hooks'),{randomUUID}=require('node:crypto');
  const {PlaybackTracking}=require('../server/playback-tracking');
  const {file,vault}=fixture(t),accounts=new Accounts(file,vault),tracking=new PlaybackTracking(accounts);
  const user=accounts.resolve('plex','101','Load fixture');
  const room={s:{roomId:randomUUID()},media:{id:'42',duration:300},mediaVersion:randomUUID()};
  const viewers=Array.from({length:16},()=>({userId:user.id,observationEpoch:randomUUID(),streamVersion:randomUUID(),mediaVersion:room.mediaVersion,media:{kind:'plex',format:'hls'}}));
  await accounts.flush();const delay=monitorEventLoopDelay({resolution:5});delay.enable();
  try {
    for(let sequence=0;sequence<20;sequence++){
      await new Promise(resolve=>setTimeout(resolve,50));
      for(const [i,viewer]of viewers.entries())tracking.observe(room,viewer,String(i),{observationEpoch:viewer.observationEpoch,streamVersion:viewer.streamVersion,mediaVersion:room.mediaVersion,
        sequence,sampleAt:performance.now(),observedAt:Date.now(),position:0,state:'paused',frames:0,rate:1,discontinuity:0});
    }
    await accounts.flush();delay.disable();
    const p95=delay.percentile(95)/1e6,max=delay.max/1e6;
    t.diagnostic(`16 paused viewers, 320 durable observations: event-loop p95 ${p95.toFixed(2)} ms; max ${max.toFixed(2)} ms (isolated local workload)`);
    assert.ok(p95<50,'local synthetic storage load stays inside the 50 ms event-loop budget');
  } finally {delay.disable();for(const viewer of viewers)tracking.end(viewer,'test-end');tracking.close();await accounts.close();}
});

test('unsupported pre-release schema fails startup without leaving a live storage worker',async t=>{
  const {directory}=fixture(t),keyFile=path.join(directory,'key'),deviceFile=path.join(directory,'devices.json');
  fs.writeFileSync(keyFile,Buffer.alloc(32,7));
  const old=new DatabaseSync(path.join(directory,'accounts.sqlite'));old.exec('CREATE TABLE users(id TEXT); PRAGMA user_version=1;');old.close();
  const config={publicUrl:'https://localhost',accountFile:path.join(directory,'accounts.sqlite'),credentialKeyFile:keyFile,deviceFile};
  const source=`try { require(${JSON.stringify(path.join(__dirname,'../server/app'))}).createApp(${JSON.stringify(config)}); process.exitCode=1; } catch(error) { console.log(error.message); }`;
  const output=await new Promise((resolve,reject)=>require('node:child_process').execFile(process.execPath,['-e',source],{windowsHide:true,timeout:5000,maxBuffer:4096},(error,stdout)=>error?reject(error):resolve(stdout)));
  assert.match(output,/Unsupported pre-release database/);
});

test('unsupported schemas fail without changing existing data or installing missing tables', t => {
  const {initializeSchema}=require('../server/storage');
  for (const [version,sql,message] of [[0,'CREATE TABLE old_state(id TEXT);','pre-release'],[1,'CREATE TABLE users(id TEXT);','pre-release'],[2,'CREATE TABLE users(id TEXT);','pre-release'],[3,'CREATE TABLE users(id TEXT);','pre-release'],[4,'CREATE TABLE users(id TEXT);','pre-release'],[5,'CREATE TABLE users(id TEXT);','pre-release'],[7,'CREATE TABLE future_state(id TEXT);','newer']]) {
    const db=new DatabaseSync(':memory:');db.exec(sql+'PRAGMA user_version='+version);
    const before=db.prepare('SELECT name,sql FROM sqlite_master').all();
    assert.throws(()=>initializeSchema(db),new RegExp(message));
    assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master').all(),before);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,version);db.close();
  }
  const previous = new DatabaseSync(':memory:');
  initializeSchema(previous);
  previous.exec('DROP TABLE watch_queue_entries; DROP TABLE watch_room_hosts; DROP TABLE watch_rooms; PRAGMA user_version=1;');
  previous.prepare('INSERT INTO meta VALUES(?,?)').run('retained-private-state', 'original');
  const before = previous.prepare('SELECT name,sql FROM sqlite_master').all();
  assert.throws(() => initializeSchema(previous), /Unsupported pre-release database/);
  assert.deepEqual(previous.prepare('SELECT name,sql FROM sqlite_master').all(), before);
  assert.equal(previous.prepare('SELECT value FROM meta WHERE key=?').get('retained-private-state').value, 'original');
  assert.equal(previous.prepare('PRAGMA user_version').get().user_version, 1);
  previous.close();
});

test('matched offline SQLite and original-key backup restores UUIDs, credentials, logins, devices and playback history',async t=>{
  const {directory,file}=fixture(t),key=path.join(directory,'original.key');
  fs.writeFileSync(key,Buffer.alloc(32,19));const vault=credentialVault(key);
  const accounts=new Accounts(file,vault),user=accounts.resolve('plex','101','Alice');
  accounts.credential('101',{token:'private-restore-fixture'});
  const devices=deviceStore(accounts);devices.devices.push({id:'device',credentialHash:'a'.repeat(64)});await devices.save();
  const logins=loginStore('baseline',vault,accounts);logins.logins.set('b'.repeat(64),{userId:user.id,name:'Alice',csrf:'c'.repeat(64),expires:null,oauth:{refreshToken:'private-login-fixture',expires:9999999999999}});await logins.save();
  accounts.db.prepare('INSERT INTO playback_history VALUES(?,?,?,?)').run('viewing',user.id,1,JSON.stringify({roomId:'room',watchedSeconds:12}));
  await accounts.close();
  const copy=path.join(directory,'restored.sqlite'),copyKey=path.join(directory,'restored.key');
  fs.copyFileSync(file,copy);fs.copyFileSync(key,copyKey);
  const restored=new Accounts(copy,credentialVault(copyKey));
  try {
    assert.equal(restored.identity('plex','101').userId,user.id);
    assert.equal(restored.credential('101').token,'private-restore-fixture');
    assert.deepEqual(deviceStore(restored).devices,devices.devices);
    assert.equal(loginStore('baseline',restored.vault,restored).logins.get('b'.repeat(64)).oauth.refreshToken,'private-login-fixture');
    assert.equal(restored.db.prepare('SELECT userId FROM playback_history').get().userId,user.id);
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(fs.readFileSync(copyKey),fs.readFileSync(key));
  } finally {await restored.close();}
});
