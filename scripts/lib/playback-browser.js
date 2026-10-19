/* Disposable headless browsers for the isolated playback baseline; no personal profiles. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

async function playbackBrowser(name, { binary, acceleration = 'software' } = {}) {
  if (!['firefox','chrome','edge'].includes(name) || !['software','default'].includes(acceleration)) throw new Error('Invalid browser or acceleration mode');
  const firefox = name === 'firefox', prefix = 'uburoom-playback-' + name + '-';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  let child, socket, sequence = 0;
  const pending = new Map();
  const failPending = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const command = (method,params = {},sessionId) => new Promise((resolve,reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); },20000);
    pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}));
  });
  const close = async () => {
    // BiDi browser.close shuts down the browser; session.end only ends control.
    // https://www.w3.org/TR/webdriver-bidi/#command-browser-close
    if (socket?.readyState === WebSocket.OPEN) await command(firefox ? 'browser.close' : 'Browser.close').catch(() => {});
    socket?.close(); failPending(new Error('Playback browser closed'));
    if (child && child.exitCode === null) {
      const waitExit = ms => new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        const finished = () => { clearTimeout(timer); child.off('exit',finished); resolve(); };
        const timer = setTimeout(finished,ms); child.once('exit',finished);
      });
      await waitExit(3000);
      if (child.exitCode === null) { child.kill(); await waitExit(2000); }
    }
    // A Windows browser helper may inherit these pipes beyond the main child.
    // Release only this fixture's pipe ends after its browser has shut down.
    child?.stdout?.destroy(); child?.stderr?.destroy();
    // Only remove the temporary profile this invocation created.
    if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith(prefix)) {
      await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(() => {});
    }
  };
  try {
    const defaults = process.platform === 'win32' ? {
      firefox:'C:/Program Files/Mozilla Firefox/firefox.exe',chrome:'C:/Program Files/Google/Chrome/Application/chrome.exe',edge:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    } : {firefox:'firefox',chrome:'google-chrome',edge:'microsoft-edge'};
    const environmentBinary = name === 'firefox' ? process.env.FIREFOX_BINARY : name === 'edge' ? process.env.EDGE_BINARY : process.env.CHROMIUM_BINARY;
    if (firefox) fs.writeFileSync(path.join(profile,'user.js'),[
      'user_pref("media.autoplay.default",0);','user_pref("media.autoplay.block-webaudio",false);','user_pref("browser.shell.checkDefaultBrowser",false);',
      ...(acceleration === 'software' ? ['user_pref("media.hardware-video-decoding.enabled",false);'] : [])
    ].join('\n'));
    const args = firefox ? ['--headless','--no-remote','--profile',profile,'--remote-debugging-port','0'] :
      ['--headless=new','--no-first-run','--no-default-browser-check','--ignore-certificate-errors','--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-port=0','--user-data-dir=' + profile,...(acceleration === 'software' ? ['--disable-accelerated-video-decode'] : []),'about:blank'];
    child = spawn(binary || environmentBinary || defaults[name],args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const address = await new Promise((resolve,reject) => {
      let output = '';
      const finish = (error,address) => { clearTimeout(timer); child.stdout.off('data',inspect); child.stderr.off('data',inspect); child.off('error',bad); child.off('exit',exit); error ? reject(error) : resolve(address); };
      const inspect = chunk => {
        output = (output + chunk.toString()).slice(-12000);
        const match = (firefox ? /WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/ : /DevTools listening on (ws:\/\/[^\s]+)/).exec(output);
        if (match) finish(null,match[1] + (firefox ? '/session' : ''));
      };
      const bad = error => finish(error), exit = () => finish(new Error(name + ' exited during startup'));
      const timer = setTimeout(() => finish(new Error(name + ' startup timed out')),25000);
      child.stdout.on('data',inspect); child.stderr.on('data',inspect); child.once('error',bad); child.once('exit',exit);
    });
    socket = new WebSocket(address); await once(socket,'open');
    socket.on('message',raw => {
      const message = JSON.parse(raw), item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.type === 'error' || message.error ? item.reject(new Error(message.message || message.error.message)) : item.resolve(message.result);
    });
    socket.on('close',() => failPending(new Error(name + ' debugging connection closed')));
    socket.on('error',error => failPending(error));
    const version = firefox ? (await command('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:true}}})).capabilities.browserVersion : (await command('Browser.getVersion')).product;
    function unpack(remote) {
      if (!remote || typeof remote !== 'object') return remote;
      if (remote.type === 'null') return null;
      if (remote.type === 'undefined') return undefined;
      if (remote.type === 'array' && Array.isArray(remote.value)) return remote.value.map(unpack);
      if (remote.type === 'object' && Array.isArray(remote.value)) return Object.fromEntries(remote.value.map(([k, v]) => [k, unpack(v)]));
      return remote.value !== undefined ? remote.value : remote;
    }
    const evaluate = async (page,expression) => {
      const result = firefox ? await command('script.evaluate',{expression,target:{context:page},awaitPromise:true}) :
        await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},page);
      if (result.type === 'exception' || result.exceptionDetails) throw new Error(result.exceptionDetails?.text || 'Browser expression failed');
      return firefox ? unpack(result.result) : result.result?.value;
    };
    const until = async (page,expression,label,timeout = 20000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(page,expression)) return; await pause(100); }
      throw new Error(label + ' timed out');
    };
    const page = async url => {
      if (firefox) {
        const {context} = await command('browsingContext.create',{type:'tab'});
        await command('browsingContext.navigate',{context,url,wait:'complete'}); return context;
      }
      const {targetId} = await command('Target.createTarget',{url:'about:blank'});
      const {sessionId} = await command('Target.attachToTarget',{targetId,flatten:true});
      await command('Page.enable',{},sessionId); await command('Page.navigate',{url},sessionId);
      await until(sessionId,'location.href === ' + JSON.stringify(url) + ' && document.readyState === "complete"','Page navigation'); return sessionId;
    };
    const viewport = (page,width,height) => firefox ? command('browsingContext.setViewport',{context:page,viewport:{width,height}}) :
      command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},page);
    const activate = page => firefox ? command('browsingContext.activate',{context:page}) : command('Page.bringToFront',{},page);
    const move = (page,x,y) => firefox ? command('input.performActions',{context:page,actions:[{type:'pointer',id:'playback-pointer',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',x,y,origin:'viewport'}]}]}) : command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y},page);
    const tap = async (page,x,y) => {
      await activate(page);
      if(firefox)await command('input.performActions',{context:page,actions:[{type:'pointer',id:'playback-touch',parameters:{pointerType:'touch'},actions:[{type:'pointerMove',x,y,origin:'viewport'},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]});
      else {await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]},page);await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},page);}
    };
    const click = async (page,id) => {
      await activate(page);
      const {x,y} = JSON.parse(await evaluate(page,'JSON.stringify((()=>{const r=document.getElementById('+JSON.stringify(id)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})())'));
      await move(page,x,y);
      await evaluate(page,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      if (firefox) await command('input.performActions',{context:page,actions:[{type:'pointer',id:'playback-pointer',parameters:{pointerType:'mouse'},actions:[
        {type:'pointerMove',x,y,origin:'viewport'},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]});
      else {
        await command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1},page);
        await command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1},page);
      }
    };
    const screenshot = async (page,file) => {
      const result = firefox ? await command('browsingContext.captureScreenshot',{context:page,origin:'viewport'}) : await command('Page.captureScreenshot',{format:'png'},page);
      fs.writeFileSync(file,Buffer.from(result.data,'base64'));
    };
    return {name,version,pid:child.pid,headless:true,acceleration,evaluate,until,page,viewport,activate,move,tap,click,screenshot,close};
  } catch (error) { await close(); throw error; }
}
module.exports = { playbackBrowser, pause };
