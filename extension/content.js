/* Picture CSS and shortcut behavior adapted from the user-verified v5.1 script. */
(function () {
  'use strict';
  if (window !== window.top || document.getElementById('uburoom-root')) return;
  const sessionId = crypto.randomUUID();
  let state = { ...uburoom.DEFAULT }, profiles = {}, selectedSlot = 1, fast = false;
  let enabled = false, live = false, epoch, liveUntil = 0, port, hideTimer, lastUrl = location.href;
  let sessionControls = { canManage: true, mode: 'owner', controls: { ...uburoom.CONTROLS }, autoJoin: false, paired: false, connected: false, sharingAvailable: false };
  const frameWindows = new WeakSet();
  let root, osd, panel, remoteUI, badge;
  const audio = { volume: undefined, muted: undefined }, watched = new WeakSet();
  const audioWrites = new WeakMap();
  let nativeAudioUntil = 0, nativeAudioPointer = false;
  function documents() {
    const docs = [document];
    document.querySelectorAll('iframe').forEach(frame => {
      try {
        if (frame.contentDocument?.documentElement) docs.push(frame.contentDocument);
        if (frame.contentWindow && !frameWindows.has(frame.contentWindow)) {
          frame.contentWindow.addEventListener('keydown', key, true); frameWindows.add(frame.contentWindow);
        }
      } catch {}
    });
    return docs;
  }
  function video() {
    return documents().flatMap(doc => [...doc.querySelectorAll('video')]).filter(v => v.isConnected && v.readyState >= 1)
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }
  function snapshot() {
    const v = video();
    return { picture: { ...state }, paused: v?.paused, muted: v?.muted, volume: v && Math.round(v.volume * 100), seekable: !!v?.seekable?.length, profileSlots: Object.keys(profiles).map(Number) };
  }
  function title() {
    const node = document.querySelector('title'); if (!node) return;
    const raw = node.textContent || '';
    const clean = raw.replace(/^(?:(?:🟢|🔵)\s*)+/, '');
    const changed = Object.keys(uburoom.DEFAULT).some(k => Math.abs(state[k] - uburoom.DEFAULT[k]) > .0000001);
    const next = (enabled && live && Date.now() < liveUntil ? '🟢 ' : '') + (changed ? '🔵 ' : '') + clean;
    if (raw !== next) node.textContent = next;
  }
  function mount() {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
    if (parent && root.parentElement !== parent) parent.appendChild(root);
  }
  function styles() {
    // Same individual CSS transforms as the working userscript; no transient site classnames.
    const css = 'video {scale:' + state.zoom * state.stretchX + ' ' + state.zoom * state.stretchY +
      ' !important;translate:' + state.x * 100 + '% ' + state.y * 100 + '% !important;transform-origin:center center !important;}';
    for (const doc of documents()) {
      let style = doc.getElementById('uburoom-video-css');
      if (!style) { style = doc.createElement('style'); style.id = 'uburoom-video-css'; (doc.head || doc.documentElement).appendChild(style); }
      if (style.textContent !== css) style.textContent = css;
    }
  }
  function show(message, sender = sessionControls.ownerName || 'You', symbol) {
    mount();
    sender = uburoom.senderName(sender, 'You');
    osd.removeAttribute('aria-hidden');
    if (typeof message === 'string') badge.notice(message, sender, symbol);
    else if (!badge.show(message, snapshot(), sender)) return;
    osd.style.opacity = '1'; clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { osd.style.opacity = '0'; osd.setAttribute('aria-hidden', 'true'); }, 2250);
  }
  function refresh() {
    styles(); title(); mount();
    remoteUI?.render(snapshot(), { available: !!video(), canSave: true, session: { ...sessionControls, enabled, live, reachable: !!video() } });
  }
  function applyAudio(v, force = false) {
    if (!v?.isConnected) return;
    const changed = audio.volume !== undefined && Math.abs(v.volume - audio.volume) > .0001 || audio.muted !== undefined && v.muted !== audio.muted;
    if (!changed) { if (force) syncNativeAudio(v); return; }
    if (!force && Date.now() - (audioWrites.get(v) || 0) < 100) return;
    audioWrites.set(v, Date.now());
    syncNativeAudio(v);
    if (audio.volume !== undefined && Math.abs(v.volume - audio.volume) > .0001) v.volume = audio.volume;
    if (audio.muted !== undefined && v.muted !== audio.muted) v.muted = audio.muted;
  }
  function syncNativeAudio(v) {
    // DOM controls observed on the live player. No page-world script or private API.
    const controls = [...v.ownerDocument.querySelectorAll('ytu-volume-slider')]
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const control = controls[0]; if (!control) return;
    const slider = control.querySelector('tp-yt-paper-slider');
    if (slider && audio.volume !== undefined) {
      slider.setAttribute('value', String(Math.round(audio.volume * 100)));
      slider.dispatchEvent(new Event('immediate-value-change', { bubbles: true, composed: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    const button = control.querySelector('button[aria-label]'), label = button?.getAttribute('aria-label') || '';
    if (audio.muted !== undefined && /^(?:unmute|mute)\b/i.test(label) && /^unmute\b/i.test(label) !== audio.muted) button.click();
  }
  function watchAudio() {
    for (const doc of documents()) for (const v of doc.querySelectorAll('video')) {
      if (!watched.has(v)) {
        watched.add(v);
        v.addEventListener('volumechange', () => {
          if (v !== video()) return;
          // Explicit interaction with native, accessible audio controls takes precedence.
          if (nativeAudioPointer || Date.now() < nativeAudioUntil) {
            audio.volume = v.volume;
            audio.muted = v.muted;
          } else applyAudio(v);
          remoteUI?.render(snapshot(), { available: true });
        });
        for (const event of ['loadedmetadata', 'playing']) v.addEventListener(event, () => { if (v === video()) applyAudio(v, true); });
      }
    }
    if (!nativeAudioPointer && Date.now() >= nativeAudioUntil) applyAudio(video());
  }
  function nativeAudio(e) {
    if (!e.isTrusted) return;
    if (e.type === 'pointerup' || e.type === 'pointercancel') { if (nativeAudioPointer) nativeAudioUntil = Date.now() + 1000; nativeAudioPointer = false; return; }
    if (e.composedPath().includes(root)) return;
    if (e.type === 'pointermove' && !e.buttons) return;
    const labels = e.composedPath().filter(n => n?.getAttribute).map(n => (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '')).join(' ');
    const nativeControl = e.composedPath().some(n => n?.matches?.('ytu-volume-slider, .ypc-volume-button'));
    if (nativeControl || /volume|mute|unmute/i.test(labels) || e.type === 'keydown' && e.code === 'KeyM' && !e.altKey && !e.ctrlKey) {
      nativeAudioUntil = Date.now() + 1000;
      if (e.type === 'pointerdown') nativeAudioPointer = true;
    }
  }
  async function seek(v, seconds, edge) {
    const ranges = Array.from({ length: v.seekable.length }, (_, i) => [v.seekable.start(i), v.seekable.end(i)]);
    const target = edge ? uburoom.seekBoundary(ranges, edge) : uburoom.seekTarget(v.currentTime, ranges, seconds);
    if (target === undefined) return false;
    if (Math.abs(v.currentTime - target) < .01) return v === video();
    return new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); v.removeEventListener('seeked', done); v.removeEventListener('error', failed); };
      const done = () => { finish(); resolve(v === video() && Math.abs(v.currentTime - target) < 1.5); };
      const failed = () => { finish(); resolve(false); };
      v.addEventListener('seeked', done, { once: true }); v.addEventListener('error', failed, { once: true });
      timer = setTimeout(failed, 1200);
      try { v.currentTime = target; } catch { failed(); }
    });
  }
  async function execute(input, remote) {
    try {
      const command = uburoom.validate(input);
      const permitted = () => !remote || remote.sessionId === sessionId && enabled && live &&
        epoch === remote.epoch && Date.now() < liveUntil && Date.now() < remote.localExpiresAt && location.href === lastUrl && !!video() &&
        (!remote.guest || uburoom.controlAllowed(sessionControls.controls, command));
      if (!permitted()) return { status: 'unavailable' };
      const { action, args } = command;
      if (action === 'status.get' || action === 'help.get') return { status: 'applied', state: snapshot() };
      if (action === 'profile.save') {
        const next = { ...profiles, [args.slot]: { ...state } };
        await browser.storage.local.set({ profiles: next }); profiles = next; selectedSlot = args.slot;
      } else if (action === 'profile.load') {
        if (!profiles[args.slot]) { show('Profile ' + args.slot + ' is empty', remote?.senderName || input.senderName); return { status: 'unsupported' }; }
        state = uburoom.picture(profiles[args.slot], { action: 'pan.move', args: { x: 0, y: 0 } }); selectedSlot = args.slot;
      } else if (action.startsWith('media.')) {
        const v = video(); if (!v) return { status: 'unavailable' };
        if (!['media.pause', 'media.play', 'media.toggle', 'media.mute', 'media.unmute', 'media.volume.set',
          'media.seek.relative', 'media.seek.start', 'media.seek.end'].includes(action)) return { status: 'unsupported', message: 'This player does not support that action.' };
        if (action === 'media.pause') v.pause();
        else if (action === 'media.play' || action === 'media.toggle' && v.paused) {
          await v.play();
          if (!permitted()) { v.pause(); return { status: 'unavailable' }; }
        } else if (action === 'media.toggle') v.pause();
        else if (action === 'media.mute') { audio.muted = true; applyAudio(v, true); }
        else if (action === 'media.unmute') { audio.muted = false; applyAudio(v, true); }
        else if (action === 'media.volume.set') { audio.volume = args.percent / 100; audio.muted = false; applyAudio(v, true); }
        else if (action.startsWith('media.seek.')) {
          if (!await seek(v, args.seconds, action === 'media.seek.relative' ? undefined : action.slice(11))) return { status: 'unsupported', message: 'Seeking is unavailable for this stream or range.' };
          if (!permitted()) return { status: 'unavailable' };
        }
        if (action === 'media.pause' && !v.paused || action === 'media.mute' && !v.muted || action === 'media.unmute' && v.muted ||
          action === 'media.volume.set' && (Math.abs(v.volume * 100 - args.percent) > .1 || v.muted)) return { status: 'failed' };
        if (v !== video()) return { status: 'unavailable' };
      } else state = uburoom.picture(state, command);
      refresh();
      if (remote && !action.startsWith('media.') && action !== 'profile.save') {
        const currentVideo = video();
        if (!currentVideo) return { status: 'unavailable' };
        const scale = currentVideo.ownerDocument.defaultView.getComputedStyle(currentVideo).scale.split(/\s+/).map(Number);
        // Computed CSS serializes large scales with rounded significant digits.
        const matches = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(.00001, Math.abs(expected) * .000005);
        if (!matches(scale[0], state.zoom * state.stretchX) || !matches(scale[1] ?? scale[0], state.zoom * state.stretchY)) {
          show('Site did not apply picture scale', remote?.senderName || input.senderName); return { status: 'unsupported' };
        }
      }
      show(command, remote?.senderName || input.senderName);
      return { status: 'applied', state: snapshot() };
    } catch (e) { show(e.message || 'Action failed', remote?.senderName || input?.senderName); return { status: 'failed' }; }
  }
  function toggle(force) {
    panel.hidden = typeof force === 'boolean' ? !force : !panel.hidden;
    if (!panel.hidden) browser.runtime.sendMessage({ type: 'panel-state', sessionId }).catch(() => {});
    if (panel.hidden) remoteUI.stop(); refresh();
  }
  function key(e) {
    const code = e.code || '';
    if (e.composedPath().some(n => n?.matches?.('input,textarea,select,[contenteditable],[role="textbox"]'))) return;
    if (code === 'F8' && !e.altKey && !e.ctrlKey && !e.metaKey || code === 'KeyC' && e.altKey && e.shiftKey && !e.metaKey) {
      e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) toggle(); return;
    }
    if (code === 'Escape' && !panel.hidden) { e.preventDefault(); e.stopImmediatePropagation(); toggle(false); return; }
    if (!e.altKey || !e.shiftKey || e.metaKey) return;
    const n = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    let command;
    const delta = e.ctrlKey ? .25 : .005, stretchDelta = e.ctrlKey ? .25 : .01;
    if (n) command = { action: e.ctrlKey ? 'profile.save' : 'profile.load', args: { slot: Number(n[1]) } };
    else if (['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'].includes(code)) command = { action: 'zoom.adjust', args: { delta: ['Minus', 'NumpadSubtract'].includes(code) ? -delta : delta } };
    else if (['KeyH', 'KeyJ', 'KeyV', 'KeyB'].includes(code)) command = { action: 'stretch.adjust', args: {
      axis: ['KeyH', 'KeyJ'].includes(code) ? 'stretchX' : 'stretchY', delta: ['KeyJ', 'KeyB'].includes(code) ? -stretchDelta : stretchDelta } };
    else if (code.startsWith('Arrow') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(code)) command = {
      action: 'pan.step', args: { axis: ['ArrowLeft', 'ArrowRight'].includes(code) ? 'x' : 'y', sign: ['ArrowLeft', 'ArrowUp'].includes(code) ? -1 : 1, fast: e.ctrlKey } };
    else if (['KeyP', 'KeyS', 'KeyZ', 'Digit0', 'Numpad0', 'KeyR'].includes(code)) command = { action: {
      KeyP: 'reset.pan', KeyS: 'reset.stretch', KeyZ: 'reset.zoom', Digit0: 'reset.all', Numpad0: 'reset.all', KeyR: 'reset.all' }[code] };
    if (command) { e.preventDefault(); e.stopImmediatePropagation(); execute(command); }
  }
  function build() {
    root = document.createElement('div'); root.id = 'uburoom-root';
    root.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    document.body.append(root);
    const shadow = root.attachShadow({ mode: 'open' }), style = document.createElement('style');
    style.textContent = '#osd{position:fixed;left:16px;top:16px;opacity:0;pointer-events:none;transition:opacity 250ms ease-out}#panel{position:fixed;top:12px;right:12px;width:min(420px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;pointer-events:auto;border-radius:28px;box-shadow:0 12px 50px #0009}#panel[hidden]{display:none!important}@media(prefers-reduced-motion:reduce){#osd{transition:none}}'; shadow.append(style);
    osd = document.createElement('div'); osd.id = 'osd'; osd.setAttribute('role', 'status'); osd.setAttribute('aria-atomic', 'true'); shadow.append(osd);
    badge = uburoomUI.mountBadge(osd);
    panel = document.createElement('div'); panel.id = 'panel'; panel.hidden = true; shadow.append(panel);
    remoteUI = uburoomUI.mount(panel, { trustedSessionControls: true, execute: async command => {
      if (!command.action.startsWith('session.')) return execute(command);
      const result = await browser.runtime.sendMessage({ type: 'local-session-command', sessionId, command });
      if (result?.error) throw new Error(result.error); return result;
    }, website: () => browser.runtime.sendMessage({ type: 'open-website', sessionId }), close: () => toggle(false) });
  }
  function connect() {
    enabled = live = false; title();
    port = browser.runtime.connect({ name: 'uburoom-player' });
    port.postMessage({ type: 'hello', sessionId });
    port.onMessage.addListener(m => {
      if (m.type === 'remote-state') {
        sessionControls = { canManage: true, mode: m.mode, controls: uburoom.controls(m.controls), autoJoin: m.autoJoin,
          ownerName: m.ownerName, paired: m.paired, connected: m.connected, sharingAvailable: m.sharingAvailable };
        enabled = m.enabled === true; live = m.live === true; epoch = m.epoch; liveUntil = live ? Date.now() + 8000 : 0; title();
        refresh();
      } else if (m.type === 'command-feedback' && m.sessionId === sessionId && m.command?.action?.startsWith('session.')) {
        show(uburoom.validate(m.command), m.senderName);
      }
    });
    port.onDisconnect.addListener(() => { port = undefined; enabled = live = false; sessionControls.connected = false; remoteUI.stop(); refresh(); setTimeout(connect, 3000); });
  }
  browser.runtime.onMessage.addListener(m => {
    if (m.type === 'remote-command') return execute(m, m);
    if (m.type === 'local-command') return execute(m);
    if (m.type === 'local-state') return Promise.resolve({ state: snapshot() });
    if (m.type === 'open-controls') { toggle(true); return Promise.resolve({}); }
  });
  async function boot() {
    build(); refresh(); window.addEventListener('keydown', key, true); document.addEventListener('fullscreenchange', mount);
    new MutationObserver(title).observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
    const saved = await browser.storage.local.get('profiles');
    // Migration reads only existing picture presets; new credentials never enter page storage.
    let source = saved.profiles;
    if (!source) {
      try { source = JSON.parse(localStorage.getItem('yttv-os5-profiles') || localStorage.getItem('yttv-overscan-profiles-v3') || '{}'); } catch {}
    }
    for (let slot = 1; slot <= 9; slot++) {
      try { if (source?.[slot]) profiles[slot] = uburoom.picture(source[slot], { action: 'pan.move', args: { x: 0, y: 0 } }); } catch {}
    }
    if (!saved.profiles && Object.keys(profiles).length) await browser.storage.local.set({ profiles });
    refresh(); show('Ready · F8 opens controls', undefined, 'website'); connect();
    window.addEventListener('pointerdown', nativeAudio, true); window.addEventListener('keydown', nativeAudio, true);
    window.addEventListener('pointermove', nativeAudio, true);
    window.addEventListener('pointerup', nativeAudio, true); window.addEventListener('pointercancel', nativeAudio, true);
    window.addEventListener('blur', () => { nativeAudioPointer = false; });
    setInterval(() => { watchAudio(); if (!panel.hidden) remoteUI.render(snapshot(), { available: !!video() }); }, 250);
    new MutationObserver(watchAudio).observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      const navigation = lastUrl !== location.href;
      lastUrl = location.href;
      const reachable = !!video();
      if (navigation || !reachable || live && Date.now() >= liveUntil) { enabled = live = false; title(); }
      try { port?.postMessage({ type: 'presence', reachable, navigation, state: snapshot() }); } catch {}
      refresh();
    }, 2000);
    window.addEventListener('pagehide', () => { enabled = live = false; port?.disconnect(); });
  }
  if (document.body) boot().catch(e => console.error('[uburoom] Startup failed:', e.message));
  else document.addEventListener('DOMContentLoaded', () => boot().catch(e => console.error('[uburoom] Startup failed:', e.message)), { once: true });
})();
