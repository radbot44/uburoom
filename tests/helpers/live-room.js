'use strict';
const { Accounts, credentialVault } = require('../../server/accounts');
const { Watch } = require('../../server/watch');

// A Watch on an in-memory registry. Rooms are durable, as in production.
function liveWatch(hub, plex, demoMedia) {
  const registry = new Accounts(undefined, credentialVault());
  const watch = new Watch(hub, plex, demoMedia, registry);
  clearInterval(watch.roomState.timer);
  return {
    watch,
    registry,
    actor: name => ({ userId: registry.create(name), name }),
    open: async (actor, options) => watch.rooms.get(await watch.roomState.create(actor, options)),
  };
}

module.exports = { liveWatch };
