'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Startup-only discovery. Resolve an absolute executable so subprocesses do not
// depend on their working directory, shell aliases, or later PATH changes.
function findOnPath(name, environment = process.env, platform = process.platform) {
  const pathKey = Object.keys(environment).find(key => platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH');
  const executable = platform === 'win32' ? name + '.exe' : name;
  for (let directory of (environment[pathKey] || '').split(platform === 'win32' ? ';' : ':')) {
    directory = directory.trim().replace(/^"(.*)"$/, '$1');
    // Empty/relative entries can resolve tools from a caller's working folder.
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executable);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch { /* Continue to the next PATH directory; missing tools stay optional. */ }
  }
}

module.exports = { findOnPath };
