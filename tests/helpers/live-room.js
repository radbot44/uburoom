'use strict';
const { Accounts, credentialVault } = require('../../server/accounts');
const { Watch, roomPorts } = require('../../server/watch');

// Gives a hub built on its own the room hooks a Watch supplies (a hub made by createRooms has them already).
function wireRooms(hub, plex, watch) {
  // A hub built on its own has no personal Plex scopes (a provider that cannot answer allows what the room holds)
  // and does not re-check room visibility before each command.
  const { watchCanView, ...ports } = roomPorts(() => watch);
  plex.allows ??= async () => true;
  const standalone = hub.plexFor.name === 'unconfiguredPlex';
  Object.assign(hub, standalone ? { plexFor: async () => plex } : {}, ports);
  return watch;
}

// A Watch on an in-memory registry. Rooms are durable, as in production.
function liveWatch(hub, plex, demoMedia) {
  const registry = new Accounts(undefined, credentialVault());
  const watch = wireRooms(hub, plex, new Watch(hub, plex, demoMedia, registry));
  clearInterval(watch.roomState.timer);
  return {
    watch,
    registry,
    actor: name => ({ userId: registry.create(name), name }),
    open: async (actor, options) => watch.rooms.get(await watch.roomState.create(actor, options)),
  };
}

module.exports = { liveWatch, wireRooms };
