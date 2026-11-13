// @ts-check
'use strict';
const { UUID, hash } = require('./core');
const { randomUUID } = require('node:crypto');
const RoomPolicy = require('./room-policy');
const { validateCommandEnvelope } = require('../shared/sync/envelope.mjs');
const { mediaIdentity } = require('../shared/room-protocol.mjs');
const Engine = require('../shared/engine.mjs');
const { PlaybackError } = require('./av1');
const { localFormat } = require('../web/playback-policy');
const { ObservationError } = require('./playback-tracking');
const { clientAddress } = require('./plex-delivery');
const { REJOIN } = require('./watch');
const { CALLS, splitView } = require('../shared/wire-protocol.mjs');

function applyRoomProgress(watch, roomId, items = []) {
  if (!roomId || !items.length) return;
  const liveRoom = watch.rooms.get(roomId);
  const saved = watch.roomState.store.get(roomId);
  let dbRows = new Map();
  try {
    const rows = watch.roomState.store.db
      .prepare(
        "SELECT mediaId, position, duration, outcome FROM watch_queue_entries WHERE roomId = ? AND state IN ('current', 'history') ORDER BY updatedAt ASC",
      )
      .all(roomId);
    for (const r of rows) {
      dbRows.set(r.mediaId, r);
    }
  } catch {}
  for (const item of items) {
    if (!item) continue;
    let pos = null;
    if (liveRoom?.media) {
      if (liveRoom.media.id === item.id) {
        const p = watch.position(liveRoom);
        const dur = liveRoom.media.duration || item.duration || 0;
        if (p >= 10 && (!dur || p <= dur * 0.92)) pos = Math.round(p);
        else if (dur && p > dur * 0.92) pos = 0;
      }
    }
    if (pos === null && saved?.bookmark) {
      if (saved.bookmark.mediaId === item.id) {
        const p = saved.bookmark.position;
        const dur = saved.bookmark.duration || item.duration || 0;
        if (p >= 10 && (!dur || p <= dur * 0.92)) pos = Math.round(p);
        else if (dur && p > dur * 0.92) pos = 0;
      }
    }
    if (pos === null && dbRows.has(item.id)) {
      const r = dbRows.get(item.id);
      if (r.outcome === 'completed') pos = 0;
      else {
        const p = Number(r.position || 0),
          dur = Number(r.duration || item.duration || 0);
        if (p >= 10 && (!dur || p <= dur * 0.92)) pos = Math.round(p);
        else if (dur && p > dur * 0.92) pos = 0;
      }
    }

    if (pos !== null) {
      if (pos > 0) item.viewOffset = pos;
      else delete item.viewOffset;
    } else if (item.viewOffset !== undefined) {
      if (item.viewOffset < 10 || (item.duration && item.viewOffset > item.duration * 0.92)) {
        delete item.viewOffset;
      }
    }
  }
}

const QUEUE_ACTIONS = [
  'add',
  'move',
  'remove',
  'clear',
  'playNow',
  'playEntry',
  'skipTo',
  'bulk',
  'shuffle',
  'auto',
  'auto.skip',
  'auto.pin',
  'auto.playNow',
];
const HISTORY_ACTIONS = ['clear', 'replay', 'goBack'];
const LIBRARY_QUERY = [
  'section',
  'parent',
  'collection',
  'tab',
  'q',
  'genre',
  'year',
  'sort',
  'order',
  'offset',
  'seed',
];
const text = value => (value === undefined || value === null ? null : String(value));

/**
 * The work behind every room connection message and the few GET routes that share it:
 * one function per kind of message, each returning `{status, value}`. Sign-in and room
 * access are checked here for every piece of work; framing belongs to the transports.
 *
 * A `context` is who is asking: the connection's credentials in header form (sign-in
 * reads cookies and bearer tokens), its socket when there is one, and an abort signal.
 * @typedef {{headers: Record<string, any>, signal?: AbortSignal, controlSocket?: {readyState: number, watchHeaders?: Object}, remoteAddress?: string}} Context
 */
