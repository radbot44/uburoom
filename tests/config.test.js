'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const { ROOT, configPath, parseConfig, normalizeConfig, loadConfig } = require('../server/config');
const Policy = require('../server/room-policy');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('example YAML is usable, private inputs are absent and defaults preserve existing paths/policy', () => {
  const config = normalizeConfig(parseConfig(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8')));
  assert.equal(config.port, 5756);
  assert.equal(config.transcoding.maxJobs, 5);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.plexToken, '');
  assert.deepEqual(config.plexDelivery, {mode:'proxy',clientUrl:'',lanClientUrl:'',fallback:false});
  assert.equal(config.botToken, '');
  assert.deepEqual(config.channels, []);
  assert.deepEqual(config.roomPermissions, Policy.policy());
  assert.deepEqual(config.roomAdministrators, { discord: [], plex: [], discordRoles: [] });
  assert.equal(config.accountFile, path.join(ROOT, 'data/accounts.sqlite'));
  const environment = { HOME: path.join(os.tmpdir(), 'old-home') };
  assert.equal(normalizeConfig({}, { environment, platform:'linux' }).credentialKeyFile, path.join(environment.HOME, '.local/share/uburoom/credentials.key'));
});

test('custom file, mount paths, native lists and quoted snowflakes survive from a different cwd', t => {
  const dir = temporary(t), file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, `
plex:
  token: 'token:#with punctuation'
discord:
  client_id: '123456789012345678'
  command_channel_ids: ['234567890123456789']
server:
  host: '0.0.0.0'
  port: 7654
  public_url: 'https://watch.example'
  tls_cert: 'tls/cert.pem'
storage:
  data_directory: './persist'
  credential_key_file: './private/original.key'
rooms:
  viewer_permissions: [playPause, seek]
  admin_plex_ids: ['101']
  admin_discord_ids: ['345678901234567890']
`);
  const config = loadConfig(file);
  assert.equal(config.tlsCert, path.join(dir, 'tls/cert.pem'));
  assert.equal(config.accountFile, path.join(dir, 'persist/accounts.sqlite'));
  assert.equal(config.credentialKeyFile, path.join(dir, 'private/original.key'));
  assert.equal(config.plexToken, 'token:#with punctuation');
  assert.deepEqual(config.channels, ['234567890123456789']);
  assert.deepEqual(config.roomAdministrators.plex, ['101']);
  assert.equal(config.roomPermissions.viewer.seek, true);
  assert.equal(config.roomPermissions.viewer.chooseMedia, false);
  assert.equal(configPath(['--config', file]), file);
  assert.equal(configPath(['--config=' + file]), file);
  assert.equal(configPath([]), path.join(ROOT, 'config.yaml'));
  assert.throws(() => configPath(['--config']), /requires/);
  assert.throws(() => configPath(['--config=a', '--config=b']), /once/);
});

test('empty permission lists grant none, while omission preserves defaults', () => {
  const config = normalizeConfig({ rooms: { host_permissions: [], viewer_permissions: [] } });
  assert.ok(Object.values(config.roomPermissions.host).every(value => !value));
  assert.ok(Object.values(config.roomPermissions.viewer).every(value => !value));
  const all = normalizeConfig({ rooms: { viewer_permissions: 'all' } });
  assert.ok(Policy.VIEWER_BLOCKED.every(key => !all.roomPermissions.viewer[key]));
});

test('direct Plex delivery requires an explicit secure origin and cannot inherit owner fallback credentials', () => {
  assert.deepEqual(normalizeConfig({plex:{delivery:'auto',client_url:'https://plex.example:32400/'}}).plexDelivery,
    {mode:'auto',clientUrl:'https://plex.example:32400',lanClientUrl:'',fallback:false});
  assert.deepEqual(normalizeConfig({plex:{delivery:'auto',client_url:'https://plex.example:32400',lan_client_url:'https://plex-lan.example:32400/'}}).plexDelivery,
    {mode:'auto',clientUrl:'https://plex.example:32400',lanClientUrl:'https://plex-lan.example:32400',fallback:false});
  for (const plex of [{delivery:'direct'},{delivery:'auto'}, {client_url:'http://plex.example'},
    {client_url:'https://user:secret@plex.example'},{client_url:'https://plex.example/path'},
    {delivery:'auto',client_url:'https://plex.example:32400',lan_client_url:'http://plex-lan.example'},
    {delivery:'auto',client_url:'https://plex.example:32400',lan_client_url:'https://plex-lan.example/path'},
    {direct_fallback_enabled:true},{token:'owner',fallback_token:'owner',direct_fallback_enabled:true},
    {fallback_token:'dedicated',fallback_enabled:false,direct_fallback_enabled:true}]) assert.throws(()=>normalizeConfig({plex}));
  assert.equal(normalizeConfig({plex:{url:'http://plex.example',fallback_token:'dedicated',direct_fallback_enabled:true}}).plexDelivery.fallback,true);
});

test('malformed YAML and unsupported structures never echo secret source text', () => {
  const secret = 'super-private-token';
  for (const source of [
    `plex: {token: '${secret}'\n`, `plex:\n  token: '${secret}'\n  token: other`,
    `plex: !unknown '${secret}'`, `plex: &anchor {token: '${secret}'}\ndiscord: *anchor`,
    `plex: {}\n---\nplex: {token: '${secret}'}`
  ]) {
    assert.throws(() => parseConfig(source), error => !error.message.includes(secret));
  }
  for (const value of [null, [], {server:null}, {server:[]}, {server:{prot:42}}, {typo:{}},
    {server:{port:'5756'}}, {server:{port:0}}, {server:{port:65536}}, {server:{host:''}},
    {discord:{client_id:123456789012345678}}, {discord:{command_channel_ids:[123456789012345678]}},
    {rooms:{viewer_permissions:['manageHosts']}}, {rooms:{admin_plex_ids:['name']}},
    {server:{public_url:'http://localhost'}}, {server:{public_url:'https://private:token@example.com'}},
    {server:{public_url:'https://example.com/path'}}, {plex:{url:'file:///secret'}},
    {storage:{credential_key_file:path.join(ROOT,'key')}}]) {
    assert.throws(() => normalizeConfig(value));
  }
});

