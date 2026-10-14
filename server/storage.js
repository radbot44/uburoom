'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Credentials and account metadata only; active players and consent are never durable.
function write(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function deviceStore(file) {
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
function loginStore(file, context, vault) {
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
module.exports = { deviceStore, loginStore };
