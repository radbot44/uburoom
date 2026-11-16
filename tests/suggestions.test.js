'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Accounts, credentialVault } = require('../server/accounts');
const { Hub } = require('../server/core');
const { Watch } = require('../server/watch');
const Policy = require('../server/room-policy');
const { RECONNECT_GRACE_MS } = require('../shared/sync/envelope.mjs');
const { PROTOCOL_VERSION, splitView } = require('../shared/wire-protocol.mjs');
const { validate } = require('../shared/room-protocol.mjs');
const { watchOperations } = require('../server/watch-operations');
const { wireRooms } = require('./helpers/live-room');

async function fixture(t, { config = {}, plexOverrides = {} } = {}) {
  let now = 1000000;
  const clock = { now: () => now, advance: ms => (now += ms) };
  const registry = new Accounts(undefined, credentialVault());
  const hostId = registry.resolve('discord', '111111111111111111', 'Host').id;
  const viewerId = registry.resolve('discord', '222222222222222222', 'Viewer').id;
  const otherId = registry.resolve('discord', '333333333333333333', 'Other').id;
  const guestAccountId = registry.create('Guest');
  const hub = new Hub({ ownerId: '111111111111111111', ...config });
  hub.clock = clock;
  hub.access = { isMember: () => true, refresh: async () => true };

  const catalog = new Map([
    ['100', { id: '100', type: 'movie', title: 'Movie 100', duration: 120, thumb: '/t/100', year: 2024 }],
    ['101', { id: '101', type: 'movie', title: 'Movie 101', duration: 150, thumb: '/t/101', year: 2025 }],
    [
      '102',
      {
        id: '102',
        type: 'episode',
        title: 'Episode 102',
        parentTitle: 'Season 1',
        grandparentTitle: 'Show',
        episode: 2,
        duration: 45,
      },
    ],
    ['103', { id: '103', type: 'movie', title: 'Movie 103', duration: 90 }],
    ['104', { id: '104', type: 'movie', title: 'Movie 104', duration: 110 }],
    ['105', { id: '105', type: 'movie', title: 'Movie 105', duration: 95 }],
  ]);

  const plex = {
    principal: 'plex-host',
    json: async () => ({ machineIdentifier: 'fixture-plex' }),
    playableItem: async id => {
      const item = catalog.get(String(id));
      if (!item) throw Object.assign(new Error('Media unavailable'), { status: 404 });
      return { ...item };
    },
    prepare: async id => ({
      id,
      kind: 'plex',
      duration: catalog.get(String(id))?.duration || 100,
      title: catalog.get(String(id))?.title || 'Video ' + id,
      type: catalog.get(String(id))?.type || 'movie',
      resources: new Map(),
    }),
    stop: async () => {},
    close: async () => {},
    ...plexOverrides,
  };

  const watch = wireRooms(hub, plex, new Watch(hub, plex, undefined, registry));
  clearInterval(watch.roomState.timer);

  const host = { userId: hostId, name: 'Host', watchViewerId: randomUUID() };
  const viewer = { userId: viewerId, name: 'Viewer', watchViewerId: randomUUID() };
  const other = { userId: otherId, name: 'Other', watchViewerId: randomUUID() };
  const roomId = await watch.roomState.create(host, { name: 'Suggestions Room' });
  const room = watch.rooms.get(roomId);
  const guest = { userId: guestAccountId, name: 'Guest', guestRoomId: roomId, watchViewerId: randomUUID() };

  watch.join(room, host, host.watchViewerId, { alive: async () => true, quality: 'direct' });
  watch.join(room, viewer, viewer.watchViewerId, { alive: async () => true, quality: 'direct' });
  watch.join(room, guest, guest.watchViewerId, { alive: async () => true, quality: 'direct' });

  t.after(async () => {
    await watch.close().catch(() => {});
    hub.close();
    await registry.close();
  });

  return { clock, registry, hub, watch, room, roomId, host, viewer, other, guest, catalog, plex };
}

