'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PlexReporting } = require('../server/plex-reporting');
const { Accounts, credentialVault } = require('../server/accounts');

function fixture({ reportingEnabled = true, watchStateEnabled = true } = {}) {
  let now = 100000;
  const dispatchedRequests = [];

  const fakeScopedPlex = (token, clientId) => ({
    token,
    clientId,
    request: async (resource, options = {}) => {
      const u = new URL(resource, 'http://127.0.0.1:32400');
      dispatchedRequests.push({
        url: u.pathname,
        params: Object.fromEntries(u.searchParams.entries()),
        headers: options.headers || {},
        method: options.method || 'GET'
      });
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });

  const registry = new Accounts(undefined, credentialVault());
  const userWithPlex = registry.resolve('plex', 'plex-sub-1', 'Alice');
  registry.credential('plex-sub-1', { token: 'server-token-alice', clientId: 'alice-client-id' });

  const sponsoredUser = registry.resolve('discord', 'discord-guest-1', 'Bob');

  const plexAuth = {
    forUser: async (userId) => {
      if (userId === userWithPlex.id) {
        return fakeScopedPlex('server-token-alice', 'alice-client-id');
      }
      return null;
    }
  };

  const config = {
    plexReporting: {
      enabled: reportingEnabled,
      watchState: watchStateEnabled
    }
  };

  const reporting = new PlexReporting({
    config,
    plexAuth,
    registry,
    now: () => now
  });

  const room = {
    s: { roomId: randomUUID() },
    media: { kind: 'plex', id: '13159', duration: 720 },
    mediaVersion: randomUUID()
  };

  const createViewer = (userId, overrides = {}) => ({
    userId,
    viewerId: randomUUID(),
    observationEpoch: randomUUID(),
    streamVersion: randomUUID(),
    mediaVersion: room.mediaVersion,
    plexReporting: true,
    plexWatchState: false, // default per owner decision
    media: { kind: 'plex', format: 'hls', transcodeId: 'shared-transcode-' + randomUUID() },
    ...overrides
  });

  const makeObserved = (pos, state = 'playing', reason = 'credited') => ({
    data: {
      position: pos,
      state,
      sequence: 1,
      sampleAt: now,
      observedAt: now,
      frames: 30,
      discontinuity: 0
    },
    observed: {
      accepted: true,
      playbackId: randomUUID(),
      credit: { reason, creditedSeconds: 1 }
    }
  });

  return {
    reporting,
    registry,
    room,
    userWithPlex,
    sponsoredUser,
    createViewer,
    makeObserved,
    dispatchedRequests,
    tick: (ms = 1000) => { now += ms; },
    close: () => registry.close()
  };
}

test('decoupled session identity: timeline reports use unique viewerSessionId and never transcodeId', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);
    const { data, observed } = f.makeObserved(10, 'playing', 'baseline');

    await f.reporting.observe(f.room, viewer, viewer.viewerId, data, observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;

    assert.equal(f.dispatchedRequests.length, 1);
    const req = f.dispatchedRequests[0];
    assert.equal(req.url, '/:/timeline');
    assert.equal(req.params.ratingKey, '13159');
    assert.equal(req.params.state, 'playing');
    assert.equal(req.params.time, '10000');

    const sessionHeader = req.headers['X-Plex-Session-Identifier'];
    assert.ok(sessionHeader, 'X-Plex-Session-Identifier must be set');
    assert.notEqual(sessionHeader, viewer.media.transcodeId, 'Must NOT match shared transcodeId');
    assert.equal(req.headers['X-Plex-Client-Identifier'], 'alice-client-id');
  } finally {
    f.close();
  }
});

test('shared-producer safety: stopping one viewer dispatches state=stopped under viewerSessionId without stopping transcode', async () => {
  const f = fixture();
  try {
    const sharedTranscodeId = 'transcode-shared-pool-999';
    const viewerA = f.createViewer(f.userWithPlex.id, {
      media: { kind: 'plex', format: 'hls', transcodeId: sharedTranscodeId }
    });

    const obsA1 = f.makeObserved(10, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewerA, viewerA.viewerId, obsA1.data, obsA1.observed);
    await f.reporting.sessions.get(viewerA.viewerId)?.dispatched;

    assert.equal(f.dispatchedRequests.length, 1);
    const sessionAId = f.dispatchedRequests[0].headers['X-Plex-Session-Identifier'];

    // Viewer A leaves the room
    await f.reporting.end(viewerA, 'left');

    assert.equal(f.dispatchedRequests.length, 2);
    const stopReq = f.dispatchedRequests[1];
    assert.equal(stopReq.params.state, 'stopped');
    assert.equal(stopReq.headers['X-Plex-Session-Identifier'], sessionAId);
    assert.notEqual(stopReq.headers['X-Plex-Session-Identifier'], sharedTranscodeId);

    // Verify session A was removed from reporting
    assert.equal(f.reporting.sessions.has(viewerA.viewerId), false);
  } finally {
    f.close();
  }
});

