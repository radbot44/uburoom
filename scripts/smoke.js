/* The browser smoke runners, one after another in Chrome and Firefox: the UI check before a deploy.
   Usage: npm run smoke [-- --browsers=chrome,firefox] [-- --sequential]
   A full pass on committed code is recorded in .git/uburoom-smoke-pass.json by its git tree, so a deploy of
   that same code can skip running them again. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

// Each runner owns a distinct boundary; together they cover rooms, the queue, Media controls and library browsing.
const RUNNERS = ['room-ui-smoke.js', 'queue-controls-smoke.js', 'media-controls-smoke.js', 'plex-library-smoke.js'];

const browsers = process.argv.find(arg => arg.startsWith('--browsers='));
// Two lanes: the room UI runner beside the other three in turn, each runner with its own fixture server,
// about 160 s instead of about 290 s (10 of 10 clean on 2026-11-16 once the runners waited for a settled
// page). --sequential runs one at a time with live output. All four at once overloads the machine.
const lanes = !process.argv.includes('--sequential');
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

// Side by side, a runner's output is held and printed whole when it ends, so runners do not interleave.
function run(script, live) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, script), ...(browsers ? [browsers] : [])], {
      stdio: ['ignore', live ? 'inherit' : 'pipe', live ? 'inherit' : 'pipe'],
      windowsHide: true,
    });
    const output = [];
    child.stdout?.on('data', chunk => output.push(chunk));
    child.stderr?.on('data', chunk => output.push(chunk));
    let finished = false;
    const done = code => {
      if (finished) return;
      finished = true;
      if (!live) process.stdout.write('\n== ' + script + '\n' + Buffer.concat(output).toString());
      resolve({ script, code, seconds: Math.round((Date.now() - started) / 1000) });
    };
    child.on('close', done);
    child.on('error', error => {
      output.push(Buffer.from(String(error) + '\n'));
      done(1);
    });
  });
}

(async () => {
  const tree = testedTree();
  const started = Date.now();
  let results = [];
  if (!lanes)
    for (const script of RUNNERS) {
      console.log('\n== ' + script);
      results.push(await run(script, true));
    }
  else {
    const [longest, ...rest] = RUNNERS;
    const lane = async scripts => {
      const out = [];
      for (const script of scripts) out.push(await run(script, false));
      return out;
    };
    results = (await Promise.all([lane([longest]), lane(rest)])).flat();
  }
  console.log('\nSmoke summary:');
  for (const { script, code, seconds } of results)
    console.log('  ' + (code === 0 ? 'pass' : 'FAIL') + '  ' + script + '  (' + seconds + ' s)');
  console.log('  total ' + Math.round((Date.now() - started) / 1000) + ' s');
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
