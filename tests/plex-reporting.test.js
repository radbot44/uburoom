'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PlexReporting } = require('../server/plex-reporting');
const { Accounts, credentialVault } = require('../server/accounts');

test('reporting coalesces queued states, applies current consent and drains retired sessions', async () => {
  let release, entered;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const sent = [];
  const scope = {
    principal: 'personal',
    clientId: 'fixture',
    request: async resource => {
      sent.push(new URL(resource, 'http://fixture').searchParams);
      if (sent.length === 1) {
        entered();
        await gate;
      }
    },
  };
  const reporting = new PlexReporting({ plexAuth: { forUser: async () => scope } });
  const viewer = { userId: 'viewer', streamVersion: 'stream', observationEpoch: 'epoch', plexWatchState: true };
  const room = { media: { kind: 'plex', id: '123:456', duration: 120 }, mediaVersion: 'media' };
  const observe = (state, position) =>
    reporting.observe(room, viewer, 'viewer', { state, position }, { credit: { reason: 'credited' } });
  try {
    await observe('playing', 1);
    await started;
    for (let i = 2; i < 20; i++) await observe(i % 2 ? 'paused' : 'buffering', i);
    viewer.plexWatchState = false;
    reporting.updateConsent(viewer, { watchState: false });
    release();
    await reporting.sessions.get('viewer').dispatched;
    assert.equal(sent.length, 2);
    assert.equal(sent[1].get('time'), '19000');
    assert.equal(sent[1].get('duration'), null);
    assert.equal(sent[1].get('ratingKey'), '123');
    assert.equal(sent[1].get('key'), '/library/metadata/123');
    const retiring = reporting.end(viewer, 'left');
    await reporting.close();
    await retiring;
    assert.equal(sent.at(-1).get('state'), 'stopped');
    assert.equal(reporting.retiring.size, 0);
  } finally {
    release();
    await reporting.close();
  }
});

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
        method: options.method || 'GET',
      });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  const registry = new Accounts(undefined, credentialVault());
  const userWithPlex = registry.resolve('plex', 'plex-sub-1', 'Alice');
  registry.credential('plex-sub-1', { token: 'server-token-alice', clientId: 'alice-client-id' });

  const sponsoredUser = registry.resolve('discord', 'discord-guest-1', 'Bob');

  const plexAuth = {
    forUser: async userId => {
      if (userId === userWithPlex.id) {
        return fakeScopedPlex('server-token-alice', 'alice-client-id');
      }
      return null;
    },
  };

  const config = {
    plexReporting: {
      enabled: reportingEnabled,
      watchState: watchStateEnabled,
    },
  };

  const reporting = new PlexReporting({
    config,
    plexAuth,
    registry,
    now: () => now,
  });

  const room = {
    roomId: randomUUID(),
    media: { kind: 'plex', id: '13159', duration: 720 },
    mediaVersion: randomUUID(),
    viewers: new Map(),
    disconnectedViewers: new Map(),
  };

  const createViewer = (userId, overrides = {}) => {
    const viewer = {
      userId,
      viewerId: randomUUID(),
      observationEpoch: randomUUID(),
      streamVersion: randomUUID(),
      mediaVersion: room.mediaVersion,
      plexReporting: true,
      plexWatchState: false, // default per owner decision
      media: { kind: 'plex', format: 'hls', transcodeId: 'shared-transcode-' + randomUUID() },
      ...overrides,
    };
    room.viewers.set(viewer.viewerId, viewer);
    return viewer;
  };

  const makeObserved = (pos, state = 'playing', reason = 'credited') => ({
    data: {
      position: pos,
      state,
      sequence: 1,
      sampleAt: now,
      observedAt: now,
      frames: 30,
      discontinuity: 0,
    },
    observed: {
      accepted: true,
      playbackId: randomUUID(),
      credit: { reason, creditedSeconds: 1 },
    },
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
    tick: (ms = 1000) => {
      now += ms;
    },
    close: () => registry.close(),
  };
}