test('missing YAML fails before TLS or providers and never falls back to .env/environment', t => {
  const dir = temporary(t), file = path.join(dir,'config.yaml');
  fs.writeFileSync(path.join(dir,'.env'),'PORT=9999');
  const child = spawnSync(process.execPath,[path.join(ROOT,'server/index.js'),'--config',file],{
    cwd:dir,encoding:'utf8',env:{...process.env,PORT:'9999',PLEX_TOKEN:'inherited-secret'}
  });
  assert.equal(child.status,1);
  assert.match(child.stderr,/Missing config.yaml/);
  assert.doesNotMatch(child.stderr,/inherited-secret|Missing TLS/);
});

test('git ignores private YAML and packaging admits only the blank YAML example', () => {
  const result = spawnSync('git',['check-ignore','--no-index','config.yaml','config.local.yaml','config.yml'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0);
  assert.equal(result.stdout.trim().split(/\r?\n/).length,3);
  const script = fs.readFileSync(path.join(ROOT,'scripts/package.ps1'),'utf8');
  assert.match(script,/config\.example\.yaml/);
  assert.match(script,/yaml\|yml/);
});

test('real entry point serves health from external YAML with isolated persistent state', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-config-start-')), file = path.join(dir, 'config.yaml');
  const net = require('node:net'), https = require('node:https');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const YAML = require('yaml');
  fs.writeFileSync(file, YAML.stringify({
    server: { port, public_url: `https://localhost:${port}`,
      tls_cert: path.join(ROOT,'certs/server-cert.pem'), tls_key: path.join(ROOT,'certs/server-key.pem') },
    storage: { data_directory: './state', credential_key_file: './original.key' }
  }));
  const child = spawn(process.execPath, [path.join(ROOT,'server/index.js'),'--config',file], {
    cwd:dir, windowsHide:true, env:{...process.env,PORT:'1',PLEX_TOKEN:'ignored-inherited-token',DISCORD_BOT_TOKEN:'ignored-inherited-token'},
    stdio:['ignore','pipe','pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if(child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(dir, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  let status;
  const deadline = Date.now() + 12000;
  while(Date.now() < deadline && child.exitCode === null) {
    status = await new Promise(resolve => {
      const request = https.get({hostname:'127.0.0.1',port,path:'/health',rejectUnauthorized:false}, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', () => resolve(undefined));
      request.setTimeout(500, () => request.destroy());
    });
    if(status === 200)break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status,200,output);
  assert.match(output,/Remote off by default/,'startup finishes logging and reaches normal initialization');
  assert.ok(fs.existsSync(path.join(dir,'state/accounts.sqlite')));
  assert.equal(fs.readFileSync(path.join(dir,'original.key')).length,32);
  assert.doesNotMatch(output,/ignored-inherited-token/);
});


test('Activity Plex requirement defaults on and accepts only YAML booleans',()=>{
  assert.equal(normalizeConfig({}).accessPolicy.requirePlexInActivity,true);
  assert.equal(normalizeConfig({access:{require_plex_in_activity:false}}).accessPolicy.requirePlexInActivity,false);
  assert.throws(()=>normalizeConfig({access:{require_plex_in_activity:'false'}}),/true or false/);
});


test('credential key defaults follow each OS and honor explicit paths without migration',t=>{
  const home=temporary(t),local=path.join(home,'local'),xdg=path.join(home,'xdg');
  const key=(platform,environment)=>normalizeConfig({}, {platform,environment}).credentialKeyFile;
  assert.equal(key('win32',{HOME:home,LOCALAPPDATA:local}),path.join(local,'uburoom/credentials.key'));
  assert.equal(key('win32',{USERPROFILE:home}),path.join(home,'AppData/Local/uburoom/credentials.key'));
  assert.equal(key('linux',{HOME:home}),path.join(home,'.local/share/uburoom/credentials.key'));
  assert.equal(key('linux',{HOME:home,XDG_DATA_HOME:xdg,LOCALAPPDATA:local}),path.join(xdg,'uburoom/credentials.key'));
  assert.equal(key('linux',{HOME:home,XDG_DATA_HOME:'relative'}),path.join(home,'.local/share/uburoom/credentials.key'));
  assert.equal(key('darwin',{HOME:home,XDG_DATA_HOME:xdg,LOCALAPPDATA:local}),path.join(home,'Library/Application Support/uburoom/credentials.key'));
  const original=path.join(home,'original.key');fs.writeFileSync(original,'unchanged');
  assert.equal(normalizeConfig({storage:{credential_key_file:original}},{platform:'linux'}).credentialKeyFile,original);
  assert.equal(fs.readFileSync(original,'utf8'),'unchanged');
});

test('single-room Plex leader accepts an explicit ID or token default without Discord ownership',()=>{
  assert.equal(normalizeConfig({rooms:{single_room:true,single_room_leader_plex_id:'101'}}).singleRoomLeaderPlexId,'101');
  assert.equal(normalizeConfig({access:{discord:false},plex:{token:'fixture-token'},rooms:{single_room:true}}).singleRoom,true);
  assert.throws(()=>normalizeConfig({access:{discord:false},rooms:{single_room:true}}),/plex.token/);
  assert.throws(()=>normalizeConfig({rooms:{single_room_leader_plex_id:'alice'}}),/Plex account ID/);
});