test('viewers and guests can suggest on live rooms, projecting onto the v2 room lane and rejecting closed rooms', async t => {
  const f = await fixture(t);
  const viewerView = f.watch.view(f.room, f.viewer, f.viewer.watchViewerId);
  const guestView = f.watch.view(f.room, f.guest, f.guest.watchViewerId);
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(viewerView.capabilities.suggestMedia, true);
  assert.equal(viewerView.capabilities.addQueue, false);
  assert.equal(guestView.capabilities.suggestMedia, true);
  assert.equal(guestView.capabilities.addQueue, false);
  assert.equal(Policy.VIEWER_BLOCKED.includes('suggestMedia'), false);

  const guestRes = await f.hub.dispatch(f.guest, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '101', title: 'Client Tampered', note: 'ignored note' } },
  });
  assert.equal(guestRes.status, 'applied', guestRes.message);
  assert.equal(guestRes.suggestion.item.title, 'Movie 101');
  assert.equal('note' in guestRes.suggestion.item, false);
  assert.deepEqual(guestRes.suggestion.supporters, ['Guest']);
  assert.equal(guestRes.suggestion.agreed, true);

  const hostView = f.watch.view(f.room, f.host, f.host.watchViewerId);
  const { room: roomLane, viewer: viewerLane } = splitView(hostView);
  assert.equal(roomLane.suggestions.length, 1);
  assert.equal(roomLane.suggestions[0].id, guestRes.suggestion.id);
  assert.equal(roomLane.suggestions[0].agreed, false);
  assert.equal(viewerLane.suggestions, undefined);
  assert.equal(f.watch.roomState.queue.pending(f.roomId).length, 0);

  // Saved/closed rooms reject ephemeral suggestions cleanly.
  await f.watch.remove(f.roomId);
  const closedRes = await f.hub.dispatch(f.host, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '102' } },
  });
  assert.equal(closedRes.status, 'unavailable');
});

