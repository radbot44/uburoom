'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function readBuildIdentity(appRoot = path.resolve(__dirname, '..')) {
  const { version } = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const unknown = { version, buildLabel: `v${version}` };
  const identity = (commit, dirty) => ({
    version,
    commit,
    buildLabel: `v${version} (g${commit.slice(0, 7)}${dirty ? '-dirty' : ''})`,
  });

  // A checkout (including a worktree) must never borrow a previous bundle's provenance.
  if (fs.existsSync(path.join(appRoot, '.git'))) {
    const git = (...args) =>
      execFileSync('git', ['-C', appRoot, ...args], {
        timeout: 1500,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    try {
      const normalize = p => {
        const real = fs.realpathSync.native(p);
        return process.platform === 'win32' ? real.toLowerCase() : real;
      };
      if (normalize(git('rev-parse', '--show-toplevel')) !== normalize(appRoot)) return unknown;
      const commit = git('rev-parse', '--verify', 'HEAD');
      if (commitPattern.test(commit)) return identity(commit, git('status', '--porcelain').length > 0);
    } catch {}
    return unknown;
  }

  // The portable packager writes BUILD_INFO beside app/ in its slot. Other archive layouts
  // can place it in the app root, but never inherit an unrelated manifest from a parent.
  const slotDir = path.dirname(appRoot);
  const inPortableSlot = path.basename(appRoot) === 'app' && path.basename(path.dirname(slotDir)) === 'versions';
  const file = path.join(inPortableSlot ? slotDir : appRoot, 'BUILD_INFO.json');
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    const build = info?.uburoom;
    if (
      build?.version === version &&
      typeof build.commit === 'string' &&
      commitPattern.test(build.commit) &&
      build.shortCommit === build.commit.slice(0, 7) &&
      typeof build.dirty === 'boolean' &&
      (!inPortableSlot || build.slot === path.basename(slotDir))
    ) {
      return identity(build.commit, build.dirty);
    }
  } catch {}
  return unknown;
}

module.exports = { readBuildIdentity };
