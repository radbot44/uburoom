'use strict';
// Room scenario baseline: each scripted scenario runs against a real server on
// a controlled clock and must reproduce its recorded semantic trace exactly.
// After an intended room behaviour change, re-record with `npm run traces:record`
// and review the trace diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScenario } = require('./helpers/room-scenarios/harness');
const { scenarios } = require('./helpers/room-scenarios/scenarios');

const directory = path.join(__dirname, 'fixtures/room-traces');

for (const scenario of scenarios)
  test('room scenario: ' + scenario.name, async () => {
    const file = path.join(directory, scenario.name + '.json');
    assert.ok(fs.existsSync(file), `No recording for ${scenario.name}; run npm run traces:record -- ${scenario.name}`);
    const expected = JSON.parse(fs.readFileSync(file, 'utf8')).steps;
    const actual = (await runScenario(scenario)).steps;
    const hint = `If intended, re-record with npm run traces:record -- ${scenario.name} and review the diff.`;
    for (let i = 0; i < Math.max(actual.length, expected.length); i++)
      assert.deepEqual(
        actual[i],
        expected[i],
        `${scenario.name} step ${i + 1} (${(expected[i] || actual[i]).step}) differs from ${path.relative(path.join(__dirname, '..'), file)}. ${hint}`,
      );
  });
