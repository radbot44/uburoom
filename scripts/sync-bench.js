'use strict';
// Prints the clock and drift-controller simulation bench. Simulation only; see docs/sync-core.md.
// `--emit-baseline` prints the contents of scripts/lib/sync-bench-baseline.mjs instead (pipe it to the file, then run
// prettier); do that only after an intentional behaviour change. `--seed=N` picks another seed.
(async () => {
  const bench = await import('./lib/sync-bench.mjs');
  const argument = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  const seed = argument('seed') ? Number(argument('seed')) : bench.DEFAULT_SEED;
  const { rows } = bench.runBench({ seed });
  if (process.argv.includes('--emit-baseline')) {
    console.log(bench.formatBaseline(rows));
    return;
  }
  console.log(`sync bench, seed ${seed} (real shared/sync/timing.mjs; simulated network and player)\n`);
  console.log(bench.formatTable(rows));
  const targeted = rows.filter(row => row.target);
  const met = targeted.filter(row => bench.meetsTarget(row));
  console.log(`\n${met.length} of ${targeted.length} targeted rows meet their target today.`);
})();
