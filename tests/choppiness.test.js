'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../web/playback-policy');
const toastsApi = require('../web/watch-toasts');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../web/watch.js'),'utf8');

test('choppiness detector detects 10% dropped frames over 10 seconds of active playback', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  // At t=0: 0 frames, 0 dropped
  let res = detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // At t=5000: 150 frames, 15 dropped (10%), but only 5s elapsed
  for (let t=500;t<=5000;t+=500) res = detector.update(t, {totalVideoFrames:t*.03,droppedVideoFrames:Math.floor(t*.003)},cond);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // At t=10000: 300 frames, 33 dropped (11%)
  for (let t=5500;t<=10000;t+=500) res = detector.update(t, {totalVideoFrames:t*.03,droppedVideoFrames:15+Math.floor((t-5000)*.0036)},cond);
  assert.equal(res.choppy, true);
  assert.equal(res.deltaTotal, 300);
  assert.equal(res.deltaDropped, 33);
  assert.ok(res.ratio >= 0.10);
  assert.equal(res.dropChoppy,true,'the existing long-window path remains active');
});

test('choppiness detector stays quiet when dropped frames are under threshold', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  for (let t=500;t<10000;t+=500) detector.update(t, {totalVideoFrames:t*.03,droppedVideoFrames:Math.floor(t*.001)},cond);
  const res = detector.update(10000, { totalVideoFrames: 300, droppedVideoFrames: 10 }, cond);
  assert.equal(res.choppy, false);
  assert.ok(res.ratio < 0.10);
});

test('pauses, seeking, and hidden visibility reset the 10-second window', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const healthy = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, healthy);
  detector.update(8000, { totalVideoFrames: 240, droppedVideoFrames: 50 }, healthy);

  // Paused at t=9000
  let res = detector.update(9000, { totalVideoFrames: 270, droppedVideoFrames: 50 }, { ...healthy, paused: true });
  assert.equal(res.choppy, false);
  assert.equal(res.interrupted, true);

  // Resume playback at t=9500
  res = detector.update(9500, { totalVideoFrames: 270, droppedVideoFrames: 50 }, healthy);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // At t=12000 (only 2.5s since resume), even with high dropped frames, it does not falsely trigger
  res = detector.update(12000, { totalVideoFrames: 350, droppedVideoFrames: 90 }, healthy);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // Seeking interrupt
  detector.update(15000, { totalVideoFrames: 450, droppedVideoFrames: 100 }, healthy);
  res = detector.update(16000, { totalVideoFrames: 480, droppedVideoFrames: 100 }, { ...healthy, seeking: true });
  assert.equal(res.interrupted, true);

  // Waiting/buffering before 2.5s records stall without interrupt
  detector.update(17000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, healthy);
  res = detector.update(18000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, { ...healthy, waiting: true });
  assert.equal(res.isSettled, false);
  assert.equal(res.choppy, false);

  // Tab hidden interrupt
  detector.update(19000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, healthy);
  res = detector.update(20000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, { ...healthy, visible: false });
  assert.equal(res.interrupted, true);
});

test('insufficient frames (<50) over 10s does not trigger false positive', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  // Only 10 frames total, 5 dropped (50%), but total frames < 50
  let res;
  for (let t=500;t<=10000;t+=500) res = detector.update(t, {totalVideoFrames:Math.floor(t*.001),droppedVideoFrames:Math.floor(t*.0005)},cond);
  assert.equal(res.choppy, false);
  assert.equal(res.minFramesRequired, 50);
});

test('cooldown suppresses detection for 10 seconds after quality change', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.triggerCooldown(10000, 1000);
  assert.equal(detector.inCooldown(5000), true);

  let res = detector.update(5000, { totalVideoFrames: 300, droppedVideoFrames: 100 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.inCooldown, true);

  assert.equal(detector.inCooldown(11001), false);
  // Fresh window starts after cooldown
  res = detector.update(11001, { totalVideoFrames: 300, droppedVideoFrames: 100 }, cond);
  assert.equal(res.warming, true);
});

test('deliberate dismissal permanently suppresses detection until session reset', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.dismiss(true);
  assert.equal(detector.isDismissed, true);

  let res = detector.update(10000, { totalVideoFrames: 500, droppedVideoFrames: 200 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.dismissed, true);

  detector.reset();
  assert.equal(detector.isDismissed, false);
  res = detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  assert.equal(res.warming, true);
});

