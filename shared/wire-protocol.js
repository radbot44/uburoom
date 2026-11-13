/* The room connection's messages: what a client may send, what the server sends back,
 * and the checks both sides run on them. One typed message per kind of work; nothing
 * here knows about HTTP paths. Loaded by the server (CommonJS), the browser (classic
 * script) and the test harnesses; other clients mirror it (see docs/wire-protocol.md).
 */
(function (root) {
  'use strict';
  // Raised whenever a message changes shape. A client states the version it speaks
  // in `hello`; the server refuses any other with a `protocol` error.
  const PROTOCOL_VERSION = 2;
  // How often the server sends every lane again, whether or not it changed.
  const RESYNC_MS = 20000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const TOKEN = /^[a-f0-9]{64}$/;

  /** What a client may send. */
  const CLIENT_TYPES = Object.freeze([
    'hello',
    'join',
    'leave',
    'command',
    'ready',
    'observe',
    'clock',
    'quality',
    'call',
    'cancel',
    'resync',
  ]);
  /** What the server sends. */
  const SERVER_TYPES = Object.freeze(['welcome', 'room', 'viewer', 'lobby', 'ack', 'error', 'clock']);

  /**
   * Named requests that are neither a room command nor room state: reads, and the
   * management changes around rooms. `room` marks those addressed to one room; `write`
   * those that change something; `http` those also served by GET before a connection exists.
   */
  const CALLS = Object.freeze({
    me: { http: '/api/watch/me' },
    'profile.rename': { write: true },
    'admin.mode': { write: true },
    'library.browse': { http: '/api/watch/library' },
    'library.item': { http: '/api/watch/library/item' },
    'library.availability': { http: '/api/watch/library/availability' },
    'library.filters': { http: '/api/watch/library/filters' },
    'playback.history': { http: '/api/watch/playback' },
    'rooms.list': {},
    'rooms.saved': {},
    'rooms.create': { write: true },
    'events.list': {},
    'events.schedule': { write: true },
    'room.reopen': { room: true, write: true },
    'room.close': { room: true, write: true },
    'room.people': { room: true },
    'room.settings': { room: true },
    'room.settings.edit': { room: true, write: true },
    'room.events': { room: true },
    'room.events.command': { room: true, write: true },
    'room.share': { room: true },
    'room.share.command': { room: true, write: true },
    'room.queue': { room: true },
    'room.queue.command': { room: true, write: true },
    'room.history': { room: true },
    'room.history.command': { room: true, write: true },
    'room.check': { room: true },
    'room.delivery': { room: true, write: true },
  });

  /** What a tab may say about itself when it joins. Every key is optional. */
  const JOIN_PREFERENCES = Object.freeze({
    quality: 'string',
    delivery: 'string',
    subtitles: 'string',
    codecs: 'string',
    volume: 'number',
    muted: 'boolean',
    plexReporting: 'boolean',
    plexWatchState: 'boolean',
    subtitlePreference: 'string',
    subtitleMode: 'string',
    audioPreference: 'string',
  });

  /**
   * The fields of a tab's room view that belong to that tab alone: its stream, its
   * tracks and its own settings. They travel in the `viewer` lane; everything else is
   * the `room` lane. `volume` and `muted` sit inside the view's `state` object.
   */
  const VIEWER_KEYS = Object.freeze([
    'observationEpoch',
    'format',
    'quality',
    'videoCodec',
    'compatible',
    'streamVersion',
    'audioCodec',
    'bitrate',
    'bitrateCeiling',
    'hdr',
    'hdrKind',
    'hdrLabel',
    'doviProfile',
    'bitDepth',
    'mediaError',
    'unavailableMedia',
    'qualityNotice',
    'preferredQuality',
    'deliveryInfo',
    'tracks',
    'plexReporting',
    'fallbackStream',
    'preparingQuality',
    'mediaUrl',
    'directHls',
    'directDelivery',
    'subtitleUrl',
  ]);
  const VIEWER_STATE_KEYS = Object.freeze(['volume', 'muted']);

  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const id = value => Number.isSafeInteger(value) && value >= 0;
  const uuid = value => typeof value === 'string' && UUID.test(value);

  /**
   * Splits one tab's room view into its two lanes.
   * @param {Record<string, any>} view
   * @returns {{room: Record<string, any>, viewer: Record<string, any>}}
   */
  function splitView(view) {
    const room = { ...view },
      viewer = {};
    for (const key of VIEWER_KEYS)
      if (key in room) {
        viewer[key] = room[key];
        delete room[key];
      }
    // A tab's stream belongs to one video: the viewer lane says which, so a client
    // never pairs a new video with the stream of the one before it.
    viewer.mediaVersion = room.mediaVersion;
    if (object(room.state)) {
      room.state = { ...room.state };
      for (const key of VIEWER_STATE_KEYS)
        if (key in room.state) {
          viewer[key] = room.state[key];
          delete room.state[key];
        }
    }
    return { room, viewer };
  }
  /** Whether two lanes describe the same video, so they can be shown together. */
  const lanesAgree = (room, viewer) => !!room && !!viewer && room.mediaVersion === viewer.mediaVersion;
  /**
   * Puts a tab's two lanes back together into the one view its player reads.
   * @param {Record<string, any>} room
   * @param {Record<string, any>} [viewer]
   */
  function mergeView(room, viewer = {}) {
    const { volume, muted, ...own } = viewer;
    return { ...room, ...own, state: { ...room.state, volume, muted } };
  }

  /**
   * Checks a client message. Returns undefined when it is well formed, otherwise why not.
   * It checks shape only: who may do what is decided by the server's handlers.
   * @param {any} message
   * @returns {string | undefined}
   */
  function clientMessageError(message) {
    if (!object(message) || !CLIENT_TYPES.includes(message.type)) return 'Unknown message';
    const m = message;
    switch (m.type) {
      case 'hello':
        if (!Number.isSafeInteger(m.protocol)) return 'hello needs a protocol version';
        if (m.token !== undefined && !(typeof m.token === 'string' && TOKEN.test(m.token)))
          return 'hello carries an invalid token';
        if (m.csrf !== undefined && typeof m.csrf !== 'string') return 'hello carries an invalid proof';
        return;
      case 'clock':
      case 'cancel':
      case 'resync':
        return id(m.id) ? undefined : m.type + ' needs an id';
      case 'quality':
        return uuid(m.roomId) && uuid(m.viewerId) ? undefined : 'quality needs a room and viewer';
      case 'call': {
        if (!id(m.id)) return 'call needs an id';
        const call = typeof m.op === 'string' && Object.hasOwn(CALLS, m.op) ? CALLS[m.op] : undefined;
        if (!call) return 'Unknown call';
        if (call.room ? !uuid(m.roomId) : m.roomId !== undefined) return 'call names the wrong room';
        if (m.args !== undefined && !object(m.args)) return 'call arguments must be an object';
        if (m.timeoutMs !== undefined && !Number.isFinite(m.timeoutMs)) return 'call carries an invalid time limit';
        return;
      }
    }
    if (!id(m.id)) return m.type + ' needs an id';
    if (!uuid(m.roomId)) return m.type + ' needs a room';
    switch (m.type) {
      case 'join':
        if (!uuid(m.viewerId)) return 'join needs a viewer';
        if (m.preferences === undefined) return;
        if (!object(m.preferences)) return 'join preferences must be an object';
        for (const [key, value] of Object.entries(m.preferences))
          if (JOIN_PREFERENCES[key] === undefined || typeof value !== JOIN_PREFERENCES[key])
            return 'join carries an invalid preference';
        return;
      case 'leave':
      case 'ready':
        return uuid(m.viewerId) ? undefined : m.type + ' needs a viewer';
      case 'observe':
        if (!uuid(m.viewerId)) return 'observe needs a viewer';
        return object(m.observation) ? undefined : 'observe needs an observation';
      case 'command':
        if (m.viewerId !== undefined && !uuid(m.viewerId)) return 'command names an invalid viewer';
        return object(m.command) && typeof m.command.action === 'string' ? undefined : 'command needs an action';
    }
  }

  /**
   * Checks a server message, for clients and tests.
   * @param {any} message
   * @returns {string | undefined}
   */
  function serverMessageError(message) {
    if (!object(message) || !SERVER_TYPES.includes(message.type)) return 'Unknown message';
    const m = message;
    switch (m.type) {
      case 'welcome':
        return Number.isSafeInteger(m.protocol) && Number.isSafeInteger(m.connectionId)
          ? undefined
          : 'welcome is incomplete';
      case 'room':
      case 'viewer':
        return uuid(m.roomId) && uuid(m.viewerId) && Number.isSafeInteger(m.version) && object(m.state)
          ? undefined
          : m.type + ' is incomplete';
      case 'lobby':
        return Number.isSafeInteger(m.version) && Array.isArray(m.rooms) && object(m.identity)
          ? undefined
          : 'lobby is incomplete';
      case 'ack':
      case 'clock':
        return id(m.id) ? undefined : m.type + ' needs an id';
      case 'error':
        return typeof m.code === 'string' && typeof m.message === 'string' && (m.id === undefined || id(m.id))
          ? undefined
          : 'error is incomplete';
    }
  }

  const api = {
    PROTOCOL_VERSION,
    RESYNC_MS,
    CLIENT_TYPES,
    SERVER_TYPES,
    CALLS,
    JOIN_PREFERENCES,
    VIEWER_KEYS,
    splitView,
    mergeView,
    lanesAgree,
    clientMessageError,
    serverMessageError,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomWire = api;
})(globalThis);
