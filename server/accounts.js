'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('./database');
const { migrate } = require('./storage');

function privateFile(file) {
  if (process.platform !== 'win32') { fs.chmodSync(file,0o600); return; }
  const script=`$ErrorActionPreference='Stop'; $taskAcl=[System.Security.AccessControl.FileSecurity]::new(); $taskOwner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $taskAcl.SetOwner($taskOwner); $taskAcl.SetAccessRuleProtection($true,$false); foreach($taskSid in @($taskOwner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$taskRule=[System.Security.AccessControl.FileSystemAccessRule]::new($taskSid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow); [void]$taskAcl.AddAccessRule($taskRule)}; [System.IO.File]::SetAccessControl($env:UBUROOM_PRIVATE_FILE,$taskAcl)`;
  if(spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,UBUROOM_PRIVATE_FILE:file},windowsHide:true}).status!==0)throw new Error('Cannot protect uburoom private files');
}
function credentialVault(file) {
  let key;
  if (file) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if (!fs.existsSync(file)) fs.writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});
    privateFile(file); key=fs.readFileSync(file);
  } else key=randomBytes(32);
  if (key.length!==32) throw new Error('Invalid uburoom credential encryption key');
  return {
    seal(value) { const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return {encrypted:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:bytes.toString('base64')}; },
    open(value) { if (!value?.encrypted) return value;const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString()); }
  };
}