test('decoupled session identity: timeline reports use unique viewerSessionId and never transcodeId', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);
    const obs1 = f.makeObserved(10, 'playing', 'baseline');
    const obs2 = f.makeObserved(10, 'playing', 'baseline');

    await Promise.all([
      f.reporting.observe(f.room, viewer, viewer.viewerId, obs1.data, obs1.observed),
      f.reporting.observe(f.room, viewer, viewer.viewerId, obs2.data, obs2.observed),
    ]);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;

    assert.equal(f.reporting.sessions.size, 1, 'concurrent observe initialization deduplicated');
    assert.equal(f.reporting.creating?.size || 0, 0);
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
      media: { kind: 'plex', format: 'hls', transcodeId: sharedTranscodeId },
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
    assert.notEqual(
      req1.headers['X-Plex-Client-Identifier'],
      req2.headers['X-Plex-Client-Identifier'],
      'duplicate tabs must stay distinct',
    );
    assert.notEqual(req1.headers['X-Plex-Session-Identifier'], req2.headers['X-Plex-Session-Identifier']);
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

test('viewing identity survives stream/delivery/observation changes but ends at media occurrence and leave boundaries', async () => {
  const f = fixture();
  try {
    const viewer = f.createViewer(f.userWithPlex.id);
    const obs1 = f.makeObserved(10, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, obs1.data, obs1.observed);
    await f.reporting.sessions.get(viewer.viewerId)?.dispatched;

    const firstSessionId = f.dispatchedRequests[0].headers['X-Plex-Session-Identifier'];

    for (const reason of ['stream-changed', 'delivery-changed', 'observation-timeout']) {
      await f.reporting.end(viewer, reason);
      viewer.streamVersion = randomUUID();
      viewer.observationEpoch = randomUUID();
      const obs2 = f.makeObserved(50, 'playing', 'baseline');
      await f.reporting.observe(f.room, viewer, viewer.viewerId, obs2.data, obs2.observed);
      await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    }
    // Epoch changes need no special handling by individual recovery paths.
    viewer.observationEpoch = randomUUID();
    const next = f.makeObserved(51);
    await f.reporting.observe(f.room, viewer, viewer.viewerId, next.data, next.observed);
    await f.reporting.sessions.get(viewer.viewerId).dispatched;
    assert.ok(f.dispatchedRequests.every(r => r.params.state !== 'stopped'));
    assert.ok(f.dispatchedRequests.every(r => r.headers['X-Plex-Session-Identifier'] === firstSessionId));

    f.room.mediaVersion = randomUUID();
    await f.reporting.observe(f.room, viewer, viewer.viewerId, next.data, next.observed);
    await f.reporting.sessions.get(viewer.viewerId).dispatched;
    assert.equal(f.dispatchedRequests.at(-2).params.state, 'stopped');
    const secondSessionId = f.dispatchedRequests.at(-1).headers['X-Plex-Session-Identifier'];
    assert.notEqual(firstSessionId, secondSessionId, 'even the same title in a new occurrence starts again');

    await f.reporting.end(viewer, 'left');
    await f.reporting.observe(f.room, viewer, viewer.viewerId, next.data, next.observed);
    await f.reporting.sessions.get(viewer.viewerId).dispatched;
    assert.notEqual(f.dispatchedRequests.at(-1).headers['X-Plex-Session-Identifier'], secondSessionId);
  } finally {
    f.close();
  }
});