test('permissions, duplicates, serverId spoofing, per-viewer/room bounds, dismiss, and agreement are enforced', async t => {
  const f = await fixture(t, { config: { roomLimits: { maxSuggestions: 3, maxSuggestionsPerViewer: 2 } } });
  await f.watch.roomState.queue.setAutoplay(f.roomId, f.host.userId, false);
  await f.hub.dispatch(f.host, { roomId: f.roomId, action: 'media.load', args: { mediaId: '100', quality: 'direct' } });
  await f.watch.roomState.queue.add(f.roomId, f.host.userId, {
    serverId: 'fixture-plex',
    mediaId: '101',
    type: 'movie',
    title: 'Movie 101',
    duration: 150,
  });

  // Reject duplicates in current, upcoming queue, and pending suggestions, plus spoofed serverId.
  for (const [id, expected] of [
    ['100', /already playing/],
    ['101', /already in the queue/],
  ]) {
    const dup = await f.hub.dispatch(f.viewer, { roomId: f.roomId, action: 'queue.suggest', args: { item: { id } } });
    assert.equal(dup.status, 'failed');
    assert.match(dup.message, expected);
  }
  const spoofed = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '101', serverId: 'evil-server' } },
  });
  assert.equal(spoofed.status, 'failed');
  assert.match(spoofed.message, /identity mismatch/);

  // Submit 2 suggestions from viewer (hits maxSuggestionsPerViewer = 2).
  const s1 = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '102' } },
  });
  const s2 = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '103' } },
  });
  assert.equal(s1.status, 'applied');
  assert.equal(s2.status, 'applied');

  // Suggesting a video already suggested agrees with it, without taking a room or viewer slot.
  const dupSug = await f.hub.dispatch(f.guest, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '102' } },
  });
  assert.equal(dupSug.status, 'applied', dupSug.message);
  assert.equal(dupSug.suggestion.id, s1.suggestion.id);
  assert.deepEqual(dupSug.suggestion.supporters, ['Viewer', 'Guest']);
  assert.equal(f.room.suggestions.length, 2);

  const overPerViewer = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '104' } },
  });
  assert.equal(overPerViewer.status, 'failed');
  assert.match(overPerViewer.message, /2 pending suggestions/);

  // Guest takes 3rd room slot (hits maxSuggestions = 3).
  const s3 = await f.hub.dispatch(f.guest, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '104' } },
  });
  assert.equal(s3.status, 'applied');
  f.watch.join(f.room, f.other, f.other.watchViewerId, { alive: async () => true, quality: 'direct' });
  const overRoom = await f.hub.dispatch(f.other, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '105' } },
  });
  assert.equal(overRoom.status, 'failed');
  assert.match(overRoom.message, /Suggestion limit reached/);

  // A viewer without addQueue cannot dismiss or accept; without chooseMedia cannot play a suggestion.
  for (const action of ['queue.suggestion.dismiss', 'queue.suggestion.accept', 'queue.suggestion.playNow']) {
    const denied = await f.hub.dispatch(f.viewer, {
      roomId: f.roomId,
      action,
      args: { suggestionId: s3.suggestion.id },
    });
    assert.equal(denied.status, 'forbidden', action);
  }

  // Agreeing toggles; a suggestion lives while anyone agrees and goes when the last viewer stops.
  const agree = (actor, suggestionId, value) =>
    f.hub.dispatch(actor, {
      roomId: f.roomId,
      action: 'queue.suggestion.agree',
      args: { suggestionId, agree: value },
    });
  const viewerLeaves = await agree(f.viewer, s1.suggestion.id, false);
  assert.equal(viewerLeaves.status, 'applied', viewerLeaves.message);
  assert.deepEqual(viewerLeaves.suggestion.supporters, ['Guest']);
  assert.equal(viewerLeaves.suggestion.agreed, false);
  // Disagreeing twice changes nothing.
  assert.deepEqual((await agree(f.viewer, s1.suggestion.id, false)).suggestion.supporters, ['Guest']);
  const guestLeaves = await agree(f.guest, s1.suggestion.id, false);
  assert.equal(guestLeaves.status, 'applied');
  assert.equal(guestLeaves.suggestion, undefined);
  assert.deepEqual(
    f.room.suggestions.map(entry => entry.id),
    [s2.suggestion.id, s3.suggestion.id],
  );
  const otherAgrees = await agree(f.other, s3.suggestion.id, true);
  assert.deepEqual(otherAgrees.suggestion.supporters, ['Guest', 'Other']);
  assert.equal(otherAgrees.suggestion.agreed, true);

  // Granting addQueue allows a non-host viewer to dismiss.
  const rec = f.watch.roomState.store.get(f.roomId);
  f.watch.roomState.apply(
    f.room,
    await f.watch.roomState.store.edit(f.roomId, f.host.userId, rec.revision, {
      action: 'permissions',
      role: 'viewer',
      permissions: { addQueue: true, suggestMedia: false },
    }),
  );
  const deniedSuggest = await f.hub.dispatch(f.guest, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '105' } },
  });
  assert.equal(deniedSuggest.status, 'forbidden');
  assert.equal((await agree(f.guest, s3.suggestion.id, false)).status, 'forbidden');

  const dismissed = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggestion.dismiss',
    args: { suggestionId: s3.suggestion.id },
  });
  assert.equal(dismissed.status, 'applied');
  assert.equal(f.room.suggestions.length, 1);
});

test('playing a suggestion loads it for everyone and settles it', async t => {
  const f = await fixture(t);
  await f.watch.roomState.queue.setAutoplay(f.roomId, f.host.userId, false);
  await f.hub.dispatch(f.host, { roomId: f.roomId, action: 'media.load', args: { mediaId: '100', quality: 'direct' } });
  const suggested = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '101' } },
  });
  assert.equal(suggested.status, 'applied', suggested.message);
  const played = await f.hub.dispatch(f.host, {
    roomId: f.roomId,
    action: 'queue.suggestion.playNow',
    args: { suggestionId: suggested.suggestion.id },
  });
  assert.equal(played.status, 'applied', played.message);
  assert.equal(f.room.media.id, '101');
  assert.equal(f.room.suggestions.length, 0);
});

