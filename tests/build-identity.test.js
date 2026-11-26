'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readBuildIdentity } = require('../server/build-identity');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-build-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const version = '0.6.0';
const plain = { version, buildLabel: `v${version}` };

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
}

test('build identity follows a checkout and marks changed files despite a stale local manifest', t => {
  const app = tempRoot(t);
  const git = (...args) => execFileSync('git', ['-C', app, ...args], { encoding: 'utf8' }).trim();
  const manifest = path.join(app, 'BUILD_INFO.json');
  writeJson(path.join(app, 'package.json'), { version });
  writeJson(manifest, {
    uburoom: { version: '0.5.3', commit: 'a'.repeat(40), shortCommit: 'aaaaaaa', dirty: false },
  });
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  const commit = git('rev-parse', 'HEAD');
  const baseLabel = `v${version} (g${commit.slice(0, 7)}`;
  assert.deepEqual(readBuildIdentity(app), { version, commit, buildLabel: baseLabel + ')' });
  fs.appendFileSync(manifest, '\n');
  assert.deepEqual(readBuildIdentity(app), { version, commit, buildLabel: baseLabel + '-dirty)' });
});

test('portable identity requires matching package, slot and commit metadata', t => {
  const root = tempRoot(t);
  const slot = `${version}-gbbbbbbb`;
  const slotDir = path.join(root, 'versions', slot);
  const app = path.join(slotDir, 'app');
  fs.mkdirSync(app, { recursive: true });
  writeJson(path.join(app, 'package.json'), { version });
  const file = path.join(slotDir, 'BUILD_INFO.json');
  const build = { version, commit: 'b'.repeat(40), shortCommit: 'bbbbbbb', dirty: true, slot };
  writeJson(file, { uburoom: build });
  assert.deepEqual(readBuildIdentity(app), {
    version,
    commit: build.commit,
    buildLabel: `v${version} (gbbbbbbb-dirty)`,
  });
  writeJson(file, { uburoom: { ...build, version: '0.5.3' } });
  assert.deepEqual(readBuildIdentity(app), plain);
  writeJson(file, { uburoom: { ...build, shortCommit: 'aaaaaaa' } });
  assert.deepEqual(readBuildIdentity(app), plain);
  writeJson(file, { uburoom: { ...build, slot: 'somewhere-else' } });
  assert.deepEqual(readBuildIdentity(app), plain);

  // A neighboring bundle is not provenance for a source export without its own manifest.
  const exportDir = path.join(slotDir, 'export');
  fs.mkdirSync(exportDir);
  writeJson(path.join(exportDir, 'package.json'), { version });
  writeJson(file, { uburoom: build });
  assert.deepEqual(readBuildIdentity(exportDir), plain);
});