function watchOperations({
  config,
  watch,
  hub,
  authorized,
  login,
  mediaGrant,
  cookies,
  throttle,
  registry,
  clockEpoch,
  delivery,
  validGrant,
}) {
  const result = (status, value) => ({ status, value });
  const refusal = error =>
    result([400, 403, 404, 409, 429, 503].includes(error.status) ? error.status : 400, {
      error:
        error.status || error instanceof PlaybackError
          ? error.message
          : 'Request failed; check Plex/Discord configuration and try again',
    });
  /**
   * Signs the asker in for one piece of their own work, which also renews their place,
   * claims pending host invites and refreshes their admin standing, then runs it.
   * @param {Context} context
   * @param {boolean} write Whether the work changes something (checked against origin and CSRF).
   * @param {(auth: any, current: () => Promise<boolean>) => any} work
   */
  async function asked(context, write, work) {
    try {
      context.signal?.throwIfAborted();
      const auth = await authorized(context, !!context.controlSocket || write);
      if (!auth) return result(401, { error: 'Log in with Discord' });
      context.signal?.throwIfAborted();
      watch.roomState.people.enter(auth.actor.userId);
      if (context.controlSocket) hub.directory.connected(context.controlSocket, auth.actor.userId);
      await watch.roomState.claimHosts(auth.actor.userId);
      await hub.refreshAdmin(auth.actor);
      const current = async () =>
        !context.signal?.aborted &&
        (!context.controlSocket || context.controlSocket.readyState === 1) &&
        (await login(context))?.userId === auth.actor.userId;
      return await work(auth, current);
    } catch (error) {
      return refusal(error);
    }
  }
  const foreignRoom = roomId => config.singleRoom && roomId !== registry.meta('singleRoomId');
  const ONLY_SHARED = { error: 'Only the configured shared room is available' };
  /**
   * Work addressed to one live room by someone who may see it.
   * @param {Context} context
   * @param {string} roomId
   * @param {(auth: any, room: any, current: () => Promise<boolean>) => any} work
   * @param {{recover?: boolean}} [options] `recover` reopens the room from the database first (a join).
   */
  const inRoom = (context, roomId, work, { recover = false } = {}) =>
    asked(context, true, async (auth, current) => {
      if (foreignRoom(roomId)) return result(403, ONLY_SHARED);
      if (recover && !watch.rooms.has(roomId)) await watch.roomState.recover(roomId, auth.actor, current);
      const room = watch.rooms.get(roomId);
      if (!(await watch.canView(room, auth.actor))) return result(403, { error: 'Room unavailable or private' });
      if (context.controlSocket && context.controlSocket.readyState !== 1)
        return result(409, { error: 'Room connection changed; retry manually' });
      return work(auth, room, current);
    });
  const ownViewer = async (room, auth, viewerId) => {
    const viewer = room.viewers.get(viewerId);
    return viewer &&
      viewer.userId === auth.actor.userId &&
      (!viewer.alive || (await viewer.alive())) &&
      (await watch.canView(room, auth.actor))
      ? viewer
      : undefined;
  };
  const dispatched = applied =>
    applied.status === 'applied'
      ? result(200, applied)
      : result(applied.httpStatus || { forbidden: 403, unavailable: 409, unsupported: 400 }[applied.status] || 400, {
          error: applied.message,
        });
  /** A saved room the asker may reach, checked before and after the work that reads it. */
  const savedRoom = async (roomId, auth, current) => {
    await watch.roomState.eligible(auth.actor, current);
    await watch.roomState.metadata(roomId, auth.actor);
  };

  /** What a joining tab says about itself, checked and turned into viewer settings. */
  function joinPreferences(preferences) {
    const settings = {};
    if (preferences.volume !== undefined)
      settings.volume = Engine.validate({
        action: 'media.volume.set',
        args: { percent: preferences.volume },
      }).args.percent;
    for (const key of ['muted', 'plexReporting', 'plexWatchState'])
      if (preferences[key] !== undefined) settings[key] = preferences[key];
    // A new viewer's saved subtitle choice shapes their first stream; their own later
    // choices in the room always win.
    if (
      preferences.subtitlePreference !== undefined ||
      preferences.subtitleMode !== undefined ||
      preferences.audioPreference !== undefined
    ) {
      const value = preferences.subtitlePreference || 'auto',
        mode = preferences.subtitleMode || 'auto';
      const language = /^language:([a-z]{2,3}(?:-[a-z0-9]+)*)$/i.exec(value)?.[1];
      const audio =
        preferences.audioPreference !== undefined
          ? /^language:([a-z]{2,3}(?:-[a-z0-9]+)*)$/i.exec(preferences.audioPreference)?.[1]
          : undefined;
      if (
        (!language && !['auto', 'off'].includes(value)) ||
        !['auto', 'burn'].includes(mode) ||
        (preferences.audioPreference !== undefined && !audio)
      )
        throw new Error('Invalid track preference');
      settings.trackChoice = {
        audioId: 'auto',
        subtitleId: value === 'off' ? 'off' : 'auto',
        subtitleMode: mode,
        ...(language ? { subtitleIntent: { language } } : {}),
        ...(audio ? { audioIntent: { language: audio } } : {}),
      };
    }
    return settings;
  }
  /** Admits (or renews) the tab with its preferences and connection details. Returns the joined viewer. */
  function admit(room, auth, context, viewerId, preferences, alive, authenticated) {
    if (preferences.delivery !== undefined && !/^(?:auto|local)$/.test(preferences.delivery))
      throw new Error('Invalid delivery mode');
    const viewer = watch.join(room, auth.actor, viewerId, {
      alive,
      quality: preferences.quality,
      preferences: joinPreferences(preferences),
    });
    // Capability is set before the first source preparation and never grants access.
    viewer.reportingAuthorized = authenticated;
    const remoteAddress = clientAddress(context);
    if (remoteAddress) viewer.remoteAddress = remoteAddress;
    viewer.activity = !!auth.identity.activity;
    if (viewer.activity && viewer.media?.directHls) {
      watch.tracking.end(viewer, 'delivery-changed');
      void watch.reporting?.end(viewer, 'delivery-changed');
      const previous = viewer.media;
      viewer.media = undefined;
      viewer.mediaVersion = undefined;
      viewer.directDelivery = undefined;
      viewer.directProxyVersion = room.mediaVersion;
      viewer.streamVersion = randomUUID();
      viewer.ready = false;
      void watch.plex.stop(previous);
    }
    if (context.controlSocket) viewer.watchSocket = context.controlSocket;
    if (viewer.browserSubtitles === undefined) viewer.browserSubtitles = preferences.subtitles === 'browser';
    viewer.localCodecs = (preferences.codecs || '').split(',').filter(localFormat);
    viewer.localDelivery = preferences.delivery === 'local';
    viewer.browserLoginHash = context.headers.authorization
      ? undefined
      : cookies(context).uburoom && hash(cookies(context).uburoom);
    return viewer;
  }
  const signedIn = (context, auth) => {
    const headers = { cookie: context.headers.cookie, authorization: context.headers.authorization };
    const authenticated = async () =>
      (await login({ headers: context.controlSocket?.watchHeaders || headers }))?.userId === auth.actor.userId;
    const alive = async () =>
      (!context.controlSocket || context.controlSocket.readyState === 1) && (await authenticated());
    return { authenticated, alive };
  };
  /**
   * One tab's view of its room as its two lanes (shared/wire-protocol.mjs). The viewer
   * lane carries the tab's stream with its media grant; `renew` extends that grant (the
   * tab's own request), a publication only reads it.
   * @param {Context} context
   * @param {any} auth
   * @param {any} room
   * @param {any} viewer
   * @param {{room?: boolean, viewer?: boolean, renew: boolean}} want
   */
  async function project(context, auth, room, viewer, { room: wantRoom = true, viewer: wantViewer = true, renew }) {
    const viewerId = viewer.viewerId;
    // What this projection is a picture of, for the publisher's lane versions.
    const version = watch.roomVersion(room),
      stamp = watch.viewerStamp(room, viewer);
    /** @type {Record<string, any>} */
    const state = watch.view(room, auth.actor, viewerId);
    if (wantViewer) {
      const fallbackMedia = watch.fallbackFor(room, viewer),
        fallbackGrant = fallbackMedia && mediaGrant(room, auth, context, viewerId, true, renew);
      if (fallbackGrant)
        state.fallbackStream = {
          mediaUrl: `/api/watch/media/${fallbackGrant}/start`,
          format: fallbackMedia.format,
          quality: fallbackMedia.quality,
          height: config.transcoding.fallback.height,
          bitrate: config.transcoding.fallback.bitrate,
          defaultAudioId: fallbackMedia.selection.audio?.id,
        };
      state.preparingQuality = !!viewer.media?.bootstrapFallback;
      viewer.directDelivery = undefined;
      const grant =
        !viewer.localDelivery && viewer.media?.format !== 'local'
          ? mediaGrant(room, auth, context, viewerId, false, renew)
          : undefined;
      if (grant) {
        state.mediaUrl = `/api/watch/media/${grant}/start`;
        if (viewer.media.bootstrapFallback) state.mediaUrl = undefined;
        const media = room.viewers.get(viewerId).media;
        if (media.format === 'hls' && media.directHls) {
          state.directHls = { ...media.directHls, session: media.transcodeId };
          state.directDelivery = true;
          viewer.directDelivery = media;
        } else if (
          !media.bootstrapFallback &&
          config.plexDelivery?.mode === 'auto' &&
          viewer.directProxyVersion !== room.mediaVersion
        ) {
          const direct = await delivery?.file(media, auth, () => validGrant(grant), viewer.remoteAddress);
          if (!(await validGrant(grant))) return result(409, { error: 'Playback delivery changed' });
          if (direct) {
            state.mediaUrl = direct;
            state.directDelivery = true;
            viewer.directDelivery = media;
          } else viewer.directDelivery = undefined;
        }
        if (media.selection?.subtitle?.available && media.selection.subtitle.delivery === 'text')
          state.subtitleUrl = `/api/watch/media/${grant}/captions-${media.captionVersion}`;
        else if (
          media.selection?.subtitle?.available &&
          ['ass', 'pgs', 'vobsub', 'cues'].includes(media.selection.subtitle.delivery)
        )
          state.subtitleUrl = `/api/watch/media/${grant}/subtitle-${media.captionVersion}`;
      }
    }
    const lanes = splitView(state);
    return result(200, {
      version,
      stamp,
      ...(wantRoom ? { room: lanes.room } : {}),
      ...(wantViewer ? { viewer: lanes.viewer } : {}),
    });
  }

  /**
   * `join`: admits the tab to the room (the only way in), prepares its stream and
   * answers with both lanes of its view.
   * @param {Context} context
   * @param {{roomId: string, viewerId: string, preferences?: Record<string, any>}} message
   */
  function join(context, { roomId, viewerId, preferences = {} }) {
    const serverReceivedAt = watch.clock.now(),
      receivedMono = performance.now();
    return inRoom(
      context,
      roomId,
      async (auth, room) => {
        if (!UUID.test(viewerId || '')) throw new Error('Invalid viewer');
        const { authenticated, alive } = signedIn(context, auth);
        const viewer = admit(room, auth, context, viewerId, preferences, alive, authenticated);
        await watch.prepareStream(room, auth.actor, viewerId);
        watch.requestEndingMeta(room);
        watch.reconcileFallback(room);
        if (viewer.streamFailure) throw viewer.streamFailure;
        if (!(await watch.canView(room, auth.actor)) || !(await alive()) || room.viewers.get(viewerId) !== viewer)
          return result(403, { error: 'Viewing access was revoked' });
        const view = await project(context, auth, room, viewer, { renew: true });
        if (view.status === 200)
          view.value.timing = {
            serverReceivedAt,
            serverSentAt: watch.clock.now(),
            serverProcessingMs: performance.now() - receivedMono,
            clockEpoch,
          };
        return view;
      },
      { recover: true },
    );
  }
  /**
   * The server's own publication of a tab's view. It reads: it never joins, starts
   * nothing and never asks Plex, so a tab the room let go of has to join again.
   * @param {Context} context
   * @param {string} roomId
   * @param {string} viewerId
   * @param {{room?: boolean, viewer?: boolean}} [want] The lanes to project.
   */
  async function lanes(context, roomId, viewerId, want = {}) {
    try {
      context.signal?.throwIfAborted();
      const auth = await authorized(context, true);
      if (!auth) return result(401, { error: 'Log in with Discord' });
      context.signal?.throwIfAborted();
      if (foreignRoom(roomId)) return result(403, ONLY_SHARED);
      const room = watch.rooms.get(roomId),
        viewer = room?.viewers.get(viewerId);
      if (!watch.canSee(room, auth.actor, viewer)) return result(403, { error: 'Room unavailable or private' });
      if (context.controlSocket && context.controlSocket.readyState !== 1)
        return result(409, { error: 'Room connection changed; retry manually' });
      // A tab the room let go of (privacy, presence timeout) is not let back in by looking.
      if (!viewer) return result(409, { error: REJOIN, rejoin: true });
      if (viewer.userId !== auth.actor.userId) throw new Error('Viewer identity mismatch');
      // It only waits for this tab's own stream work, which events start.
      await viewer.streamWork;
      if (room.media?.kind === 'plex' && viewer.access?.media !== room.media) await watch.checkAccess(room, viewer);
      if (viewer.streamFailure) throw viewer.streamFailure;
      const { alive } = signedIn(context, auth);
      if (!watch.canSee(room, auth.actor, viewer) || !(await alive()) || room.viewers.get(viewerId) !== viewer)
        return result(403, { error: 'Viewing access was revoked' });
      return await project(context, auth, room, viewer, { ...want, renew: false });
    } catch (error) {
      return refusal(error);
    }
  }
  /**
   * `leave`: the tab leaves its room.
   * @param {Context} context
   * @param {{roomId: string, viewerId: string}} message
   */
  const leave = (context, { roomId, viewerId }) =>
    inRoom(context, roomId, async (auth, room) => {
      await watch.leave(room, auth.actor, viewerId);
      return result(200, { ok: true });
    });
  /**
   * `command`: one room command through the shared command engine, fenced by the room
   * epoch and expiry the sender saw.
   * @param {Context} context
   * @param {{roomId: string, viewerId?: string, epoch?: string, expiresAt?: number, command: any}} message
   */
  const command = (context, message) =>
    inRoom(context, message.roomId, async (auth, room, current) => {
      if (!throttle('watch-command:' + auth.actor.userId, 120)) return result(429, { error: 'Too many commands' });
      const envelope = validateCommandEnvelope(
        {
          viewerId: message.viewerId,
          epoch: message.epoch,
          expiresAt: message.expiresAt,
          command: message.command,
        },
        { expectedEpoch: room.epoch, now: watch.clock.now() },
      );
      if (!envelope.ok) return result(409, { error: 'Room changed or command expired; retry manually' });
      const viewer = room.viewers.get(envelope.coordination.viewerId);
      if (envelope.coordination.viewerId !== undefined && (!viewer || viewer.userId !== auth.actor.userId))
        throw new Error('Invalid viewer');
      const applied = await hub.dispatch(
        {
          ...auth.actor,
          watchCurrent: current,
          ...(viewer ? { watchViewerId: envelope.coordination.viewerId } : {}),
        },
        { ...envelope.payload, roomId: room.roomId, expiresAt: envelope.coordination.expiresAt },
      );
      return result(200, applied);
    });
  /**
   * `ready`: the tab reports whether it has buffered the room's current video.
   * @param {Context} context
   * @param {{roomId: string, viewerId: string, mediaVersion?: string, ready?: boolean, readinessVersion?: any}} message
   */
  const ready = (context, message) =>
    inRoom(context, message.roomId, async (auth, room) => {
      await watch.ready(
        room,
        auth.actor,
        message.viewerId,
        message.mediaVersion,
        message.ready,
        message.readinessVersion,
      );
      return result(200, { ok: true });
    });
  /**
   * `observe`: the tab reports what its player actually decoded.
   * @param {Context} context
   * @param {{roomId: string, viewerId: string, observation: Record<string, any>}} message
   */
  const observe = (context, { roomId, viewerId, observation }) =>
    inRoom(context, roomId, async (auth, room) => {
      const viewer = await ownViewer(room, auth, viewerId);
      if (!viewer) return result(403, { error: 'Playback viewer unavailable' });
      const data = { ...observation, viewerId };
      try {
        const observed = watch.tracking.observe(room, viewer, viewerId, data);
        watch.observed(room, viewer);
        await watch.reporting?.observe(room, viewer, viewerId, data, observed);
        await watch.observeEnd(room, viewer, data, observed);
        return result(200, observed);
      } catch (error) {
        return result(error instanceof ObservationError ? 409 : 503, {
          error: 'Playback observation unavailable',
          rejection: error instanceof ObservationError ? error.rejection : 'storage-failure',
        });
      }
    });

  /** Who the asker is and what this server lets them do. */
  const identity = auth => ({
    name: auth.actor.name,
    owner: hub.isOwner(auth.actor),
    adminEligible: hub.canAdmin(auth.actor),
    adminMode: hub.isAdmin(auth.actor),
    durableRooms: true,
    roomLimits: watch.roomState.limits,
    singleRoom: !!config.singleRoom,
    roomPermissionDefaults: RoomPolicy.policy(config.roomPermissions),
    csrf: auth.identity.csrf,
    account: registry.summary(auth.actor.userId),
    guest: registry.isGuest(auth.actor.userId),
    guestRoomId: auth.actor.guestRoomId,
  });
  const listRooms = async (auth, current) => {
    if (config.singleRoom) await watch.roomState.ensureSingle(auth.actor, current);
    return watch.list(auth.actor, auth.identity.activity === true);
  };
  /**
   * The server's own publication of the lobby lane: who the asker is and the rooms they
   * may see. Like `lanes`, it only reads.
   * @param {Context} context
   */
  async function lobby(context) {
    try {
      context.signal?.throwIfAborted();
      const auth = await authorized(context, true);
      if (!auth) return result(401, { error: 'Log in with Discord' });
      const current = async () => !context.signal?.aborted && (await login(context))?.userId === auth.actor.userId;
      return result(200, { identity: identity(auth), rooms: await listRooms(auth, current) });
    } catch (error) {
      return refusal(error);
    }
  }

  async function library(op, { context, auth, args }) {
    const room = watch.rooms.get(args.room);
    const lobbyScope = args.room === undefined && args.session === undefined;
    const eligible = async () =>
      !context.signal?.aborted &&
      (lobbyScope || (room && watch.rooms.get(room.roomId) === room && (await watch.canView(room, auth.actor)))) &&
      (await login(context))?.userId === auth.actor.userId;
    if (!(await eligible())) return result(403, { error: 'Library access requires room access' });
    const plex = await hub.plexFor(auth.actor);
    const scopeCurrent = async () => (await hub.plexFor(auth.actor)).principal === plex.principal;
    const itemVisible = async () =>
      plex.principal === 'discord-shared' || (await plex.visible(text(args.item), text(args.type)));
    let data;
    if (op === 'library.art') {
      const art = await plex.artwork(text(args.item), text(args.kind) || 'poster', text(args.type));
      if (!(await eligible()) || !(await scopeCurrent()) || !(await itemVisible()))
        return result(403, { error: 'Library access was revoked' });
      return { status: 200, resource: art };
    } else if (op === 'library.availability') {
      const ids = String(args.items || '').split(',');
      if (ids.length > 80 || ids.some(id => id === 'demo' || !mediaIdentity(id)))
        return result(400, { error: 'Select between 1 and 80 Plex items' });
      data = { items: [...(await plex.availability(ids))].map(([id, available]) => ({ id, available })) };
    } else if (op === 'library.item') {
      data = { item: await plex.details(text(args.item), text(args.type)) };
      if (data.item) applyRoomProgress(watch, args.room, [data.item]);
    } else if (op === 'library.filters') data = await plex.filters(text(args.section));
    else {
      const query = Object.fromEntries(
        LIBRARY_QUERY.filter(key => args[key] !== undefined && args[key] !== null).map(key => [key, String(args[key])]),
      );
      data = plex.configured ? await plex.browse(query) : { items: [], total: 0, offset: 0, nextOffset: null };
      data.testVideo = !!watch.demoMedia;
      if (data.items?.length) applyRoomProgress(watch, args.room, data.items);
    }
    if (!(await eligible()) || !(await scopeCurrent()) || (op === 'library.item' && !(await itemVisible())))
      return result(403, { error: 'Library access was revoked' });
    return result(200, data);
  }
  /** A page of a saved room's queue or history, or one change to it through the command engine. */
  async function queued(kind, write, { auth, current, roomId, args }) {
    await savedRoom(roomId, auth, current);
    if (!(await current())) return result(403, { error: 'Room access changed' });
    const room = watch.rooms.get(roomId);
    if (room && !(await watch.canView(room, auth.actor))) return result(403, { error: 'Room unavailable or private' });
    if (!write) {
      const page = { offset: Number(args.offset || 0), limit: Number(args.limit || 50) };
      return result(
        200,
        kind === 'queue' ? watch.roomState.queue.list(roomId, page) : watch.roomState.queue.history(roomId, page),
      );
    }
    if (!throttle('room-queue:' + auth.actor.userId, 60)) return result(429, { error: 'Too many queue operations' });
    if (!(kind === 'queue' ? QUEUE_ACTIONS : HISTORY_ACTIONS).includes(args.action))
      return result(400, { error: `Unsupported ${kind} action` });
    return dispatched(
      await hub.dispatch(
        { ...auth.actor, watchCurrent: current },
        kind === 'queue'
          ? {
              roomId,
              action: 'queue.' + args.action,
              args: { ...args, unfinished: args.unfinished ?? false, includeSpecials: args.includeSpecials ?? false },
            }
          : { roomId, action: 'queue.history.' + args.action, args: { ...args, resume: !!args.resume } },
      ),
    );
  }
  /**
   * The named calls of shared/wire-protocol.mjs (`CALLS`), plus `library.art` for its GET route.
   * @type {Record<string, (input: any) => any>}
   */
  const calls = {
    me: ({ auth }) => result(200, identity(auth)),
    async 'profile.rename'({ auth, args }) {
      if (!throttle('profile-name:' + auth.actor.userId, 20))
        return result(429, { error: 'Too many name changes; try again shortly' });
      const account = await hub.renameAccount(auth.actor.userId, args.name);
      return result(200, { name: account.name });
    },
    'admin.mode'({ auth, args }) {
      if (!hub.canAdmin(auth.actor) || typeof args.enabled !== 'boolean')
        return result(403, { error: 'Only an authorized administrator can change Admin mode' });
      hub.setAdminMode(auth.actor, args.enabled);
      watch.identityChanged();
      return result(200, { adminMode: hub.isAdmin(auth.actor) });
    },
    'library.browse': input => library('library.browse', input),
    'library.item': input => library('library.item', input),
    'library.availability': input => library('library.availability', input),
    'library.filters': input => library('library.filters', input),
    'library.art': input => library('library.art', input),
    async 'playback.history'({ auth, current }) {
      const history = await watch.tracking.history(auth.actor.userId);
      if (!(await current())) return result(403, { error: 'Playback history access expired' });
      return result(200, history);
    },
    'rooms.list': async ({ auth, current }) => result(200, { rooms: await listRooms(auth, current) }),
    async 'rooms.saved'({ auth, current, args }) {
      await watch.roomState.eligible(auth.actor, current);
      return result(200, watch.roomState.list(auth.actor, { offset: Number(args.offset || 0) }));
    },
    async 'rooms.create'({ auth, current, args }) {
      if (config.singleRoom) return result(403, { error: 'Room creation is disabled in single-room mode' });
      return result(201, { id: await watch.roomState.create(auth.actor, args, current) });
    },
    async 'events.list'({ auth, current }) {
      if (!watch.events)
        return result(200, { events: [], canSchedule: false, discord: { configured: false, available: false } });
      return result(200, await watch.events.lobby(auth.actor, current));
    },
    async 'events.schedule'({ auth, current, args }) {
      if (!watch.events) return result(404, { error: 'Events are unavailable' });
      if (!throttle('room-publish:' + auth.actor.userId, 20))
        return result(429, { error: 'Too many event changes. Try again shortly.' });
      return result(200, await watch.events.schedule(auth.actor, args, current));
    },
    'room.reopen': async ({ auth, current, roomId }) =>
      result(200, { id: await watch.roomState.reopen(roomId, auth.actor, current) }),
    async 'room.close'({ auth, current, roomId, args }) {
      const room = watch.rooms.get(roomId);
      if (!room) return result(403, { error: 'Room unavailable or private' });
      return result(200, await watch.roomState.closeRoom(roomId, auth.actor, args.epoch, current));
    },
    async 'room.people'({ auth, current, roomId, args }) {
      if (!throttle('room-people:' + auth.actor.userId, 120)) return result(429, { error: 'Too many searches' });
      const check = async () => {
        await savedRoom(roomId, auth, current);
        const room = watch.roomState.store.get(roomId);
        if (!hub.isAdmin(auth.actor) && !RoomPolicy.allowed(room, auth.actor.userId, 'addHosts'))
          throw Object.assign(new Error('Add hosts permission required'), { status: 403 });
        return room;
      };
      const room = await check();
      const members = [...(watch.rooms.get(room.id)?.viewers.values() || [])]
        .filter(v => !v.watchSocket || v.watchSocket.readyState === 1)
        .map(v => v.userId);
      const found = await hub.directory.search(String(args.q || ''), {
        members,
        hosts: room.hosts,
        creatorId: room.creatorId,
        allHosts: room.permissions.allHosts,
        pending: watch.roomState.store.pendingHosts(room.id),
      });
      const latest = await check();
      if (latest.revision !== room.revision) return result(409, { error: 'Room changed; search again' });
      return result(200, found);
    },
    async 'room.settings'({ auth, current, roomId }) {
      await savedRoom(roomId, auth, current);
      if (!(await current())) return result(403, { error: 'Room access changed' });
      return result(200, watch.roomState.summary(roomId, auth.actor));
    },
    async 'room.settings.edit'({ auth, current, roomId, args }) {
      if (!throttle('room-settings:' + auth.actor.userId, 60)) return result(429, { error: 'Too many room changes' });
      return result(200, await watch.roomState.edit(roomId, auth.actor, args.revision, args.change, current));
    },
    async 'room.events'({ auth, current, roomId }) {
      if (!watch.events) return result(404, { error: 'Events are unavailable' });
      await savedRoom(roomId, auth, current);
      const value = await watch.events.summary(roomId, auth.actor);
      if (!(await current())) return result(403, { error: 'Room access changed' });
      return result(200, value);
    },
    async 'room.events.command'({ auth, current, roomId, args }) {
      if (!watch.events) return result(404, { error: 'Events are unavailable' });
      await savedRoom(roomId, auth, current);
      if (!throttle('room-publish:' + auth.actor.userId, 20))
        return result(429, { error: 'Too many event changes. Try again shortly.' });
      if (Engine.command(args.action)?.service !== 'event') return result(400, { error: 'Unsupported event action' });
      return result(
        200,
        await hub.dispatch({ ...auth.actor, watchCurrent: current }, { roomId, action: args.action, args }),
      );
    },
    async 'room.share'({ auth, current, roomId }) {
      if (!watch.publications) return result(404, { error: 'Sharing is unavailable' });
      await savedRoom(roomId, auth, current);
      const value = await watch.publications.summary(roomId, auth.actor);
      await savedRoom(roomId, auth, current);
      if (!(await current())) return result(403, { error: 'Room access changed' });
      return result(200, value);
    },
    async 'room.share.command'({ auth, current, roomId, args }) {
      if (!watch.publications) return result(404, { error: 'Sharing is unavailable' });
      await savedRoom(roomId, auth, current);
      if (!throttle('room-publish:' + auth.actor.userId, 20))
        return result(429, { error: 'Too many publication requests. Try again shortly.' });
      if (!['publish', 'unpublish'].includes(Engine.command(args.action)?.service))
        return result(400, { error: 'Unsupported sharing action' });
      return result(
        200,
        await hub.dispatch({ ...auth.actor, watchCurrent: current }, { roomId, action: args.action, args: {} }),
      );
    },
    'room.queue': input => queued('queue', false, input),
    'room.queue.command': input => queued('queue', true, input),
    'room.history': input => queued('history', false, input),
    'room.history.command': input => queued('history', true, input),
    // The video check is for the people who run the room; it names server details like free space.
    'room.check': ({ context, roomId, args }) =>
      inRoom(context, roomId, async (auth, room) => {
        if (!hub.authorize(auth.actor, room, 'roomSettings').ok)
          return result(403, { error: 'Only hosts can see the video check' });
        if (!room.media || room.media.kind !== 'plex')
          return result(200, { items: [], level: 'ok', title: room.media?.title });
        if (args.refresh) {
          if (!throttle('video-check:' + auth.actor.userId, 6))
            return result(429, { error: 'Wait a moment before checking again' });
          watch.mediaChecks.forget(room.media);
        }
        return result(200, await watch.mediaChecks.report(room.media));
      }),
    // A tab whose direct delivery failed asks for the other one. A per-viewer transport
    // failure never converts media or changes room playback.
    'room.delivery': ({ context, roomId, args }) =>
      inRoom(context, roomId, async (auth, room) => {
        const viewer = await ownViewer(room, auth, args.viewerId);
        if (!viewer) return result(403, { error: 'Playback viewer unavailable' });
        if (
          room.viewers.get(args.viewerId) !== viewer ||
          args.mediaVersion !== room.mediaVersion ||
          args.streamVersion !== viewer.streamVersion ||
          !viewer.directDelivery ||
          viewer.directDelivery !== viewer.media
        )
          return result(409, { error: 'Playback delivery changed' });
        // Fence pending readiness/observations from the old transport.
        watch.tracking.end(viewer, 'delivery-changed');
        void watch.reporting?.end(viewer, 'delivery-changed');
        viewer.directProxyVersion = room.mediaVersion;
        viewer.directDelivery = undefined;
        if (viewer.media?.directHls) {
          const previous = viewer.media;
          viewer.media = undefined;
          viewer.mediaVersion = undefined;
          void watch.plex.stop(previous);
        }
        viewer.streamVersion = randomUUID();
        viewer.ready = false;
        // The tab's stream is prepared again for the other delivery.
        void watch.prepareStream(room, auth.actor, args.viewerId);
        return result(200, { ok: true });
      }),
  };
  /**
   * `call`: one named request.
   * @param {Context} context
   * @param {string} op A key of `CALLS` (or `library.art`).
   * @param {{roomId?: string, args?: Record<string, any>}} [input]
   */
  function call(context, op, { roomId, args = {} } = {}) {
    const spec = op === 'library.art' ? {} : Object.hasOwn(CALLS, op) ? CALLS[op] : undefined;
    if (!spec) return Promise.resolve(result(404, { error: 'Unknown request' }));
    if (spec.write && Buffer.byteLength(JSON.stringify(args)) > 4096)
      return Promise.resolve(result(400, { error: 'Invalid command data' }));
    if (spec.room && !UUID.test(roomId || '')) return Promise.resolve(result(404, { error: 'Room unavailable' }));
    // The room's own calls sign in through inRoom.
    if (op === 'room.check' || op === 'room.delivery') return calls[op]({ context, roomId, args });
    return asked(context, !!spec.write, (auth, current) => {
      if (spec.room && foreignRoom(roomId)) return result(403, ONLY_SHARED);
      return calls[op]({ context, auth, current, roomId, args });
    });
  }
  return { call, join, leave, command, ready, observe, lanes, lobby };
}
module.exports = { watchOperations };
