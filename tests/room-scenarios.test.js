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
    const run = await runScenario({
        ...scenario,
        async run(s) {
          await scenario.run(s);
          if (scenario.name !== 'server-wall-clock-step') return;
          const alice = s.viewers.find(viewer => viewer.label === 'alice');
          const watch = s.server.app.watch;
          const room = watch.rooms.get(alice.roomId);
          const viewer = room.viewers.get(alice.viewerId);
          let sequence = 0;
          for (const wallStep of [0, 30000, -40000]) {
            s.clock.stepWall(wallStep);
            const observed = await alice.request('observe after wall step', transport =>
              transport.observe(alice.roomId, alice.viewerId, {
                epoch: room.epoch,
                mediaVersion: room.mediaVersion,
                streamVersion: viewer.streamVersion,
                observationEpoch: viewer.observationEpoch,
                sequence: ++sequence,
                sampleAt: performance.now(),
                observedAt: watch.clock.now(),
                position: watch.position(room),
                state: 'playing',
                frames: sequence * 30,
                rate: 1,
                discontinuity: 0,
              }),
            );
            assert.equal(observed.ok, true, JSON.stringify(observed));
            assert.equal(observed.value.watchedSeconds, sequence - 1);
            await s.advance(1000);
          }
        },
      }),
      actual = run.steps;
    if (scenario.plexSessions) {
      // A stale completion must stop what it prepared: once the server closes, nothing is open.
      const { started, stopped, open } = run.plexSessions;
      assert.ok(started > 0, `${scenario.name} prepared no Plex stream`);
      assert.equal(
        open.size,
        0,
        `${scenario.name} left ${open.size} of ${started} Plex streams open (${stopped} stopped)`,
      );
    }
    const hint = `If intended, re-record with npm run traces:record -- ${scenario.name} and review the diff.`;
    for (let i = 0; i < Math.max(actual.length, expected.length); i++)
      assert.deepEqual(
        actual[i],
        expected[i],
        `${scenario.name} step ${i + 1} (${(expected[i] || actual[i]).step}) differs from ${path.relative(path.join(__dirname, '..'), file)}. ${hint}`,
      );
  });