test('reconnect keeps the reporting occurrence only within grace; missing viewers have bounded activity-only cleanup', async () => {
  const f = fixture();
  try {
    let viewer = f.createViewer(f.userWithPlex.id, { plexWatchState: true });
    const observe = async position => {
      const obs = f.makeObserved(position);
      await f.reporting.observe(f.room, viewer, viewer.viewerId, obs.data, obs.observed);
      await f.reporting.sessions.get(viewer.viewerId)?.dispatched;
    };
    const disconnect = async () => {
      const saved = { userId: viewer.userId, mediaVersion: f.room.mediaVersion, expires: f.reporting.now() + 60000 };
      f.room.disconnectedViewers.set(viewer.viewerId, saved);
      await f.reporting.end(viewer, 'disconnected');
      f.room.viewers.delete(viewer.viewerId);
      return saved;
    };
    await observe(10);
    const original = f.dispatchedRequests[0].headers;
    await f.reporting.end(viewer, 'observation-timeout');
    const deadline = f.reporting.sessions.get(viewer.viewerId).suspendedUntil;
    f.tick(1000);
    await f.reporting.end(viewer, 'observation-timeout');
    assert.equal(
      f.reporting.sessions.get(viewer.viewerId).suspendedUntil,
      deadline,
      'repeated suspension cannot extend recovery indefinitely',
    );
    const saved = await disconnect();
    f.tick(55000);
    f.reporting.refresh(f.room);
    await f.reporting.sessions.get(viewer.viewerId).dispatched;
    const gap = f.dispatchedRequests.at(-1);
    assert.equal(gap.params.state, 'buffering');
    assert.equal(gap.params.time, '10000');
    assert.equal(gap.params.duration, undefined, 'gap heartbeats cannot write personal watch progress');
    const old = viewer;
    viewer = f.createViewer(viewer.userId, { viewerId: viewer.viewerId, plexWatchState: true });
    f.room.disconnectedViewers.delete(viewer.viewerId);
    f.reporting.reconnect(f.room, viewer, saved);
    await observe(65);
    assert.deepEqual(f.dispatchedRequests.at(-1).headers, original);
    assert.ok(f.dispatchedRequests.every(r => r.params.state !== 'stopped'));
    await f.reporting.end(old, 'left');
    assert.equal(f.reporting.sessions.size, 1, 'old viewer object cannot end the reattached viewer');

    const expired = await disconnect();
    f.tick(60000);
    f.room.disconnectedViewers.delete(viewer.viewerId);
    f.reporting.refresh(f.room);
    await Promise.all([...f.reporting.retiring]);
    assert.equal(f.reporting.sessions.size, 0);
    assert.equal(f.dispatchedRequests.at(-1).params.state, 'stopped');
    assert.equal(f.dispatchedRequests.at(-1).params.duration, undefined);
    viewer = f.createViewer(viewer.userId, { viewerId: viewer.viewerId });
    f.reporting.reconnect(f.room, viewer, expired);
    await observe(70);
    assert.notEqual(
      f.dispatchedRequests.at(-1).headers['X-Plex-Session-Identifier'],
      original['X-Plex-Session-Identifier'],
    );
    await disconnect();
    await f.reporting.endViewer(f.room, viewer.viewerId, 'left');
    assert.equal(f.reporting.sessions.size, 0, 'explicit leave ends a saved disconnected viewer');
    viewer = f.createViewer(viewer.userId, { viewerId: viewer.viewerId });
    await observe(75);
    await disconnect();
    await f.reporting.endRoom(f.room);
    assert.equal(f.reporting.sessions.size, 0, 'room closure ends disconnected occurrences too');
    viewer = f.createViewer(viewer.userId, { viewerId: viewer.viewerId });
    await observe(80);
    await disconnect();
    await f.reporting.close();
    assert.equal(f.dispatchedRequests.at(-1).params.state, 'stopped');
    assert.equal(f.reporting.sessions.size + f.reporting.retiring.size, 0, 'shutdown drains suspended reporting too');
  } finally {
    await f.reporting.close();
    f.close();
  }
});

