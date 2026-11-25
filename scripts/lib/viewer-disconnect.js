/* Focused case in playback-recovery: two disposable browsers, one real socket interrupted. */
/* global document, window, video, transport, state, playbackError */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { playbackBrowser, pause } = require('./playback-browser');
const { openPage } = require('./ui-fixture');

// Runs in the page. Observe actual join responses, pushed lanes, playback and controls. Keep
// grant URLs out of reports. Only equality, route kind and HTTP status are recorded.
async function observePage() {
  const { store } = await import('/watch/store.js');
  const joins = [],
    pushes = [],
    events = [],
    pictures = [];
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 9;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  function frame(_, metadata) {
    if (!video.paused && video.readyState >= 2) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
      pictures.push({ at: metadata.mediaTime, hash });
      if (pictures.length > 160) pictures.shift();
    }
    video.requestVideoFrameCallback(frame);
  }
  video.requestVideoFrameCallback(frame);
  const read = () => {
    const lanes = store.connection.roomLanes;
    return {
      connection: transport.connectionAttempt,
      roomLane: lanes?.room.version,
      viewerLane: lanes?.viewer.version,
      mediaId: state?.mediaId,
      mediaVersion: state?.mediaVersion,
      stream: state?.streamVersion,
      position: video.currentTime,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      paused: video.paused,
      ready: video.readyState,
      error: playbackError,
      format: state?.format,
      quality: state?.quality,
      volume: state?.state.volume,
      elementVolume: video.volume,
      muted: video.muted,
      pageStart: performance.timeOrigin,
    };
  };
  const join = transport.join.bind(transport);
  transport.join = async (...args) => {
    const result = await join(...args);
    window.disconnectProbe.joinUrl = result.viewer.state.mediaUrl;
    joins.push({
      connection: transport.connectionAttempt,
      roomLane: result.room.version,
      viewerLane: result.viewer.version,
      mediaVersion: result.viewer.state.mediaVersion,
      stream: result.viewer.state.streamVersion,
      quality: result.viewer.state.quality,
      volume: result.viewer.state.volume,
    });
    return result;
  };
  const receive = transport.onMessage;
  transport.onMessage = message => {
    const result = receive(message);
    if (message.type === 'viewer')
      pushes.push({
        connection: transport.connectionAttempt,
        sent: message.version,
        accepted: store.connection.roomLanes?.viewer.version,
        stream: message.state.streamVersion,
        volume: message.state.volume,
        quality: message.state.quality,
      });
    return result;
  };
  for (const event of ['waiting', 'stalled', 'pause', 'emptied', 'error'])
    video.addEventListener(event, () => events.push({ event, at: performance.now(), position: video.currentTime }));
  window.disconnectProbe = { joins, pushes, events, pictures, read };
  return true;
}