class Accounts {
  constructor(file,vault) {
    if (file) fs.mkdirSync(path.dirname(file),{recursive:true});
    this.persistence=openDatabase(file,migrate);this.db=this.persistence.db;this.vault=vault;
    this.credentialCache=new Map();
    if(file)try{privateFile(file);}catch(error){Promise.resolve(this.persistence.abort()).catch(()=>{});throw error;}
  }
  transaction(action) {this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  canonical(id) {let row=this.db.prepare('SELECT * FROM users WHERE id=?').get(id);for(let n=0;row?.retiredInto && n<20;n++)row=this.db.prepare('SELECT * FROM users WHERE id=?').get(row.retiredInto);return row&&!row.retiredInto?row:undefined;}
  identity(provider,subject) {return this.db.prepare('SELECT * FROM identities WHERE provider=? AND subject=?').get(provider,String(subject));}
  identities(userId) {return this.db.prepare('SELECT provider,subject,name,verified,assigned FROM identities WHERE userId=? ORDER BY provider').all(userId);}
  create(name) {const id=randomUUID();this.db.prepare('INSERT INTO users(id,name) VALUES(?,?)').run(id,name);return id;}
  resolve(provider,subject,name,verified=true) {
    subject=String(subject);const old=this.identity(provider,subject);
    if(old){if(verified){this.db.prepare('UPDATE identities SET verified=1,name=? WHERE provider=? AND subject=?').run(name,provider,subject);this.db.prepare("UPDATE users SET name=? WHERE id=? AND name='Assigned account'").run(name,old.userId);}return this.canonical(old.userId);}
    return this.transaction(()=>{const id=this.create(name);this.db.prepare('INSERT INTO identities(provider,subject,userId,name,verified) VALUES(?,?,?,?,?)').run(provider,subject,id,name,Number(verified));return this.canonical(id);});
  }
  link(userId,provider,subject,name) {
    const user=this.canonical(userId),old=this.identity(provider,subject),current=this.identities(user.id).find(i=>i.provider===provider);
    if(current && current.subject!==String(subject))throw new Error('This account already has a different '+provider+' identity');
    if(old && old.userId!==user.id)return {conflict:this.canonical(old.userId)};
    if(old)this.db.prepare('UPDATE identities SET verified=1,name=? WHERE provider=? AND subject=?').run(name,provider,String(subject));
    else this.db.prepare('INSERT INTO identities(provider,subject,userId,name,verified) VALUES(?,?,?,?,1)').run(provider,String(subject),user.id,name);
    return {user};
  }
  merge(survivor,retired,actor,action='self-merge') {
    survivor=this.canonical(survivor).id;retired=this.canonical(retired).id;if(survivor===retired)return survivor;
    const all=[...this.identities(survivor),...this.identities(retired)];if(new Set(all.map(i=>i.provider)).size!==all.length)throw new Error('Accounts have conflicting login identities');
    return this.transaction(()=>{
      this.db.prepare('UPDATE identities SET userId=? WHERE userId=?').run(survivor,retired);
      this.db.prepare('UPDATE users SET retiredInto=?,revision=revision+1 WHERE id=?').run(survivor,retired);
      this.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(survivor);
      this.audit(actor,action,{survivor,retired,identities:all});return survivor;
    });
  }
  preview(discordId,plexId) {
    const a=this.identity('discord',discordId),b=this.identity('plex',plexId),ids=[...new Set([a?.userId,b?.userId].filter(Boolean))];
    const users=ids.map(id=>this.summary(id));const identities=users.flatMap(u=>u.identities);
    if(identities.some(i=>i.provider==='discord'&&i.subject!==discordId||i.provider==='plex'&&i.subject!==plexId))throw new Error('One account already has a different linked identity');
    return {discordId,plexId,users,version:JSON.stringify(users.map(u=>[u.id,u.revision,u.identities]))};
  }
  assign(preview,actor) {
    const current=this.preview(preview.discordId,preview.plexId);if(current.version!==preview.version)throw new Error('Accounts changed; preview again');
    let id=current.users[0]?.id;
    if(current.users.length===2)id=this.merge(id,current.users[1].id,actor,'owner-merge');
    this.transaction(()=>{
      id ||= this.create('Assigned account');
      let changed=false;
      for(const [provider,subject] of [['discord',preview.discordId],['plex',preview.plexId]]) if(!this.identity(provider,subject)){this.db.prepare('INSERT INTO identities(provider,subject,userId,name,assigned) VALUES(?,?,?,?,1)').run(provider,subject,id,provider==='discord'?preview.discordName||subject:subject);changed=true;}
      if(changed)this.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(id);
      this.audit(actor,'owner-match',{userId:id,discordId:preview.discordId,plexId:preview.plexId});
    });return id;
  }
  summary(id) {const user=this.canonical(id);return user&&{...user,identities:this.identities(user.id).map(i=>({...i,authenticated:!!i.verified,credentialStored:i.provider==='plex'&&!!this.credential(i.subject)}))};}
  list(){return this.db.prepare('SELECT id FROM users WHERE retiredInto IS NULL ORDER BY name LIMIT 200').all().map(u=>this.summary(u.id));}
  hasCredential(subject) {return !!this.db.prepare('SELECT 1 FROM credentials WHERE subject=?').get(subject);}
  credential(subject,value) {
    if(value!==undefined&&JSON.stringify(this.credentialCache.get(subject))!==JSON.stringify(value)){
      this.db.prepare('INSERT INTO credentials(subject,value) VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET value=excluded.value').run(subject,JSON.stringify(this.vault.seal(value)));
      this.credentialCache.set(subject,structuredClone(value));
    }
    if(this.credentialCache.has(subject))return structuredClone(this.credentialCache.get(subject));
    const row=this.db.prepare('SELECT value FROM credentials WHERE subject=?').get(subject);if(!row)return;
    const envelope=JSON.parse(row.value);if(envelope.encrypted!==1)throw new Error('Invalid encrypted credential record');
    const decoded=this.vault.open(envelope);this.credentialCache.set(subject,decoded);return structuredClone(decoded);
  }
  meta(key,value) {if(value!==undefined)this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;}
  audit(actor,action,detail){this.db.prepare('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)').run(Date.now(),actor,action,JSON.stringify(detail));}
  flush(){return this.persistence.flush();}
  close(){this.credentialCache.clear();return this.persistence.close();}
}
module.exports={Accounts,credentialVault};
