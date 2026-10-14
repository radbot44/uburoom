/* Test a copied Discord Electron runtime, without opening Discord or its account profile.
   node --env-file=.env scripts/discord-decoder-smoke.js --discord-dir=C:/.../app-... --plex-url=http://host:32400 --media-id=123 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const directory = process.argv.find(x => x.startsWith('--discord-dir='))?.slice(14);
if (!directory || !fs.existsSync(path.join(directory, 'Discord.exe'))) throw new Error('Pass the installed Discord app directory');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'radtv-discord-runtime-'));
for (const entry of fs.readdirSync(directory, { withFileTypes:true })) if (entry.isFile()) fs.copyFileSync(path.join(directory, entry.name), path.join(runtime, entry.name));
fs.cpSync(path.join(directory, 'locales'), path.join(runtime, 'locales'), { recursive:true });
const app = path.join(runtime, 'resources/app'); fs.mkdirSync(app, { recursive:true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name:'radtv-decoder-test', version:'1.0.0', main:'main.js' }));
fs.writeFileSync(path.join(app, 'main.js'), `
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.whenReady().then(()=>{
  global.windows=Array.from({length:2},()=>{
    const window=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
    window.loadURL('about:blank');return window;
  });
});`);
const args = process.argv.slice(2).filter(x => !x.startsWith('--discord-dir='));
const child = spawn(process.execPath, [path.join(__dirname, 'watch-codec-smoke.js'), ...args, '--expect-unsupported', '--runtime='+path.join(runtime,'Discord.exe')],
  { env:process.env, windowsHide:true, stdio:'inherit' });
child.on('exit', code => { process.exitCode = code; console.log('Disposable decoder runtime:', runtime); });