async function twoViewers({ app, url, name, output }) {
  const report = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    }).trim(),
    browser: name,
    cutMs: 14000,
    checks: {},
    snapshots: {},
    status: 'failed',
  };
  let hostBrowser, guestBrowser, host, guest, room, retiredPrefix;
  report.retiredGrantRequests = [];
  const observeRequest = (req, res) => {
    if (!retiredPrefix || !req.url.startsWith(retiredPrefix) || req.headers['x-fixture-probe']) return;
    res.on('finish', () => {
      if (res.statusCode >= 400 || req.url === retiredPrefix + 'start')
        report.retiredGrantRequests.push({
          resource: req.url === retiredPrefix + 'start' ? 'start' : 'resource',
          status: res.statusCode,
        });
    });
  };
  app.server.on('request', observeRequest);
  const write = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const snapshot = async (browser, page) => {
    const value = await browser.evaluate(page, 'disconnectProbe.read()');
    return { ...value, roomPosition: app.watch.position(room) };
  };
  const check = async (label, run) => {
    try {
      await run();
      report.checks[label] = 'passed';
    } catch (error) {
      report.checks[label] = error.message;
    }
    write();
  };
  const setControl = (browser, page, id, value, event) =>
    browser.evaluate(
      page,
      `(() => {
      const field = document.getElementById(${JSON.stringify(id)});
      if (field.disabled) throw new Error('Control disabled');
      field.value = ${JSON.stringify(String(value))};
      field.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true}));
      return true;
    })()`,
    );
  try {
    hostBrowser = await playbackBrowser(name);
    guestBrowser = await playbackBrowser(name);
    report.browserVersion = hostBrowser.version;
    [host, guest] = await Promise.all([
      openPage(hostBrowser, url + '/?demo=host'),
      openPage(guestBrowser, url + '/?demo=guest'),
    ]);
    for (const [browser, page] of [
      [hostBrowser, host],
      [guestBrowser, guest],
    ]) {
      await browser.until(page, 'globalThis.me && transport?.ready', 'Fixture sign-in');
      await browser.evaluate(page, '(' + observePage.toString() + ')()');
    }
    await hostBrowser.evaluate(
      host,
      'document.getElementById("create").click();document.getElementById("room-create").click();true',
    );
    await hostBrowser.until(host, '!!state && playbackClock.read().valid', 'Room creation');
    const roomId = await hostBrowser.evaluate(host, 'selected');
    room = app.watch.rooms.get(roomId);
    await hostBrowser.evaluate(
      host,
      'execute({action:"media.load",args:{mediaId:"104",quality:"720p4"}}).then(()=>true)',
    );
    const playing =
      'state?.mediaId==="104" && state.format==="hls" && !video.paused && video.readyState>=3 && video.currentTime>1 && !playbackError';
    await hostBrowser.until(host, playing, 'Host plays synthetic HLS');
    await guestBrowser.evaluate(guest, 'selectRoom(' + JSON.stringify(roomId) + ').then(()=>true)');
    await guestBrowser.until(guest, playing, 'Guest plays synthetic HLS');
    for (const volume of [74, 63, 79, 58, 67, 52]) {
      await setControl(guestBrowser, guest, 'player-volume', volume, 'input');
      await guestBrowser.until(guest, 'state.state.volume===' + volume, 'Personal volume before outage');
    }
    // Let only the guest run low on media. After the disconnect grace elapses
    // its player must reopen /start, so cached fragments cannot hide a stale grant.
    await guestBrowser.evaluate(guest, 'hls.stopLoad();true');
    const secondsBuffered = 'video.buffered.end(video.buffered.length-1)-video.currentTime';
    await guestBrowser.until(
      guest,
      'video.buffered.length && !video.paused && ' + secondsBuffered + '<5',
      'Guest has under five seconds of playable media before the cut',
      100000,
    );
    report.guestBufferAtCut = await guestBrowser.evaluate(guest, secondsBuffered);
    report.snapshots.beforeGuest = await snapshot(guestBrowser, guest);
    report.snapshots.beforeHost = await snapshot(hostBrowser, host);
    assert.ok(report.snapshots.beforeGuest.viewerLane >= 6, 'Precondition: viewer has a history on the first socket');
    assert.equal(room.viewers.size, 2);
    await hostBrowser.evaluate(host, 'disconnectProbe.events.length=0;true');
    const guestStart = await guestBrowser.evaluate(guest, 'disconnectProbe.oldUrl=state.mediaUrl');
    assert.match(guestStart, /^\/api\/watch\/media\/[^/]+\/start$/);
    retiredPrefix = guestStart.slice(0, -'start'.length);
    await guestBrowser.evaluate(guest, 'transport.interrupt(14000);true');
    await guestBrowser.until(guest, '!transport.ready && reconnecting', 'Guest WebSocket actually closes', 3000);
    await guestBrowser.until(
      guest,
      'reconnecting && !mediaSource && video.readyState===0',
      'Guest player unloads',
      11500,
    );
    await hostBrowser.until(host, 'state.viewers===1', 'Guest expires on the server', 16000);
    report.snapshots.duringHost = await snapshot(hostBrowser, host);
    assert.deepEqual(
      await hostBrowser.evaluate(host, 'disconnectProbe.events'),
      [],
      'Guest departure did not interrupt host',
    );
    // Only the host sees this seek. Its new position is outside the guest's buffered
    // ranges, so playing out the old buffer cannot accidentally pass the catch-up check.
    const target = 82;
    assert.equal(
      await guestBrowser.evaluate(
        guest,
        `Array.from({length:video.buffered.length},(_,i)=>video.buffered.start(i)<=${target}&&${target}<video.buffered.end(i)).some(Boolean)`,
      ),
      false,
    );
    await hostBrowser.evaluate(host, `execute({action:"media.seek.absolute",args:{seconds:${target}}}).then(()=>true)`);
    await hostBrowser.until(
      host,
      `video.currentTime>=${target} && !video.paused && !video.seeking && video.readyState>=3`,
      'Host completes intentional seek',
    );
    await hostBrowser.evaluate(host, 'disconnectProbe.events.length=0;true');
    await guestBrowser.until(
      guest,
      'transport.ready && !reconnecting && disconnectProbe.joins.some(j=>j.connection>1)',
      'Same tab automatically rejoins',
      16000,
    );
    await hostBrowser.until(host, 'state.viewers===2', 'Server admits guest again');
    // Compare the grant in the active player to the fresh join and retired grant immediately,
    // before a command or another join could repair the state. These are labelled test reads.
    report.grantProbes = await guestBrowser.evaluate(
      guest,
      `(async () => {
      const status = async url => {
        if (!url) return null;
        const response = await fetch(url, {cache:'no-store',headers:{'X-Fixture-Probe':'status',...(token ? {Authorization:'Bearer '+token} : {})}});
        await response.body?.cancel();
        return response.status;
      };
      const current = state?.mediaUrl, old = disconnectProbe.oldUrl, joined = disconnectProbe.joinUrl;
      return {activeIsOld:current===old,activeIsJoined:current===joined,old:await status(old),joined:await status(joined),active:await status(current)};
    })()`,
    );
    report.snapshots.rejoined = await snapshot(guestBrowser, guest);
    await check('freshGrant', () => {
      assert.equal(report.grantProbes.old, 403, 'Expired viewer grant should be rejected');
      assert.equal(report.grantProbes.joined, 200, 'Freshly admitted viewer should receive a usable stream');
      assert.equal(report.grantProbes.active, 200, 'Tab should adopt the usable grant automatically');
      assert.equal(report.grantProbes.activeIsJoined, true);
    });
    await check('decodedAtRoomPosition', async () => {
      await guestBrowser.until(
        guest,
        playing + ' && Math.abs(video.currentTime-expected())<1',
        'Guest plays the room video near target',
        8000,
      );
      const start = (report.snapshots.resumed = await snapshot(guestBrowser, guest));
      await pause(2300);
      const end = (report.snapshots.afterGuest = await snapshot(guestBrowser, guest));
      assert.equal(end.mediaVersion, room.mediaVersion);
      assert.equal(end.mediaId, '104');
      assert.equal(end.pageStart, report.snapshots.beforeGuest.pageStart, 'No page refresh');
      assert.ok(end.frames - start.frames >= 25 && end.position - start.position > 1.5, 'Sustained decoded playback');
      assert.ok(Math.abs(end.position - end.roomPosition) < 1, 'Within one second of authoritative server position');
      const [healthy, recovered] = await Promise.all(
        [
          [hostBrowser, host],
          [guestBrowser, guest],
        ].map(([browser, page]) => browser.evaluate(page, 'disconnectProbe.pictures.slice()')),
      );
      const matches = new Set(
        recovered
          .filter(p => p.at >= target && healthy.some(q => Math.abs(p.at - q.at) < 0.025 && p.hash === q.hash))
          .map(p => p.hash),
      );
      report.matchingPictures = matches.size;
      assert.ok(matches.size >= 8, 'Independent viewers must present matching pictures at matching media timestamps');
    });
    await check('volume', async () => {
      await setControl(guestBrowser, guest, 'player-volume', 33, 'input');
      await guestBrowser.until(
        guest,
        'state.state.volume===33 && Math.abs(video.volume-.33)<.01 && !video.muted',
        'Slider changes actual guest volume',
        4500,
      );
    });
    await check('quality', async () => {
      await setControl(guestBrowser, guest, 'quality', '360p1', 'change');
      await guestBrowser.until(
        guest,
        'state.quality==="360p1" && document.getElementById("quality").value==="360p1" && state.streamVersion!==disconnectProbe.joins.at(-1).stream',
        'Guest changes stream via quality selector',
        6500,
      );
      await guestBrowser.until(
        guest,
        playing + ' && !video.seeking && Math.abs(video.currentTime-expected())<1',
        'Changed quality decodes at room position',
      );
      const before = await snapshot(guestBrowser, guest);
      await pause(1400);
      const after = await snapshot(guestBrowser, guest);
      assert.ok(
        after.frames - before.frames > 12 && after.position - before.position > 0.8,
        'Changed quality keeps decoding',
      );
      assert.equal(after.elementVolume, 0.33, 'Quality replacement preserves guest volume');
    });
    await check('healthyViewer', async () => {
      const before = report.snapshots.beforeHost,
        end = (report.snapshots.afterHost = await snapshot(hostBrowser, host));
      assert.equal(end.stream, before.stream);
      assert.equal(end.mediaVersion, before.mediaVersion);
      assert.equal(end.quality, before.quality);
      assert.equal(end.volume, before.volume);
      assert.equal(end.elementVolume, before.elementVolume);
      assert.equal(end.paused, false);
      assert.ok(
        end.position - before.position >= 13 && end.frames - before.frames >= 200,
        'Healthy viewer keeps decoding',
      );
      assert.ok(Math.abs(end.position - end.roomPosition) < 1);
      assert.deepEqual(
        await hostBrowser.evaluate(host, 'disconnectProbe.events'),
        [],
        'No healthy viewer pause, stall, unload or error',
      );
    });
    assert.ok(
      Object.values(report.checks).every(value => value === 'passed'),
      'See per-check results in ' + path.join(output, 'report.json'),
    );
    report.status = 'passed';
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    app.server.off('request', observeRequest);
    if (host && room) report.snapshots.finalHost = await snapshot(hostBrowser, host).catch(() => null);
    if (guest) {
      report.lanes = await guestBrowser
        .evaluate(guest, 'globalThis.disconnectProbe && ({joins:disconnectProbe.joins,pushes:disconnectProbe.pushes})')
        .catch(() => null);
      if (room) report.snapshots.finalGuest = await snapshot(guestBrowser, guest).catch(() => null);
    }
    write();
    console.log('Viewer disconnect report:', path.join(output, 'report.json'));
    await Promise.allSettled([hostBrowser?.close(), guestBrowser?.close()]);
  }
}
module.exports = twoViewers;
