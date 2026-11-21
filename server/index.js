'use strict';
// uburoom's entry point: setup mode when the config file is missing, otherwise the server (server/start.js).
require('./start')
  .run()
  .catch(error => {
    const missing = error.code === 'ENOENT';
    const msg = missing
      ? 'Missing TLS files. Follow README.md to generate a local development certificate.'
      : error.message;
    process.stderr.write(`[uburoom] ${msg}\n`);
    process.exitCode = 1;
  });
