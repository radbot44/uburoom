'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Accounts, credentialVault } = require('../server/accounts');
const { RoomStore } = require('../server/room-store');
const { RoomQueue } = require('../server/room-queue');

function setupBenchmark(itemCount = 50) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-bench-'));
  const file = path.join(directory, 'accounts.sqlite');
  const vault = credentialVault();
  const registry = new Accounts(file, vault);
  const store = new RoomStore(registry);
  const queue = new RoomQueue(registry, store);
  queue.maxPending = itemCount + 10;

  const creator = registry.resolve('discord', '111111111111111111', 'Creator').id;

  return { registry, store, queue, creator, directory };
}

const sampleItem = (n) => ({
  serverId: 'plex-server-1',
  mediaId: String(1000 + n),
  type: 'episode',
  title: `Episode ${n}`,
  parentTitle: 'Season 1',
  grandparentTitle: 'Show',
  duration: 1800
});

async function runBenchmark() {
  const itemCount = 50;
  const iterations = 1000;
  const { registry, store, queue, creator, directory } = setupBenchmark(itemCount);

  try {
    const room = await store.create(creator, { name: 'Benchmark Room' });
    const items = Array.from({ length: itemCount }, (_, i) => sampleItem(i + 1));
    await queue.addBulk(room.id, creator, items);

    // 1. Benchmark shuffle
    const pending = queue.pending(room.id);
    const shuffleStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await queue.shuffle(room.id, creator);
    }
    const shuffleEnd = performance.now();
    const shuffleTotalMs = shuffleEnd - shuffleStart;
    const shuffleAvgMs = shuffleTotalMs / iterations;

    // 2. Benchmark move
    const moveStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      const currentPending = queue.pending(room.id);
      const targetId = currentPending[0].id;
      const targetRank = (i % (itemCount - 1)) + 1;
      await queue.move(room.id, creator, targetId, targetRank);
    }
    const moveEnd = performance.now();
    const moveTotalMs = moveEnd - moveStart;
    const moveAvgMs = moveTotalMs / iterations;

    // 3. Benchmark remove (remove middle item, then re-add to maintain size)
    const removeStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      const currentPending = queue.pending(room.id);
      const targetId = currentPending[Math.floor(itemCount / 2)].id;
      await queue.remove(room.id, creator, targetId);
      await queue.add(room.id, creator, sampleItem(5000 + i));
    }
    const removeEnd = performance.now();
    const removeTotalMs = removeEnd - removeStart;
    const removeAvgMs = removeTotalMs / iterations;

    console.log(`--- BENCHMARK RESULTS (${itemCount} items, ${iterations} iterations) ---`);
    console.log(`Shuffle: Total = ${shuffleTotalMs.toFixed(2)}ms, Avg = ${shuffleAvgMs.toFixed(4)}ms/op, Ops/sec = ${(1000 / shuffleAvgMs).toFixed(2)}`);
    console.log(`Move:    Total = ${moveTotalMs.toFixed(2)}ms, Avg = ${moveAvgMs.toFixed(4)}ms/op, Ops/sec = ${(1000 / moveAvgMs).toFixed(2)}`);
    console.log(`Remove:  Total = ${removeTotalMs.toFixed(2)}ms, Avg = ${removeAvgMs.toFixed(4)}ms/op, Ops/sec = ${(1000 / removeAvgMs).toFixed(2)}`);

  } finally {
    await registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

runBenchmark().catch(console.error);