test('activity-only vs watch-state: duration is omitted by default and included only on opt-in', async () => {
  const f = fixture();
  try {
    // Viewer 1: default activity-only (watchState = false)
    const viewerDefault = f.createViewer(f.userWithPlex.id, { plexWatchState: false });
    const obs1 = f.makeObserved(15, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewerDefault, viewerDefault.viewerId, obs1.data, obs1.observed);
    await f.reporting.sessions.get(viewerDefault.viewerId)?.dispatched;

    const req1 = f.dispatchedRequests[0];
    assert.equal(req1.params.duration, undefined, 'duration must be omitted for activity-only');

    // Viewer 2: opted in to watch-state sync (watchState = true)
    const viewerSync = f.createViewer(f.userWithPlex.id, { plexWatchState: true });
    const obs2 = f.makeObserved(15, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewerSync, viewerSync.viewerId, obs2.data, obs2.observed);
    await f.reporting.sessions.get(viewerSync.viewerId)?.dispatched;

    const req2 = f.dispatchedRequests[1];
    assert.equal(req2.params.duration, '720000', 'duration must be included when watch-state is enabled');
  } finally {
    f.close();
  }
});

test('sponsored viewer isolation: users without personal Plex credentials are never reported to PMS', async () => {
  const f = fixture();
  try {
    const sponsoredViewer = f.createViewer(f.sponsoredUser.id);
    const obs = f.makeObserved(20, 'playing', 'baseline');

    await f.reporting.observe(f.room, sponsoredViewer, sponsoredViewer.viewerId, obs.data, obs.observed);

    assert.equal(f.dispatchedRequests.length, 0, 'No requests should ever be dispatched for sponsored viewers');
    assert.equal(f.reporting.sessions.has(sponsoredViewer.viewerId), false);
  } finally {
    f.close();
  }
});

test('fencing: mediaVersion, streamVersion, or observationEpoch changes tear down previous session', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);
    const obs1 = f.makeObserved(10, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obs1.data, obs1.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;

    const firstSessionId = f.dispatchedRequests[0].headers['X-Plex-Session-Identifier'];

    // Stream version rotates (e.g. quality change or seek)
    viewer.streamVersion = randomUUID();
    const obs2 = f.makeObserved(50, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obs2.data, obs2.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;

    // A stopped report was dispatched for the old session, and a new session started
    assert.equal(f.dispatchedRequests.length, 3);
    assert.equal(f.dispatchedRequests[1].params.state, 'stopped');
    assert.equal(f.dispatchedRequests[1].headers['X-Plex-Session-Identifier'], firstSessionId);

    const secondSessionId = f.dispatchedRequests[2].headers['X-Plex-Session-Identifier'];
    assert.notEqual(firstSessionId, secondSessionId, 'New stream version must start a distinct Plex session');
  } finally {
    f.close();
  }
});

test('rate limiting & state transitions: immediate on state change, throttled during continuous play', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);

    // Initial buffering
    const obsBuf = f.makeObserved(0, 'buffering', 'baseline');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsBuf.data, obsBuf.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 1);
    assert.equal(f.dispatchedRequests[0].params.state, 'buffering');

    // State transition to playing -> immediate
    const obsPlay = f.makeObserved(1, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsPlay.data, obsPlay.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 2);
    assert.equal(f.dispatchedRequests[1].params.state, 'playing');

    // 2 seconds later (position advance 2s) -> throttled
    f.tick(2000);
    const obsTick = f.makeObserved(3, 'playing', 'credited');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsTick.data, obsTick.observed);
    assert.equal(f.dispatchedRequests.length, 2, 'Should not dispatch yet');

    // 10 seconds later -> heartbeats
    f.tick(8000);
    const obsHeartbeat = f.makeObserved(11, 'playing', 'credited');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsHeartbeat.data, obsHeartbeat.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 3, 'Heartbeat dispatched after 10s');
    assert.equal(f.dispatchedRequests[2].params.time, '11000');

    // Pause state change -> immediate
    const obsPause = f.makeObserved(11, 'paused', 'not-playing');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsPause.data, obsPause.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 4);
    assert.equal(f.dispatchedRequests[3].params.state, 'paused');
  } finally {
    f.close();
  }
});