test('accepting behaves like queue.add (idle initialAdd and normal append), rechecks media/authority, and prevents double insertion', async t => {
  let holdPlayable;
  let blockId = null;
  let deleted = false;
  const f = await fixture(t, {
    plexOverrides: {
      playableItem: async id => {
        if (deleted && String(id) === '101') throw Object.assign(new Error('Deleted on Plex'), { status: 404 });
        if (blockId && String(id) === blockId) {
          await new Promise(resolve => {
            holdPlayable = resolve;
          });
        }
        return {
          id: String(id),
          type: 'movie',
          title: 'Movie ' + id,
          duration: 120,
        };
      },
    },
  });
  await f.watch.roomState.queue.setAutoplay(f.roomId, f.host.userId, false);

  // Idle empty room: accept behaves identically to queue.add (initialAdd -> becomes current media, manualPaused).
  const idleSug = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '100' } },
  });
  assert.equal(idleSug.status, 'applied');
  const acceptedIdle = await f.hub.dispatch(f.host, {
    roomId: f.roomId,
    action: 'queue.suggestion.accept',
    args: { suggestionId: idleSug.suggestion.id },
  });
  assert.equal(acceptedIdle.status, 'applied', acceptedIdle.message);
  assert.equal(f.room.media.id, '100');
  assert.equal(f.watch.roomState.queue.current(f.roomId).mediaId, '100');
  assert.equal(f.watch.roomState.queue.pending(f.roomId).length, 0);
  assert.equal(f.room.suggestions.length, 0);
  assert.equal(f.room.manualPaused, true);

  // Non-empty room: TOCTOU deletion on Plex fails accept without consuming suggestion.
  const s101 = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '101' } },
  });
  assert.equal(s101.status, 'applied');
  deleted = true;
  const failedDeleted = await f.hub.dispatch(f.host, {
    roomId: f.roomId,
    action: 'queue.suggestion.accept',
    args: { suggestionId: s101.suggestion.id },
  });
  assert.equal(failedDeleted.status, 'failed');
  assert.match(failedDeleted.message, /Deleted on Plex/);
  assert.equal(f.room.suggestions.length, 1);
  assert.equal(f.room.suggestions[0].status, 'pending');
  assert.equal(f.watch.roomState.queue.pending(f.roomId).length, 0);

  // Concurrent double-accept race inserts only once.
  deleted = false;
  blockId = '101';
  const host2 = { userId: f.other.userId, name: 'Host2', watchViewerId: f.other.watchViewerId };
  const rec = f.watch.roomState.store.get(f.roomId);
  f.watch.roomState.apply(
    f.room,
    await f.watch.roomState.store.edit(f.roomId, f.host.userId, rec.revision, {
      action: 'host.add',
      userId: host2.userId,
    }),
  );
  f.watch.join(f.room, host2, host2.watchViewerId, { alive: async () => true, quality: 'direct' });

  const firstAttempt = f.hub.dispatch(f.host, {
    roomId: f.roomId,
    action: 'queue.suggestion.accept',
    args: { suggestionId: s101.suggestion.id },
  });
  while (!holdPlayable) await new Promise(setImmediate);
  const secondAttempt = await f.hub.dispatch(host2, {
    roomId: f.roomId,
    action: 'queue.suggestion.accept',
    args: { suggestionId: s101.suggestion.id },
  });
  assert.equal(secondAttempt.status, 'failed');
  holdPlayable();
  const firstResult = await firstAttempt;
  assert.equal(firstResult.status, 'applied', firstResult.message);
  assert.equal(f.watch.roomState.queue.pending(f.roomId).length, 1);
  assert.equal(f.watch.roomState.queue.pending(f.roomId)[0].mediaId, '101');
  assert.equal(f.room.suggestions.length, 0);
});

