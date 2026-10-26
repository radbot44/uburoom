'use strict';

const { Accounts, credentialVault } = require('../server/accounts');
const { RoomStore } = require('../server/room-store');
const { WatchRooms } = require('../server/watch-rooms');

async function runBenchmark(numRooms = 100) {
  const registry = new Accounts(undefined, credentialVault());
  const limits = { maxSaved: 1000, maxOpen: 1000, maxMembers: 20 };
  const store = new RoomStore(registry, { limits, isAdmin: () => false });

  const creator = registry.resolve('discord', '100000000000000001', 'Leader');
  const subject = '100000000000000002';

  const roomIds = [];

  for (let i = 0; i < numRooms; i++) {
    const room = await store.create(creator.id, { keepEmpty: true, name: `Room ${i}` });
    await store.edit(room.id, creator.id, room.revision, {
      action: 'host.pending.add',
      provider: 'discord',
      subject,
      name: 'Host'
    });
    roomIds.push(room.id);
  }

  const hostUser = registry.resolve('discord', subject, 'Host');

  const mockRooms = new Map();
  for (const id of roomIds) {
    mockRooms.set(id, { s: {}, revision: 0 });
  }

  const mockWatch = {
    rooms: mockRooms,
    hub: {
      config: { roomPermissions: {} },
      isAdmin: () => false,
    }
  };

  const watchRooms = Object.create(WatchRooms.prototype);
  watchRooms.watch = mockWatch;
  watchRooms.store = store;

  let prepareCount = 0;
  const originalPrepare = store.db.prepare.bind(store.db);
  store.db.prepare = function(sql) {
    prepareCount++;
    return originalPrepare(sql);
  };

  prepareCount = 0;
  const startTime = process.hrtime.bigint();

  await watchRooms.claimHosts(hostUser.id);

  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1e6;

  console.log(`Baseline Benchmark (${numRooms} claimed rooms):`);
  console.log(`  Total Duration: ${durationMs.toFixed(3)} ms`);
  console.log(`  Total DB Prepare Calls: ${prepareCount}`);

  registry.close();
}

runBenchmark(100).catch(console.error);
