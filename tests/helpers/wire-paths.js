'use strict';
// Test fixtures name their requests by resource path (`/api/watch/rooms/<id>/queue`),
// as the suites were written. This turns such a request into the room connection's
// typed messages (shared/wire-protocol.mjs) and its answer back into `{status, body}`.
// Only tests use it: the product has no path-shaped requests.
const { mergeView, PROTOCOL_VERSION } = require('../../shared/wire-protocol.mjs');

const ROOM = /^\/api\/watch\/rooms\/([^/]+)(?:\/([a-z]+))?$/;
const GLOBAL = {
  '/api/watch/me': ['me'],
  '/api/watch/playback': ['playback.history'],
  '/api/watch/library': ['library.browse'],
  '/api/watch/library/item': ['library.item'],
  '/api/watch/library/availability': ['library.availability'],
  '/api/watch/library/filters': ['library.filters'],
  '/api/watch/rooms': ['rooms.list', 'rooms.create'],
  '/api/watch/rooms/saved': ['rooms.saved'],
  '/api/watch/events': ['events.list', 'events.schedule'],
  '/api/watch/profile': [undefined, 'profile.rename'],
  '/api/watch/admin-mode': [undefined, 'admin.mode'],
};
const ROOM_CALLS = {
  reopen: [undefined, 'room.reopen'],
  close: [undefined, 'room.close'],
  people: ['room.people'],
  settings: ['room.settings', 'room.settings.edit'],
  events: ['room.events', 'room.events.command'],
  share: ['room.share', 'room.share.command'],
  queue: ['room.queue', 'room.queue.command'],
  history: ['room.history', 'room.history.command'],
  check: ['room.check'],
  delivery: [undefined, 'room.delivery'],
};
const BOOLEAN_PREFERENCES = ['muted', 'plexReporting', 'plexWatchState'];

/** A room read's query as the `join` it is: the viewer and what the tab says about itself. */
function joinMessage(roomId, query) {
  const { viewer, ...preferences } = query;
  if (preferences.volume !== undefined) preferences.volume = Number(preferences.volume);
  for (const key of BOOLEAN_PREFERENCES)
    if (['true', 'false'].includes(preferences[key])) preferences[key] = preferences[key] === 'true';
  return { type: 'join', roomId, viewerId: viewer, preferences };
}
/** The joined tab's view, as the old room read returned it. */
const joinedState = value => ({ ...mergeView(value.room.state, value.viewer.state), timing: value.timing });

/**
 * The messages for one path-shaped request, in order, and how to read the last answer.
 * Returns undefined for a path the room connection has no message for.
 * @param {string} path
 * @param {any} [data]
 * @returns {{messages: any[], body?: (values: any[]) => any, status?: number} | undefined}
 */
function translate(path, data) {
  const url = new URL(path, 'https://room.invalid'),
    query = Object.fromEntries(url.searchParams),
    write = data !== undefined;
  const global = GLOBAL[url.pathname]?.[write ? 1 : 0];
  if (global)
    return {
      messages: [{ type: 'call', op: global, args: write ? data : query }],
      status: global === 'rooms.create' ? 201 : 200,
    };
  const match = ROOM.exec(url.pathname);
  if (!match) return;
  const [, roomId, part] = match;
  if (!part)
    return write ? undefined : { messages: [joinMessage(roomId, query)], body: ([value]) => joinedState(value) };
  if (!write && part === 'check') query.refresh = query.refresh === '1';
  if (write && part === 'command') return { messages: [{ type: 'command', roomId, ...data }] };
  if (write && part === 'leave') return { messages: [{ type: 'leave', roomId, viewerId: data.viewerId }] };
  if (write && part === 'ready') return { messages: [{ type: 'ready', roomId, ...data }] };
  if (write && part === 'observe') {
    const { viewerId, ...observation } = data;
    return { messages: [{ type: 'observe', roomId, viewerId, observation }] };
  }
  const op = ROOM_CALLS[part]?.[write ? 1 : 0];
  if (!op) return;
  // Reopening with a viewer also joined it: the reopen, then the join.
  if (op === 'room.reopen' && data.viewerId !== undefined) {
    const { viewerId, ...preferences } = data;
    return {
      messages: [
        { type: 'call', op, roomId },
        { type: 'join', roomId, viewerId, preferences },
      ],
      body: ([opened, joined]) => ({ id: opened.id, state: joinedState(joined) }),
    };
  }
  return { messages: [{ type: 'call', op, roomId, args: write ? data : query }] };
}

/**
 * Sends a path-shaped request through `send(message) -> Promise<answer>`, where an
 * answer is the server's `ack` or `error` for that message.
 * @returns {Promise<{status: number, body: any}>}
 */
async function requestByPath(send, path, data) {
  const plan = translate(path, data);
  if (!plan) return { status: 404, body: { error: 'No room message for ' + path.split('?')[0] } };
  const values = [];
  for (const message of plan.messages) {
    const answer = await send(message);
    if (answer.type === 'error')
      return {
        status: answer.status,
        body: {
          error: answer.message,
          ...(answer.rejoin ? { rejoin: true } : {}),
          ...(answer.rejection ? { rejection: answer.rejection } : {}),
        },
      };
    values.push(answer.value);
  }
  return { status: plan.status || 200, body: plan.body ? plan.body(values) : values.at(-1) };
}
const hello = identity => ({ type: 'hello', protocol: PROTOCOL_VERSION, ...identity });

module.exports = { translate, requestByPath, joinedState, hello };