test('viewer leave, reconnect grace expiry, room reset, and room close clear ephemeral suggestions', async t => {
  const f = await fixture(t);

  // Multi-tab viewer keeps suggestion while one tab stays; clears when last tab leaves.
  const viewerTab2 = randomUUID();
  f.watch.join(f.room, { ...f.viewer, watchViewerId: viewerTab2 }, viewerTab2, {
    alive: async () => true,
    quality: 'direct',
  });
  const sv = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '101' } },
  });
  const sg = await f.hub.dispatch(f.guest, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '102' } },
  });
  const sw = await f.hub.dispatch(f.viewer, {
    roomId: f.roomId,
    action: 'queue.suggest',
    args: { item: { id: '103' } },
  });
  assert.equal(sv.status, 'applied');
  assert.equal(sg.status, 'applied');
  assert.equal(sw.status, 'applied');
  // The guest agrees with the viewer's 103, which keeps it alive after the viewer leaves.
  assert.equal(
    (await f.hub.dispatch(f.guest, { roomId: f.roomId, action: 'queue.suggest', args: { item: { id: '103' } } }))
      .status,
    'applied',
  );

  await f.watch.leave(f.room, f.viewer, f.viewer.watchViewerId);
  assert.equal(f.room.suggestions.length, 3);
  await f.watch.leave(f.room, f.viewer, viewerTab2);
  assert.deepEqual(
    f.room.suggestions.map(s => s.id),
    [sg.suggestion.id, sw.suggestion.id],
  );
  assert.deepEqual(
    f.room.suggestions[1].supporters.map(s => s.name),
    ['Guest'],
  );

  // Reconnect grace retains suggestion until grace expires, then clears it.
  f.watch.coordinator.run(f.room, { type: 'disconnect', viewerId: f.guest.watchViewerId, planned: true });
  assert.equal(f.room.suggestions.length, 2);
  f.clock.advance(RECONNECT_GRACE_MS + 1000);
  f.watch.touch(f.room, f.room.viewers.get(f.host.watchViewerId));
  f.watch.review(f.room);
  assert.equal(f.room.suggestions.length, 0);

  // Room reset clears all suggestions.
  const sh = await f.hub.dispatch(f.host, { roomId: f.roomId, action: 'queue.suggest', args: { item: { id: '103' } } });
  assert.equal(sh.status, 'applied');
  assert.equal(f.room.suggestions.length, 1);
  f.watch.dropMedia(f.room, 'room-reset');
  assert.equal(f.room.suggestions.length, 0);

  // Protocol validation enforces expected shape without note.
  assert.throws(() => validate({ action: 'queue.suggest', args: { item: { id: 'bad/id' } } }), /library item/);
  assert.throws(
    () => validate({ action: 'queue.suggestion.accept', args: { suggestionId: 'not-a-uuid' } }),
    /suggestion/,
  );

  // room.queue.command operation routes suggest -> accept/dismiss/withdraw cleanly.
  f.watch.join(f.room, f.viewer, f.viewer.watchViewerId, {
    alive: async () => true,
    quality: 'direct',
  });
  const ops = watchOperations({
    config: f.hub.config,
    watch: f.watch,
    hub: f.hub,
    authorized: async ctx => ({ actor: ctx.actor, guest: Boolean(ctx.actor.guestRoomId) }),
    login: async ctx => ctx.actor,
    throttle: () => true,
    registry: f.registry,
  });
  const opSuggest = await ops.call({ headers: {}, actor: f.viewer }, 'room.queue.command', {
    roomId: f.roomId,
    args: { action: 'suggest', item: { id: '104' } },
  });
  assert.equal(opSuggest.status, 200);
  assert.equal(opSuggest.value.suggestion.item.mediaId, '104');
  const opDismiss = await ops.call({ headers: {}, actor: f.host }, 'room.queue.command', {
    roomId: f.roomId,
    args: { action: 'suggestion.dismiss', suggestionId: opSuggest.value.suggestion.id },
  });
  assert.equal(opDismiss.status, 200);
  assert.equal(f.room.suggestions.length, 0);
});