test('consent opt-out mid-stream: cleanly stops session on Plex', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);
    const obs = f.makeObserved(10, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obs.data, obs.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 1);

    // User opts out of both activity and watchState
    viewer.plexReporting = false;
    viewer.plexWatchState = false;

    const obsAfter = f.makeObserved(11, 'playing', 'credited');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsAfter.data, obsAfter.observed);

    // Opt out dispatched a final stopped report
    assert.equal(f.dispatchedRequests.length, 2);
    assert.equal(f.dispatchedRequests[1].params.state, 'stopped');
    assert.equal(f.reporting.sessions.has(viewer.viewerId), false);
  } finally {
    f.close();
  }
});

test('updateConsent({ activity: false }) immediately stops Plex timeline session', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);
    const obs = f.makeObserved(15, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obs.data, obs.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 1);
    assert.equal(f.dispatchedRequests[0].params.state, 'playing');

    // Call updateConsent with activity: false
    await f.reporting.updateConsent(viewer, { activity: false });
    assert.equal(f.reporting.sessions.has(viewer.viewerId), false);
    assert.equal(f.dispatchedRequests.length, 2);
    assert.equal(f.dispatchedRequests[1].params.state, 'stopped');
    assert.equal(f.dispatchedRequests[1].params.time, '15000');
  } finally {
    f.close();
  }
});

test('observe handles ended, error, subordinate watchState, and state mapping cleanly', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);

    // 1. Seeking and buffering map to 'buffering'
    const obsSeek = f.makeObserved(20, 'seeking', 'not-playing');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsSeek.data, obsSeek.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 1);
    assert.equal(f.dispatchedRequests[0].params.state, 'buffering');

    // 2. Blocked maps to 'paused'
    const obsBlocked = f.makeObserved(20, 'blocked', 'not-playing');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsBlocked.data, obsBlocked.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 2);
    assert.equal(f.dispatchedRequests[1].params.state, 'paused');

    // 3. Playback error ends session with 'playback-error' and sends state=stopped (never state=error)
    const obsError = f.makeObserved(20, 'error', 'not-playing');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obsError.data, obsError.observed);
    assert.equal(f.dispatchedRequests.length, 3);
    assert.equal(f.dispatchedRequests[2].params.state, 'stopped');
    assert.equal(f.reporting.sessions.has(viewer.viewerId), false);

    // 4. Ended directly terminates with updated position and sends state=stopped exactly once
    const viewer2 = f.createViewer(f.userWithPlex.id);
    const obsPlay = f.makeObserved(50, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer2, viewer2.viewerId, obsPlay.data, obsPlay.observed);
    await f.reporting.sessions.get(viewer2.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 4);

    const obsEnded = f.makeObserved(100, 'ended', 'baseline');
    await f.reporting.observe(f.room, viewer2, viewer2.viewerId, obsEnded.data, obsEnded.observed);
    assert.equal(f.dispatchedRequests.length, 5);
    assert.equal(f.dispatchedRequests[4].params.state, 'stopped');
    assert.equal(f.dispatchedRequests[4].params.time, '100000');
    assert.equal(f.reporting.sessions.has(viewer2.viewerId), false);

    // 5. plexWatchState cannot keep live timeline firing when plexReporting is false
    const viewer3 = f.createViewer(f.userWithPlex.id, { plexReporting: true, plexWatchState: true });
    const obsPlay3 = f.makeObserved(10, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer3, viewer3.viewerId, obsPlay3.data, obsPlay3.observed);
    await f.reporting.sessions.get(viewer3.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 6);

    // Turn plexReporting off while leaving plexWatchState on
    viewer3.plexReporting = false;
    viewer3.plexWatchState = true;
    const obsPlay4 = f.makeObserved(15, 'playing', 'credited');
    await f.reporting.observe(f.room, viewer3, viewer3.viewerId, obsPlay4.data, obsPlay4.observed);
    // Session should be stopped with opt-out
    assert.equal(f.dispatchedRequests.length, 7);
    assert.equal(f.dispatchedRequests[6].params.state, 'stopped');
    assert.equal(f.reporting.sessions.has(viewer3.viewerId), false);
  } finally {
    f.close();
  }
});
