'use strict';
// Clock and drift-controller simulation bench (scripts/lib/sync-bench.mjs): determinism, a regression ratchet against
// today's measured numbers, and hard assertions for the owner-agreed targets that today's code already meets.
// Targets not yet met are data in TARGET_STATUS (`met: false`), not skips; S1-S3 flip them to hard assertions.
const test = require('node:test');
const assert = require('node:assert/strict');

test('sync bench is deterministic and no metric regresses past its recorded baseline', async () => {
  const bench = await import('../scripts/lib/sync-bench.mjs');
  const { BASELINE, TARGET_STATUS } = await import('../scripts/lib/sync-bench-baseline.mjs');
  const first = bench.runBench();
  assert.equal(JSON.stringify(bench.runBench()), JSON.stringify(first), 'same seed must give byte-identical results');
  assert.notEqual(JSON.stringify(bench.runBench({ seed: 7 })), JSON.stringify(first), 'the seed must matter');

  assert.deepEqual(Object.keys(BASELINE).sort(), first.rows.map(row => row.key).sort(), 'baseline covers every row');
  const targeted = first.rows.filter(row => row.target).map(row => row.key);
  assert.deepEqual(Object.keys(TARGET_STATUS).sort(), targeted.sort(), 'target status covers every targeted row');

  for (const row of first.rows) {
    const baseline = BASELINE[row.key];
    const limit = bench.ratchetLimit(row, baseline);
    const ok = row.better === 'lower' ? row.value <= limit : row.value >= limit;
    assert.ok(ok, `${row.key} regressed: ${row.value} ${row.unit} (baseline ${baseline}, limit ${limit})`);
    if (!row.target) continue;
    const { met } = TARGET_STATUS[row.key];
    assert.equal(
      bench.meetsTarget(row),
      met,
      met
        ? `${row.key} must meet ${row.target.id} (${row.target.text}); got ${row.value}`
        : `${row.key} now meets ${row.target.id}; set met: true in TARGET_STATUS`,
    );
  }
});
