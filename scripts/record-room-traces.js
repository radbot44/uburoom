'use strict';
// Deliberately re-records the room scenario traces in tests/fixtures/room-traces
// after an intended room behaviour change. Review the resulting diff before
// committing it. Each scenario runs --runs=N times (default 2) and is written
// only if every run produced the same trace.
//
//   npm run traces:record                      all scenarios
//   npm run traces:record -- kick --runs=10    one scenario, ten runs
//   npm run traces:record -- --check --runs=10 compare with the recordings, write nothing
const fs = require('node:fs');
const path = require('node:path');
const { runScenario } = require('../tests/helpers/room-scenarios/harness');
const { scenarios } = require('../tests/helpers/room-scenarios/scenarios');

const directory = path.join(__dirname, '../tests/fixtures/room-traces');
const args = process.argv.slice(2);
const runs = Number(args.find(arg => arg.startsWith('--runs='))?.slice(7) || 2);
const check = args.includes('--check');
const names = args.filter(arg => !arg.startsWith('--'));

async function main() {
  const unknown = names.filter(name => !scenarios.some(scenario => scenario.name === name));
  if (unknown.length) throw new Error('Unknown scenario: ' + unknown.join(', '));
  if (!Number.isInteger(runs) || runs < 1) throw new Error('Use --runs=N with N >= 1');
  let failed = false;
  for (const scenario of scenarios.filter(scenario => !names.length || names.includes(scenario.name))) {
    const file = path.join(directory, scenario.name + '.json');
    const recorded = check && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    let first;
    const times = [];
    for (let run = 1; run <= runs; run++) {
      const started = performance.now();
      const text = JSON.stringify(await runScenario(scenario), null, 2) + '\n';
      times.push(Math.round(performance.now() - started));
      first ??= text;
      if (text !== first) {
        console.error(`${scenario.name}: run ${run} differs from run 1; nothing written`);
        failed = true;
        break;
      }
      if (check && text !== recorded) {
        console.error(`${scenario.name}: run ${run} differs from the recording`);
        failed = true;
        break;
      }
    }
    if (failed) continue;
    const steps = JSON.parse(first).steps.length;
    if (!check) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, first);
    }
    console.log(`${scenario.name}: ${steps} steps, ${runs} identical run(s), ${times.join('/')} ms`);
  }
  if (failed) process.exitCode = 1;
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