test('reporting fences delayed attachment work, serializes terminal replacement, and pins personal subject/server', async () => {
  let subject = 'subject',
    releaseAuth,
    holdAuth,
    releaseStop,
    holdStop,
    permitted = true;
  const sent = [];
  const scope = {
    principal: 'personal',
    clientId: 'fixture',
    base: new URL('http://fixture.invalid'),
    request: async (resource, options) => {
      const params = new URL(resource, 'http://fixture.invalid').searchParams;
      sent.push({
        state: params.get('state'),
        time: params.get('time'),
        id: options.headers['X-Plex-Session-Identifier'],
      });
      if (params.get('state') === 'stopped') await holdStop;
    },
  };
  const reporting = new PlexReporting({
    plexAuth: {
      forUser: async () => {
        await holdAuth;
        return scope;
      },
    },
    registry: {
      identities: () => [{ provider: 'plex', verified: true, subject }],
      credential: () => ({ serverToken: 'fixture' }),
    },
    authorize: async () => permitted,
  });
  const viewer = { viewerId: 'tab', userId: 'user', streamVersion: 's1', observationEpoch: 'o1', plexWatchState: true };
  const room = {
    media: { kind: 'plex', id: '123', duration: 120 },
    mediaVersion: 'm1',
    viewers: new Map([['tab', viewer]]),
  };
  const observe = (state, position) =>
    reporting.observe(room, viewer, 'tab', { state, position }, { credit: { reason: 'baseline' } });
  try {
    await observe('playing', 1);
    await reporting.sessions.get('tab').dispatched;
    holdAuth = new Promise(resolve => {
      releaseAuth = resolve;
    });
    await observe('paused', 2);
    await Promise.resolve();
    await observe('buffering', 3);
    void reporting.end(viewer, 'stream-changed');
    viewer.streamVersion = 's2';
    viewer.observationEpoch = 'o2';
    await observe('playing', 4);
    releaseAuth();
    holdAuth = undefined;
    await reporting.sessions.get('tab').dispatched;
    assert.deepEqual(
      sent.map(r => [r.state, r.time]),
      [
        ['playing', '1000'],
        ['playing', '4000'],
      ],
    );
    assert.equal(sent[0].id, sent[1].id);

    let releasePermission;
    const permission = new Promise(resolve => {
      releasePermission = resolve;
    });
    reporting.authorize = async () => {
      reporting.authorize = async () => true;
      return permission;
    };
    await observe('paused', 4);
    await new Promise(resolve => setImmediate(resolve));
    void reporting.end(viewer, 'delivery-changed');
    viewer.observationEpoch = 'o3';
    await observe('playing', 4.5);
    releasePermission(false);
    await reporting.sessions.get('tab').dispatched;
    assert.equal(sent.at(-1).time, '4500', 'a delayed denial for an old attachment cannot retire its replacement');
    assert.equal(sent.at(-1).id, sent[0].id);
    reporting.authorize = async () => permitted;

    holdStop = new Promise(resolve => {
      releaseStop = resolve;
    });
    const stopped = reporting.end(viewer, 'left');
    const rejoined = observe('playing', 5);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1).state, 'stopped', 'new activity waits for terminal dispatch to settle');
    releaseStop();
    holdStop = undefined;
    await stopped;
    await rejoined;
    await reporting.sessions.get('tab').dispatched;
    assert.notEqual(sent.at(-1).id, sent[0].id);

    scope.base = new URL('http://different-fixture.invalid');
    const before = sent.length;
    await observe('paused', 6);
    await reporting.sessions.get('tab')?.dispatched;
    assert.equal(sent.length, before, 'no report can move to another server');
    assert.equal(reporting.sessions.size, 0);
    await observe('playing', 7);
    await reporting.sessions.get('tab').dispatched;
    subject = 'different-subject';
    await reporting.end(viewer, 'left');
    assert.equal(sent.at(-1).state, 'playing', 'terminal report cannot be attributed to a replacement subject');

    holdAuth = new Promise(resolve => {
      releaseAuth = resolve;
    });
    const pending = observe('playing', 8);
    await reporting.end(viewer, 'left');
    releaseAuth();
    holdAuth = undefined;
    await pending;
    assert.equal(reporting.sessions.size, 0, 'leave cancels pending initialization');
    await observe('playing', 9);
    await reporting.sessions.get('tab').dispatched;
    permitted = false;
    await reporting.end(viewer, 'observation-timeout');
    assert.equal(reporting.sessions.size, 0, 'a denied heartbeat cannot retain or report the occurrence');
    assert.equal(sent.at(-1).time, '9000');
  } finally {
    releaseAuth?.();
    releaseStop?.();
    await reporting.close();
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

    // Explicit updateConsent with activity: false also immediately stops timeline
    const viewer2 = f.createViewer(f.userWithPlex.id);
    const obs2 = f.makeObserved(15, 'playing', 'baseline');
    await f.reporting.observe(f.room, viewer2, viewer2.viewerId, obs2.data, obs2.observed);
    await f.reporting.sessions.get(viewer2.viewerId)?.dispatched;
    assert.equal(f.dispatchedRequests.length, 3);
    assert.equal(f.dispatchedRequests[2].params.state, 'playing');

    await f.reporting.updateConsent(viewer2, { activity: false });
    assert.equal(f.reporting.sessions.has(viewer2.viewerId), false);
    assert.equal(f.dispatchedRequests.length, 4);
    assert.equal(f.dispatchedRequests[3].params.state, 'stopped');
    assert.equal(f.dispatchedRequests[3].params.time, '15000');
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