function toastFixture() {
  const mockDoc = {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        dataset: {},
        style: {},
        children: [],
        listeners: {},
        textContent: '',
        hidden: false,
        type: '',
        title: '',
        attributes: {},
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = [...nodes]; },
        setAttribute(k, v) { this.attributes[k] = v; },
        removeAttribute(k) { delete this.attributes[k]; },
        addEventListener(event, fn) { this.listeners[event] = fn; },
        remove() { el.removed = true; },
        animate() { return { cancel() {}, onfinish: null }; },
        classList: {
          toggle(cls, val) {
            const set = new Set((el.className || '').split(' ').filter(Boolean));
            if (val) set.add(cls); else set.delete(cls);
            el.className = [...set].join(' ');
          }
        }
      };
      el.ownerDocument = mockDoc;
      return el;
    },
    defaultView: {
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ opacity: '1', transform: 'none', getPropertyValue: () => '16px' })
    }
  };
  mockDoc.ownerDocument = mockDoc;
  const host = mockDoc.createElement('div');

  const timers = new Map(); let sequence = 0;
  const toasts = toastsApi.create(host, { icons: { icon: () => mockDoc.createElement('svg') },
    schedule:fn=>{const id=++sequence;timers.set(id,fn);return id;},cancel:id=>timers.delete(id) });
  return {host,toasts,expire:()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}

test('toast with action renders container div and supports action and deliberate dismissal', () => {
  const {host,toasts} = toastFixture();

  let actionRan = false;
  let dismissedDeliberately = false;

  toasts.show('choppy', {
    title: 'Playback seems choppy',
    action: { label: 'Lower quality', run: () => { actionRan = true; } },
    onDismiss: (deliberate) => { dismissedDeliberately = deliberate; }
  });

  const toastRoot = host.children[0];
  assert.equal(toastRoot.tagName, 'DIV');
  assert.ok(toastRoot.className.includes('watch-toast'));
  assert.ok(toastRoot.className.includes('with-action'));
  assert.equal(toastRoot.attributes.role, 'status');

  const message = toastRoot.children[1];
  const heading = message.children[0];
  assert.equal(heading.textContent, 'Playback seems choppy');

  const actions = message.children[2];
  const actionBtn = actions.children[0];
  assert.equal(actionBtn.textContent, 'Lower quality');
  const dismissBtn = actions.children[1];
  assert.equal(dismissBtn.textContent, 'Dismiss');

  // Trigger action
  actionBtn.listeners.click({ stopPropagation() {} });
  assert.equal(actionRan, true);
  assert.equal(toastRoot.removed, true);
});

