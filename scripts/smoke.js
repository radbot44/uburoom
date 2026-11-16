/* The browser smoke runners, one after another in Chrome and Firefox: the UI check before a deploy.
   Usage: npm run smoke [-- --browsers=chrome,firefox]
   A full pass on committed code is recorded in .git/uburoom-smoke-pass.json by its git tree, so a deploy of
   that same code can skip running them again. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

// Each runner owns a distinct boundary; together they cover rooms, the queue, Media controls and library browsing.
const RUNNERS = ['room-ui-smoke.js', 'queue-controls-smoke.js', 'media-controls-smoke.js', 'plex-library-smoke.js'];

const browsers = process.argv.find(arg => arg.startsWith('--browsers='));
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

// The code a pass vouches for: HEAD's tree, but only when nothing the app or runners use differs from it.
function testedTree() {
  try {
    if (browsers && !['chrome', 'firefox'].every(name => browsers.slice(11).split(',').includes(name))) return null;
    const changed = git(
      'status',
      '--porcelain',
      '--',
      'web',
      'server',
      'shared',
      'scripts',
      'assets',
      'package.json',
      'package-lock.json',
    );
    return changed ? null : git('rev-parse', 'HEAD^{tree}');
  } catch {
    return null;
  }
}

function run(script) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, script), ...(browsers ? [browsers] : [])], {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.on('exit', code => resolve({ script, code, seconds: Math.round((Date.now() - started) / 1000) }));
    child.on('error', error => {
      console.error(error);
      resolve({ script, code: 1, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

(async () => {
  const tree = testedTree();
  const results = [];
  for (const script of RUNNERS) {
    console.log('\n== ' + script);
    results.push(await run(script));
  }
  console.log('\nSmoke summary:');
  for (const { script, code, seconds } of results)
    console.log('  ' + (code === 0 ? 'pass' : 'FAIL') + '  ' + script + '  (' + seconds + ' s)');
  const passed = results.every(result => result.code === 0);
  process.exitCode = passed ? 0 : 1;
  // Checked again after the run: an edit made while it ran means the pass is not for this tree.
  if (passed && tree && testedTree() === tree) {
    const record = path.join(root, git('rev-parse', '--git-dir'), 'uburoom-smoke-pass.json');
    const pass = { tree, head: git('rev-parse', 'HEAD'), at: new Date().toISOString() };
    fs.writeFileSync(record, JSON.stringify(pass) + '\n');
    console.log('Recorded the pass for tree ' + tree.slice(0, 12) + '; a deploy of this code skips the smoke.');
  } else if (passed) console.log('Not recorded: uncommitted app changes or not both browsers.');
})();
