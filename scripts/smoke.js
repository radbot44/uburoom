/* The browser smoke runners, one after another in Chrome and Firefox: the UI check before a deploy.
   Usage: npm run smoke [-- --browsers=chrome,firefox] */
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

// Each runner owns a distinct boundary; together they cover rooms, the queue, Media controls and library browsing.
const RUNNERS = ['room-ui-smoke.js', 'queue-controls-smoke.js', 'media-controls-smoke.js', 'plex-library-smoke.js'];

const browsers = process.argv.find(arg => arg.startsWith('--browsers='));

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
  const results = [];
  for (const script of RUNNERS) {
    console.log('\n== ' + script);
    results.push(await run(script));
  }
  console.log('\nSmoke summary:');
  for (const { script, code, seconds } of results)
    console.log('  ' + (code === 0 ? 'pass' : 'FAIL') + '  ' + script + '  (' + seconds + ' s)');
  process.exitCode = results.every(result => result.code === 0) ? 0 : 1;
})();