test('mid-stream buffering stalls trigger choppiness while initial load and seek buffers are ignored', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50, maxStallMs: 1500, maxStallCount: 2, minMultiStallMs: 1000, settleMs: 2500 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  // 1. Initial load buffering (4 seconds of waiting before playback starts)
  for (let t = 0; t <= 4000; t += 1000) {
    const res = detector.update(t, { totalVideoFrames: 0, droppedVideoFrames: 0 }, { ...cond, waiting: true });
    assert.equal(res.choppy, false);
    assert.equal(res.isSettled, false);
  }

  // 2. Playback starts and warms up for 3 seconds (settles at 2.5s)
  detector.update(5000, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  detector.update(6000, { totalVideoFrames: 30, droppedVideoFrames: 0 }, cond);
  detector.update(7000, { totalVideoFrames: 60, droppedVideoFrames: 0 }, cond);
  let res = detector.update(8000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, cond);
  assert.equal(res.isSettled, true);
  assert.equal(res.choppy, false);

  // 3. Mid-stream stall: buffer runs empty at t=9000
  detector.update(9000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  // At t=10000: 1000ms of stall (<1500ms), not yet choppy
  res = detector.update(10000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, false);
  assert.equal(res.totalStallMs, 1000);

  // At t=11000: 2000ms of stall (>=1500ms maxStallMs) -> triggers choppiness!
  res = detector.update(11000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, true);
  assert.equal(res.stallChoppy, true);
  assert.equal(res.totalStallMs, 2000);

  // 4. User seeks to new position at t=12000: seek buffer resets detector and is not choppy
  res = detector.update(12000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, seeking: true });
  assert.equal(res.choppy, false);
  assert.equal(res.interrupted, true);

  // Seek load buffering for 2 seconds
  detector.update(13000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  res = detector.update(14000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, false);

  // Resumes playing and settles
  detector.update(15000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, cond);
  detector.update(18000, { totalVideoFrames: 180, droppedVideoFrames: 0 }, cond); // settled

  // 5. Two distinct shorter stalls (700ms each = 1400ms >= minMultiStallMs 1000ms and count >= 2)
  detector.update(19000, { totalVideoFrames: 180, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  detector.update(19700, { totalVideoFrames: 180, droppedVideoFrames: 0 }, cond); // stall 1 ends (700ms)

  detector.update(21000, { totalVideoFrames: 220, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  res = detector.update(21700, { totalVideoFrames: 220, droppedVideoFrames: 0 }, { ...cond, waiting: true }); // stall 2 in progress (700ms)
  assert.equal(res.stallCount, 2);
  assert.equal(res.choppy, true);
  assert.equal(res.stallChoppy, true);
});

test('sub-2.5s stalls do not reset playingStartedAt in a loop and record into stallHistory', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50, maxStallMs: 1500, maxStallCount: 2, minMultiStallMs: 1000, settleMs: 2500 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  // Waiting before any playback has started returns warming
  const preplay = detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(preplay.choppy, false);
  assert.equal(preplay.warming, true);
  assert.equal(preplay.isSettled, false);

  // Playback starts at t=1000
  detector.update(1000, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);

  // Stall occurs at t=2000 (1000ms in, before settleMs 2500ms)
  let res = detector.update(2000, { totalVideoFrames: 30, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, false);
  assert.equal(res.isSettled, false);

  // Stall ends at t=2600 (600ms stall)
  res = detector.update(2600, { totalVideoFrames: 30, droppedVideoFrames: 0 }, cond);
  // playingStartedAt was preserved at 1000, so now-playingStartedAt = 1600 < 2500 -> isSettled false
  assert.equal(res.isSettled, false);

  // Second stall occurs at t=3200 (2200ms since t=1000, still before 2500ms)
  detector.update(3200, { totalVideoFrames: 50, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  // Stall ends at t=3800 (600ms stall, totalStallMs = 1200ms >= 1000ms, stallCount = 2)
  res = detector.update(3800, { totalVideoFrames: 50, droppedVideoFrames: 0 }, cond);
  // t=3800 is 2800ms since playingStartedAt (1000), so isSettled is now true!
  assert.equal(res.isSettled, true);
  assert.equal(res.stallCount, 2);
  assert.equal(res.totalStallMs, 1200);
  assert.equal(res.stallChoppy, true);
  assert.equal(res.choppy, true);
});

function frameDriver(options) {
  const detector=policy.choppinessDetector(options), warnings=[];
  let now=0,total=0,dropped=0,result;
  detector.update(now,{totalVideoFrames:total,droppedVideoFrames:dropped});
  function step(drop=6,conditions={},gap=500) {
    now+=gap;total+=12;dropped+=drop;
    result=detector.update(now,{totalVideoFrames:total,droppedVideoFrames:dropped},conditions);
    if(result.warning)warnings.push(now);
    return result;
  }
  return {detector,warnings,step,until(time,drop=6){while(now<time)step(drop);return result;},
    resetCounters(){total=0;dropped=0;return step(0);},get now(){return now;}};
}

test('two complete severe windows warn before the long detector, once per episode, and healthy playback rearms',()=>{
  const f=frameDriver();f.until(6000);assert.deepEqual(f.warnings,[]);
  const severe=f.step();assert.equal(severe.severeDropChoppy,true);assert.equal(severe.dropChoppy,false);
  assert.deepEqual(f.warnings,[6500]);
  f.until(30000);assert.deepEqual(f.warnings,[6500],'continuous degradation never repeats');
  f.until(40000,0);assert.equal(f.warnings.length,1,'recovery itself never warns');
  const recovered=f.until(42000,0);assert.equal(recovered.episodeActive,false);
  f.until(48000);assert.equal(f.warnings.length,2,'a new degraded episode can warn');
});

test('one severe window and insufficient frame counts cannot establish sustained severe degradation',()=>{
  const f=frameDriver();f.until(2500,0);f.until(4500,6);
  assert.equal(f.until(6500,0).severeDropChoppy,false);assert.deepEqual(f.warnings,[]);
  // Four drops per window meets the ratio gate but not the absolute-drop gate.
  const g=frameDriver();g.until(16000,1);assert.deepEqual(g.warnings,[]);
  const belowRatio=policy.choppinessDetector();let lowRatio;
  // 60fps with eight drops per two seconds passes the count gate but stays below 8%.
  for(let t=0;t<=15000;t+=500)lowRatio=belowRatio.update(t,{totalVideoFrames:t*.06,droppedVideoFrames:t*.004});
  assert.equal(lowRatio.choppy,false);
  const sparse=policy.choppinessDetector();let result;
  for(let t=0;t<=15000;t+=500)result=sparse.update(t,{totalVideoFrames:Math.floor(t/1000),droppedVideoFrames:Math.floor(t/2000)});
  assert.equal(result.choppy,false);assert.equal(result.warning,false);
});

test('interruptions, waiting, missing/reset counters and delayed samples invalidate short-window evidence',()=>{
  for(const interrupt of [
    f=>f.step(0,{paused:true}),f=>f.step(0,{seeking:true}),f=>f.step(0,{visible:false}),f=>f.step(0,{active:false}),
    f=>f.step(0,{waiting:true}),f=>f.detector.buffering(),f=>f.detector.interrupt(),
    f=>f.resetCounters(),f=>f.step(6,{},3000),
    f=>f.detector.update(f.now+100,undefined)
  ]) {
    const f=frameDriver();f.until(4500);assert.equal(f.warnings.length,0);
    interrupt(f);
    for(let i=0;i<4;i++)assert.equal(f.step().warning,false,'old problematic window cannot combine with new samples');
    assert.deepEqual(f.warnings,[]);
  }
  const stalled=frameDriver();stalled.until(3000,0);stalled.step(0,{waiting:true});
  assert.equal(stalled.step(0,{waiting:true},5000).choppy,false,'unobserved time is not a measured stall');
});

test('pauses, absent counters and buffering never rearm a warning as healthy playback',()=>{
  const f=frameDriver();f.until(7000);assert.equal(f.warnings.length,1);
  for(let i=0;i<24;i++)f.step(0,{paused:true});
  f.until(f.now+7000);assert.equal(f.warnings.length,1);
  f.detector.interrupt();f.until(f.now+5000,0);
  f.step(0,{waiting:true});f.until(f.now+6000,0);
  f.until(f.now+4000);assert.equal(f.warnings.length,1,'interrupted healthy periods cannot be combined');
  const healthy=frameDriver();healthy.until(6500);
  assert.equal(healthy.until(16000,0).episodeActive,true,'less than ten healthy seconds cannot rearm');
  assert.equal(healthy.step(0).rearmed,true,'five complete healthy windows rearm at ten seconds');
});

function watchFixture() {
  const toast=toastFixture(),commands=[],events=[];
  let now=0,total=0,dropped=0;
  const ctx={...toast,uburoomPlayback:policy,uburoom:{qualityId:value=>value},preferredQuality:'direct',selected:'room',hls:undefined,
    navigator:{},state:{id:'room',epoch:'epoch',mediaVersion:'movie',streamVersion:'a',mediaUrl:'/private-url',mediaId:'movie',quality:'direct',
      qualities:[{id:'direct'},{id:'720p4'},{id:'720p2'}],state:{paused:false}},
    video:{paused:false,seeking:false,currentTime:5,readyState:4,getVideoPlaybackQuality:()=>({totalVideoFrames:total,droppedVideoFrames:dropped})},
    autoplayBlocked:false,playbackError:'',seekDragging:false,sync:{timelinePending:false},playerWaiting:false,pending:false,qualityPending:false,
    document:{visibilityState:'visible'},performance:{now:()=>now},savePlayerPreferences(){},execute:async command=>{commands.push(command);},fail(){},
    diagnostics:{record:(event,fields)=>events.push({event,...fields})},diagnosticSample:(event,fields)=>events.push({event,...fields})};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('const choppyDetector ='),source.indexOf('function decodedFrames(')),ctx);
  ctx.checkChoppyPlayback();
  return {ctx,commands,events,...toast,
    run(ms,drop=6){for(let i=0;i<ms/500;i++){now+=500;total+=12;dropped+=drop;ctx.checkChoppyPlayback();}},
    read:()=>vm.runInContext('({active:choppyToastActive,dismissed:choppyDetector.isDismissed,cooldown:choppyDetector.inCooldown(performance.now())})',ctx)};
}

test('toast expiry clears watch bookkeeping without deliberate dismissal or repeated warnings',()=>{
  const f=watchFixture();f.run(7000);assert.equal(f.read().active,true);
  f.expire();assert.equal(f.read().active,false);assert.equal(f.read().dismissed,false);
  f.run(20000);assert.equal(f.read().active,false);assert.equal(f.events.filter(e=>e.event==='playback-degraded').length,1);
  f.run(12000,0);f.run(6000);assert.equal(f.read().active,true);
  const ordinary=toastFixture();let dismissed=0,closed=0;
  ordinary.toasts.show('other',{title:'Other',duration:1000,onDismiss:()=>dismissed++,onClose:()=>closed++});
  ordinary.expire();assert.equal(dismissed,0);assert.equal(closed,1);
});

test('same-media replacement preserves dismissal and cooldown; a new media/viewing session resets them',()=>{
  const f=watchFixture();f.run(7000);
  assert.deepEqual(f.commands,[],'runtime warnings never change quality automatically');
  const root=f.host.children.at(-1),actions=root.children[1].children[2];
  actions.children[1].listeners.click({stopPropagation(){}});assert.equal(f.read().dismissed,true);
  f.ctx.state.streamVersion='replacement';f.ctx.resetChoppyPlayback(true);f.run(20000);
  assert.equal(f.read().dismissed,true);assert.equal(f.read().active,false);
  f.ctx.state.mediaVersion='new-movie';f.ctx.resetChoppyPlayback(false);f.run(7000);
  assert.equal(f.read().active,true);
  f.host.children.at(-1).children[1].children[2].children[0].listeners.click({stopPropagation(){}});
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].action,'media.quality.set');assert.equal(f.commands[0].args.quality,'720p4');
  assert.equal(f.ctx.state.state.paused,false,'warning/action does not pause the room');
  f.ctx.state.streamVersion='lower-quality';f.ctx.resetChoppyPlayback(true);
  assert.equal(f.read().cooldown,true);f.run(9500);assert.equal(f.read().active,false);
  f.ctx.resetChoppyPlayback(false);assert.equal(f.read().cooldown,false);assert.equal(f.read().dismissed,false);
});

test('capability probes fail safely, do not guess metadata, and cannot warn or change quality',async()=>{
  const config={type:'media-source',video:{contentType:'video/mp4; codecs="avc1.640033"',width:3840,height:2160,bitrate:40000000,framerate:24}};
  assert.equal((await policy.decodingCapability(config,undefined)).capabilityStatus,'unavailable');
  let calls=0;const api={decodingInfo:async()=>{calls++;return {supported:true,smooth:false,powerEfficient:false};}};
  assert.equal((await policy.decodingCapability({type:'file'},api)).capabilityStatus,'incomplete');assert.equal(calls,0);
  assert.equal((await policy.decodingCapability(config,{decodingInfo:async()=>{throw new Error('Private URL');}})).capabilityStatus,'error');
  assert.equal((await policy.decodingCapability(config,{decodingInfo:()=>new Promise(()=>{})},5)).capabilityStatus,'error');
  const f=watchFixture();f.ctx.navigator.mediaCapabilities=api;
  await f.ctx.probePlaybackCapabilities(config);
  assert.equal(f.events.at(-1).capabilitySmooth,false);assert.equal(f.read().active,false);assert.deepEqual(f.commands,[]);
  let resolve;f.ctx.resetChoppyPlayback(true);f.ctx.navigator.mediaCapabilities={decodingInfo:()=>new Promise(done=>{resolve=done;})};
  const pending=f.ctx.probePlaybackCapabilities(config);f.ctx.state.streamVersion='superseded';
  resolve({supported:true,smooth:false,powerEfficient:false});await pending;
  assert.equal(f.events.filter(e=>e.event==='decode-capability').length,1,'superseded capability evidence is discarded');
});
